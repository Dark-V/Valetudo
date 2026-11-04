import React from "react";
import {Alert, Box, Button, MenuItem, Stack, TextField, Typography} from "@mui/material";
import {Link} from "react-router-dom";
import axios from "axios";
import {useQuery} from "@tanstack/react-query";
import {RawMapData, RawMapEntityType, valetudoAPI} from "../../api";
import PaperContainer from "../../components/PaperContainer";
import {brushRuns, Cell, Door, Edit, extendBrush, latestDoors, layerPaths, manualDoorColor, maxCells,
    mergedRuns, paintColor, rectRuns, Run, runPath, Snapshot} from "./geometry";

const endpoint = "/robot/state/map/editor";
type Tool = "pan" | "brush" | "rectangle" | "door" | "moveDoor";
type View = {x: number; y: number; w: number; h: number};
type Gesture = {id: number; tool: Tool; start: Cell; last: Cell; cells: Set<number>};
type EditorData = {map: RawMapData; state: Snapshot};

async function load(): Promise<EditorData> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const [map, state] = await Promise.all([
            valetudoAPI.get<RawMapData>("/robot/state/map"), valetudoAPI.get<Snapshot>(endpoint)
        ]);
        const tag = map.data.metaData.mapEditor;
        if (tag && tag.floorId === state.data.floorId && tag.revision === state.data.revision) {
            return {map: map.data, state: state.data};
        }
    }
    throw new Error("The floor or map changed while loading. Wait for a localized map, then reload.");
}

function errorMessage(err: unknown) {
    if (axios.isAxiosError(err)) {
        if (err.response?.status === 409 && err.config?.method === "put") {
            return "This map changed. Your draft is still on screen. Reload the floor before applying a new draft.";
        }
        const data = err.response?.data;
        if (typeof data === "string" && data.length < 400) {
            return data;
        } else if (typeof data?.message === "string") {
            return data.message;
        }
    }
    return err instanceof Error ? err.message : "Unable to reach the map editor.";
}

function fitView(map: RawMapData): View {
    const layers = map.layers.filter(l => l.dimensions.pixelCount > 0);
    const points = map.entities.filter(e => e.type === RawMapEntityType.Door && e.metaData.source === "user")
        .flatMap(e => [{x: e.points[0]/map.pixelSize, y: e.points[1]/map.pixelSize},
            {x: e.points[2]/map.pixelSize, y: e.points[3]/map.pixelSize}]);
    const x = Math.min(...layers.map(l => l.dimensions.x.min), ...points.map(p => p.x));
    const y = Math.min(...layers.map(l => l.dimensions.y.min), ...points.map(p => p.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return {x: 0, y: 0, w: map.size.x/map.pixelSize, h: map.size.y/map.pixelSize};
    }
    return {x: x-5, y: y-5, w: Math.max(...layers.map(l => l.dimensions.x.max), ...points.map(p => p.x))-x+11,
        h: Math.max(...layers.map(l => l.dimensions.y.max), ...points.map(p => p.y))-y+11};
}

function Editor({data: {map, state}, reload, refreshing}: {data: EditorData; reload: () => void; refreshing: boolean}) {
    const [tool, setTool] = React.useState<Tool>("pan");
    const [paint, setPaint] = React.useState("floor");
    const [brushSize, setBrushSize] = React.useState(1);
    const [picked, setPicked] = React.useState("");
    const [doorState, setDoorState] = React.useState<Door["state"]>("unknown");
    const [edits, setEdits] = React.useState<Edit[]>([]);
    const [future, setFuture] = React.useState<Edit[]>([]);
    const [view, setView] = React.useState(() => fitView(map));
    const gesture = React.useRef<Gesture | null>(null);
    const [preview, setPreview] = React.useState<Run[]>([]);
    const [line, setLine] = React.useState<[Cell,Cell]>();
    const [saving, setSaving] = React.useState(false);
    const busy = saving || refreshing;
    const [warning, setWarning] = React.useState("");
    const [confirmReload, setConfirmReload] = React.useState(false);
    const [notice, setNotice] = React.useState("");
    const width = Math.ceil(map.size.x / map.pixelSize), height = Math.ceil(map.size.y / map.pixelSize);
    const paths = React.useMemo(() => layerPaths(map), [map]);
    const doors = latestDoors(edits, state.doors);
    const selected = doors.find(d => d.id === picked);
    const selectedSaved = edits.length ? undefined : state.doors.find(d => d.id === picked);
    const rooms = paths.filter(p => p.layer.type === "segment");
    const room = rooms.find(r => r.value === paint)?.layer;
    const baseGeometry = React.useMemo(() => paths.map(({path,value}, i) =>
        <path key={i} d={path} fill={paintColor(value)}/>), [paths]);
    const committedPaint = React.useMemo(() => edits.map((edit, i) =>
        "runs" in edit && !!edit.runs.length && <path key={i} d={runPath(edit.runs)}
            fill={paintColor(edit.runs[0][3])}/>), [edits]);
    const append = (edit: Edit) => {
        setEdits(list => [...list, edit]); setFuture([]); setWarning(""); setNotice("");
    };
    const clearGesture = () => {
        gesture.current = null; setPreview([]); setLine(undefined);
    };
    function coordinates(e: React.PointerEvent<SVGSVGElement>) {
        const ctm = e.currentTarget.getScreenCTM();
        if (!ctm) {
            return null;
        }
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
        return {x: Math.floor(p.x), y: Math.floor(p.y)};
    }
    function draw(g: Gesture, p: Cell, finish: boolean) {
        const target = {x: Math.min(width-1, Math.max(0, p.x)), y: Math.min(height-1, Math.max(0, p.y))};
        if (g.tool === "pan") {
            setView(v => ({...v, x: Math.min(width-1, Math.max(1-v.w, v.x+g.start.x-p.x)),
                y: Math.min(height-1, Math.max(1-v.h, v.y+g.start.y-p.y))}));
        } else if (g.tool === "brush" || g.tool === "rectangle") {
            let runs: Run[];
            if (g.tool === "brush") {
                extendBrush(g.cells, g.last, target, width, height, Math.floor(brushSize/2));
                if (g.cells.size > maxCells) {
                    throw new Error("Stroke too large. Try a smaller area.");
                }
                runs = brushRuns(g.cells, width, paint);
            } else {
                runs = rectRuns(g.start, target, paint);
            }
            if (finish) {
                append({runs: runs});
            } else {
                setPreview(runs);
            }
        } else if (!finish) {
            setLine([g.start, target]);
        } else if (target.x !== g.start.x || target.y !== g.start.y) {
            if (g.tool === "door" && doors.length >= 128) {
                throw new Error("This floor already has 128 manual doors.");
            }
            const toCM = (value: number, max: number) => Math.min(max-1, Math.floor((value+.5) * map.pixelSize));
            const door: Door = {id: g.tool === "moveDoor" && selected ? selected.id :
                Array.from(crypto.getRandomValues(new Uint32Array(3))).join("-"),
            state: g.tool === "moveDoor" && selected ? selected.state : doorState,
            points: [toCM(g.start.x, map.size.x), toCM(g.start.y, map.size.y),
                toCM(target.x, map.size.x), toCM(target.y, map.size.y)]};
            append({doors: [...doors.filter(d => d.id !== door.id), door]});
            setPicked(door.id);
        }
        g.last = target;
    }
    function pointer(e: React.PointerEvent<SVGSVGElement>, phase: "start" | "move" | "end") {
        const p = coordinates(e);
        if (busy || !p) {
            return;
        }
        if (phase === "start") {
            if (e.button !== 0 || gesture.current || (tool === "moveDoor" && !selected) ||
                (tool !== "pan" && (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height))) {
                return;
            }
            e.currentTarget.setPointerCapture(e.pointerId);
            gesture.current = {id: e.pointerId, tool: tool, start: p, last: p, cells: new Set()};
        }
        if (gesture.current?.id !== e.pointerId) {
            return;
        }
        try {
            draw(gesture.current, p, phase === "end");
        } catch (err) {
            setWarning(errorMessage(err)); clearGesture();
        }
        if (phase === "end") {
            clearGesture();
        }
    }
    async function save() {
        setSaving(true); setWarning("");
        try {
            const runs = mergedRuns(edits, width);
            const payload = {floorId: state.floorId, revision: state.revision,
                runs: runs.length ? runs : undefined, doors: edits.some(edit => "doors" in edit) ? doors : undefined};
            if (runs.length > 4096 || new Blob([JSON.stringify(payload)]).size > 95 * 1024) {
                throw new Error("Too many separate areas for one save. Undo the last stroke and save in smaller batches.");
            }
            await valetudoAPI.put(endpoint, payload);
            setEdits([]); setFuture([]); setNotice("Saved."); reload();
        } catch (err) {
            setWarning(errorMessage(err));
        } finally {
            setSaving(false);
        }
    }
    function zoom(scale: number) {
        setView(v => {
            const k = Math.max(8/Math.min(v.w,v.h), Math.min(scale, Math.max(width,height)/Math.max(v.w,v.h)));
            return {x: v.x+v.w*(1-k)/2, y: v.y+v.h*(1-k)/2, w: v.w*k, h: v.h*k};
        });
    }
    const options = {pan: "Pan", brush: "Brush", rectangle: "Rectangle", door: "Add door", moveDoor: "Redraw selected door"};
    return <Stack spacing={1.5}>
        <Typography variant="h5">Pixel &amp; door editor · floor {state.floorId}</Typography>
        <Typography variant="body2" sx={{"& a": {color: "primary.main"}}}>Paint the map displayed by Valetudo. A new robot observation can replace painted cells.
            Manual doors and their marked states stay until you edit them. For navigation, use{" "}
        <Link to="/options/map_management/segments">Edit navigation rooms</Link> or{" "}
        <Link to="/options/map_management/virtual_restrictions">Edit navigation walls</Link>.</Typography>
        <Stack direction="row" useFlexGap flexWrap="wrap" gap={1} alignItems="center">
            <TextField select size="small" label="Tool" value={tool} disabled={busy}
                onChange={e => setTool(e.target.value as Tool)} sx={{minWidth: 125}}>
                {Object.entries(options).map(([key,label]) => <MenuItem key={key} value={key}
                    disabled={key === "moveDoor" && !selected}>{label}</MenuItem>)}
            </TextField>
            {(tool === "brush" || tool === "rectangle") && <TextField select size="small" label="Paint" value={paint}
                disabled={busy} onChange={e => setPaint(e.target.value)} sx={{minWidth: 150}}>
                {state.rooms.map(r => <MenuItem key={r.id} value={"room:" + r.id}>{r.name || "Room"} #{r.id}</MenuItem>)}
                {Object.entries({floor: "Unassigned floor", wall: "Wall", unknown: "Erase to unknown", native: "Restore robot cells"})
                    .map(([key,label]) => <MenuItem key={key} value={key}>{label}</MenuItem>)}
            </TextField>}
            {tool === "brush" && <TextField select size="small" label="Brush width" value={brushSize}
                disabled={busy} onChange={e => setBrushSize(Number(e.target.value))}>
                {[1,3,5,9].map(n => <MenuItem key={n} value={n}>{n} px · {n*map.pixelSize} cm</MenuItem>)}
            </TextField>}
            <Button size="small" aria-label="Zoom in" onClick={() => zoom(.65)}>Zoom +</Button>
            <Button size="small" aria-label="Zoom out" onClick={() => zoom(1/.65)}>Zoom −</Button>
            <Button size="small" onClick={() => setView(fitView(map))}>Fit</Button>
        </Stack>
        <Typography variant="caption">{tool === "pan" ? "Drag to pan. Switch to Brush or Rectangle to resize a room." :
            tool === "brush" ? "Tap to paint one brush mark or drag to trace a boundary." :
                tool === "rectangle" ? "Drag between opposite corners to paint a filled rectangle." :
                    "Drag between the two door jambs to set its position and width."} One cell = {map.pixelSize} cm.
        {(tool === "brush" || tool === "rectangle") && room &&
                ` Saved room area: ${(room.dimensions.pixelCount * map.pixelSize ** 2 / 10000).toFixed(2)} m².`}
        {tool === "rectangle" && preview.length > 0 && ` Selection: ${preview[0][2] * map.pixelSize} × ${preview.length * map.pixelSize} cm.`}
        </Typography>
        <Box sx={{backgroundColor: "#101317", border: "1px solid #596069", borderRadius: 1}}>
            <svg role="img" aria-label="Editable floor map" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                style={{width: "100%", height: "min(55vh, 620px)", minHeight: 240, touchAction: "none", display: "block",
                    userSelect: "none", cursor: tool === "pan" ? "grab" : "crosshair"}}
                onPointerDown={e => pointer(e, "start")} onPointerMove={e => pointer(e, "move")}
                onPointerUp={e => pointer(e, "end")} onPointerCancel={clearGesture} onLostPointerCapture={clearGesture}>
                <defs><pattern id="restore-native" width={2} height={2} patternUnits="userSpaceOnUse">
                    <rect width={2} height={2} fill="#4b355c"/><rect width={1} height={1} fill="#d5a3fc"/>
                </pattern><pattern id="editor-grid" width={1} height={1} patternUnits="userSpaceOnUse">
                    <path d="M0 1V0H1" fill="none" stroke="#ddd" strokeWidth={.055}/>
                </pattern></defs>
                <g shapeRendering="crispEdges">{baseGeometry}{committedPaint}
                    {preview.length > 0 && <path d={runPath(preview)} fill={paintColor(paint)} opacity={.85}/>}</g>
                {Math.max(view.w, view.h) < 95 &&
                    <rect width={width} height={height} fill="url(#editor-grid)" opacity={.55} pointerEvents="none"/>}
                {rooms.map(({layer,value}) => <text key={value} x={layer.dimensions.x.avg} y={layer.dimensions.y.avg}
                    fontSize={Math.max(2.5, view.h/36)} fill="white" stroke="#222" strokeWidth={Math.max(.45, view.h/240)} paintOrder="stroke" textAnchor="middle"
                >{layer.metaData.name || "Room"} #{layer.metaData.segmentId}</text>)}
                {map.entities.filter(e => e.type === RawMapEntityType.Door && e.metaData.source !== "user").map((e,i) =>
                    <line key={i} x1={e.points[0]/map.pixelSize} y1={e.points[1]/map.pixelSize}
                        x2={e.points[2]/map.pixelSize} y2={e.points[3]/map.pixelSize}
                        stroke="#aaa" strokeDasharray="1 1" strokeWidth={.7}/>)}
                {doors.map(d => <g key={d.id} stroke={d.id === picked ? "#fff" : manualDoorColor}
                    onPointerDown={e => {
                        if (tool === "pan" && !busy) {
                            e.stopPropagation(); setPicked(d.id); setDoorState(d.state);
                        }
                    }}>
                    <title>Manual door · {d.state}</title>
                    <line x1={d.points[0]/map.pixelSize} y1={d.points[1]/map.pixelSize} x2={d.points[2]/map.pixelSize}
                        y2={d.points[3]/map.pixelSize} stroke="transparent" strokeWidth={12} vectorEffect="non-scaling-stroke"/>
                    <line x1={d.points[0]/map.pixelSize} y1={d.points[1]/map.pixelSize} x2={d.points[2]/map.pixelSize}
                        y2={d.points[3]/map.pixelSize} strokeWidth={1} strokeDasharray={d.state === "unknown" ? "2 1" : undefined}/>
                    <circle cx={d.points[0]/map.pixelSize} cy={d.points[1]/map.pixelSize} r={.85} fill={manualDoorColor}/>
                    <circle cx={d.points[2]/map.pixelSize} cy={d.points[3]/map.pixelSize} r={.85} fill={manualDoorColor}/>
                    {d.state === "closed" && <path d="M-1 -1l2 2m0 -2l-2 2" strokeWidth={.65}
                        transform={`translate(${(d.points[0]+d.points[2])/(2*map.pixelSize)} ${(d.points[1]+d.points[3])/(2*map.pixelSize)})`}/>}
                </g>)}
                {line && <line x1={line[0].x+.5} y1={line[0].y+.5} x2={line[1].x+.5} y2={line[1].y+.5}
                    stroke="white" strokeWidth={1}/>}
            </svg>
        </Box>
        <Stack direction="row" useFlexGap flexWrap="wrap" gap={1} alignItems="center">
            <TextField select size="small" label="Manual door" value={selected?.id ?? ""} disabled={busy}
                onChange={e => {
                    setPicked(e.target.value); const item = doors.find(d => d.id === e.target.value);
                    if (item) {
                        setDoorState(item.state);
                    }
                }} sx={{minWidth: 150}}>
                <MenuItem value="">None</MenuItem>
                {doors.map(d => <MenuItem key={d.id} value={d.id}>({d.points[0]}, {d.points[1]}) · {d.state}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="Marked state" value={doorState} disabled={busy}
                onChange={e => setDoorState(e.target.value as Door["state"])} sx={{minWidth: 130}}>
                {["unknown","open","closed"].map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
            <Button disabled={!selected || selected.state === doorState || busy}
                onClick={() => append({doors: doors.map(d => d.id === picked ? {...d, state: doorState} : d)})}>Set state</Button>
            <Button disabled={!selected || busy} onClick={() => {
                append({doors: doors.filter(d => d.id !== picked)}); setPicked(""); setTool("pan");
            }}>Remove door</Button>
            {selectedSaved && <Button component={Link} disabled={busy}
                to={`/options/map_management/virtual_restrictions?door=${encodeURIComponent(selectedSaved.id)}&floor=${state.floorId}`}
            >Preview navigation wall here</Button>}
        </Stack>
        <Typography variant="caption">Cyan doors are yours. Grey dashed lines are detected openings. Marking a door closed
            records your observation. A saved virtual wall blocks navigation independently of this door.</Typography>
        {warning && <Alert severity="warning">{warning}</Alert>}{notice && <Alert severity="success">{notice}</Alert>}
        <Stack direction="row" useFlexGap flexWrap="wrap" gap={1} alignItems="center">
            <Button variant="contained" disabled={busy || !edits.length} onClick={save}>Save edits</Button>
            <Button disabled={busy || !edits.length} onClick={() => {
                setFuture([edits[edits.length-1], ...future]);
                setEdits(edits.slice(0,-1));
            }}>Undo</Button>
            <Button disabled={busy || !future.length} onClick={() => {
                setEdits([...edits, future[0]]); setFuture(future.slice(1));
            }}>Redo</Button>
            <Button disabled={busy || !edits.length} onClick={() => {
                setEdits([]); setFuture([]); setWarning("");
            }}>Discard draft</Button>
            <Button disabled={busy} onClick={() => edits.length ? setConfirmReload(true) : reload()}>Reload floor</Button>
        </Stack>
        {confirmReload && <Alert severity="warning">Reload and discard the current draft?
            <Button onClick={reload}>Reload</Button><Button onClick={() => setConfirmReload(false)}>Keep editing</Button></Alert>}
    </Stack>;
}

export default function PixelEditorPage() {
    const query = useQuery({queryKey: ["d103_pixel_editor"], queryFn: load, staleTime: Infinity,
        retry: (attempt, error) => attempt < 8 && axios.isAxiosError(error) && error.response?.status === 409,
        retryDelay: 5000, refetchOnWindowFocus: false, refetchOnReconnect: false, gcTime: 0});
    const [generation, setGeneration] = React.useState(0);
    const reload = () => {
        void query.refetch().then(result => {
            if (!result.isError) {
                setGeneration(n => n+1);
            }
        });
    };
    return <PaperContainer>
        {query.isPending && <Typography>{query.failureCount ? "Waiting for the robot’s localized room map…" : "Loading editor…"}</Typography>}
        {query.isError && <Alert severity="error">{errorMessage(query.error)} <Button onClick={reload}>Retry</Button></Alert>}
        {query.data && <Editor key={generation} data={query.data} reload={reload} refreshing={query.isFetching}/>}
    </PaperContainer>;
}
