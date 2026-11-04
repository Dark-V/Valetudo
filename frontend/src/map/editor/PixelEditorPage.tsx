import React from "react";
import {Alert, Box, Button, MenuItem, Stack, TextField, Typography} from "@mui/material";
import {Link} from "react-router-dom";
import axios from "axios";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {Capability, CombinedVirtualRestrictionsUpdateRequestParameters, fetchStateAttributes, RawMapData,
    RawMapEntityType, RawMapLayer, RobotAttributeClass, sendCombinedVirtualRestrictionsUpdate, useRobotStatusQuery, valetudoAPI} from "../../api";
import PaperContainer from "../../components/PaperContainer";
import {brushRuns, Cell, Door, Edit, extendBrush, latestDoors, layerPaths, manualDoorColor, maxCells,
    mergedRuns, paintColor, rectRuns, Run, runPath, sameWalls, Snapshot, Wall} from "./geometry";

const endpoint = "/robot/state/map/editor";
type Tool = "pan" | "brush" | "rectangle" | "door" | "moveDoor" | "navigationWall";
type View = {x: number; y: number; w: number; h: number};
type WallHandle = "start" | "end" | "body";
type Gesture = {id: number; tool: Tool; start: Cell; last: Cell; cells: Set<number>;
    wall?: {index: number; original: Wall; handle: WallHandle}};
type EditorData = {map: RawMapData; state: Snapshot};
type RoomOperation = {available: boolean; phase: "idle" | "applying" | "confirmed" | "failed" | "restoring" | "restored" | "needs_recovery";
    floorId: number | null; roomIds: string[]; message: string; operationId: string | null; canRollback: boolean};
const roomEndpoint = endpoint + "/rooms";
const isRunning = (op?: RoomOperation) => op?.phase === "applying" || op?.phase === "restoring";
const getRoomOperation = async () => (await valetudoAPI.get<RoomOperation>(roomEndpoint)).data;

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

function wallsFromMap(map: RawMapData): Wall[] {
    return map.entities.filter(e => e.type === RawMapEntityType.VirtualWall).map(e => {
        if (e.points.length !== 4 || !e.points.every(Number.isInteger)) {
            throw new Error("Invalid navigation wall in the current map");
        }
        return [e.points[0], e.points[1], e.points[2], e.points[3]];
    });
}

const restrictionsUrl = `/robot/capabilities/${Capability.CombinedVirtualRestrictions}`;
type Restrictions = Pick<CombinedVirtualRestrictionsUpdateRequestParameters,"virtualWalls" | "restrictedZones">;
const linesFromRestrictions = (r: Restrictions): Wall[] => r.virtualWalls.map(({points: {pA,pB}}) => [pA.x,pA.y,pB.x,pB.y]);

function errorMessage(err: unknown) {
    if (axios.isAxiosError(err)) {
        if ((err.response?.status === 409 || err.response?.status === 412) && err.config?.method === "put") {
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

function Editor({data: {map, state}, reload, refreshing, savedNotice, initialRoomId}: {
    data: EditorData; reload: (message?: string, roomId?: string) => void; refreshing: boolean;
    savedNotice: string; initialRoomId?: string
}) {
    const firstRoom = state.rooms.find(r => r.id === initialRoomId)?.id ?? state.rooms[0]?.id;
    const [tool, setTool] = React.useState<Tool>(initialRoomId ? "brush" : "pan");
    const [paint, setPaint] = React.useState(firstRoom ? "room:" + firstRoom : "floor");
    const [nativeTarget, setNativeTarget] = React.useState(!!firstRoom);
    const [brushSize, setBrushSize] = React.useState(1);
    const [picked, setPicked] = React.useState("");
    const [doorState, setDoorState] = React.useState<Door["state"]>("unknown");
    const [edits, setEdits] = React.useState<Edit[]>([]);
    const [future, setFuture] = React.useState<Edit[]>([]);
    const [view, setView] = React.useState(() => fitView(map));
    const svg = React.useRef<SVGSVGElement>(null);
    const gesture = React.useRef<Gesture | null>(null);
    const [preview, setPreview] = React.useState<Run[]>([]);
    const [line, setLine] = React.useState<[Cell,Cell]>();
    const [wallPreview, setWallPreview] = React.useState<Wall>();
    const [selectedWall, setSelectedWall] = React.useState(-1);
    const [wallWritePendingReadback, setWallWritePendingReadback] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [confirmRestore, setConfirmRestore] = React.useState(false);
    const [awaitingOp, setAwaitingOp] = React.useState<{id: string; roomId?: string}>();
    const queryClient = useQueryClient();
    const roomQueryKey = ["d103_native_room_operation",state.floorId];
    const roomOpQuery = useQuery({queryKey: roomQueryKey, queryFn:getRoomOperation,
        retry: false, refetchInterval: q => awaitingOp || isRunning(q.state.data) ? 2500 : false});
    const roomOp = roomOpQuery.data;
    const busy = saving || refreshing || isRunning(roomOp) || !!awaitingOp;
    const [warning, setWarning] = React.useState("");
    const [confirmReload, setConfirmReload] = React.useState(false);
    const [notice, setNotice] = React.useState(savedNotice);
    const width = Math.ceil(map.size.x / map.pixelSize), height = Math.ceil(map.size.y / map.pixelSize);
    const savedWalls = React.useMemo(() => wallsFromMap(map), [map]);
    const wallChange = [...edits].reverse().find((e): e is {walls: Wall[]} => "walls" in e);
    const roomDraft = edits.some(e => "runs" in e && e.nativeRoom);
    const otherDraft = edits.length > 0 && !wallChange && !roomDraft;
    const walls = wallChange?.walls ?? savedWalls;
    const editingWalls = tool === "navigationWall" || !!wallChange;
    const nativeBrush = nativeTarget && (tool === "brush" || tool === "rectangle" || roomDraft);
    const needsNativeLayers = (editingWalls || nativeBrush) && state.editedCells > 0;
    const native = useQuery({queryKey: ["native_map_editor_backdrop",state.floorId,state.revision],
        enabled: needsNativeLayers, staleTime: Infinity, gcTime: 0, retry: false,
        queryFn: async () => {
            const {data} = await valetudoAPI.get<Pick<Snapshot,"floorId" | "revision"> & {layers: RawMapLayer[]}>(endpoint+"/native");
            if (state.floorId !== data.floorId || state.revision !== data.revision) {
                throw new Error("The selected floor changed. Reload the map.");
            }
            return data.layers;
        }});
    const wallGeometryReady = !state.editedCells || !!native.data;
    const drawingMap = React.useMemo(() => needsNativeLayers ?
        {...map, layers: native.data ?? []} : map, [map,needsNativeLayers,native.data]);
    const paths = React.useMemo(() => layerPaths(drawingMap), [drawingMap]);
    const {data: robotStatus} = useRobotStatusQuery();
    const doors = latestDoors(edits, state.doors);
    const selected = doors.find(d => d.id === picked);
    const selectedSaved = edits.length ? undefined : state.doors.find(d => d.id === picked);
    const rooms = paths.filter(p => p.layer.type === "segment");
    const room = rooms.find(r => r.value === paint)?.layer;
    const roomId = paint.startsWith("room:") ? paint.slice(5) : undefined;
    const roomName = state.rooms.find(r => r.id === roomId)?.name || roomId;
    const roomVerified = roomOp?.phase === "confirmed" && roomOp.floorId === state.floorId &&
        !!roomId && roomOp.roomIds.map(String).includes(roomId);
    React.useEffect(() => {
        if (!awaitingOp && roomOp?.operationId && roomOp.floorId === state.floorId && isRunning(roomOp)) {
            setAwaitingOp({id:roomOp.operationId, roomId:roomOp.roomIds[0]});
            return;
        }
        if (!awaitingOp || !roomOp || isRunning(roomOp)) {
            return;
        }
        setAwaitingOp(undefined);
        if (roomOp.operationId !== awaitingOp.id) {
            setWarning(roomOp.message || "The active native edit changed. Reload the floor.");
            return;
        }
        if (roomOp.phase === "confirmed" || roomOp.phase === "restored") {
            setEdits([]); setFuture([]); reload(roomOp.message, awaitingOp.roomId);
        } else {
            setWarning(roomOp.message || "Firmware could not confirm the room update.");
        }
    }, [awaitingOp,roomOp,reload,state.floorId]);
    function trackOperation(op: RoomOperation) {
        if (!op.operationId || op.floorId !== state.floorId) {
            throw new Error("The robot did not identify the operation on this floor. Reload its status.");
        }
        queryClient.setQueryData(roomQueryKey,op);
        setAwaitingOp({id:op.operationId,roomId:roomId});
    }
    async function restoreRoom() {
        if (!roomOp?.canRollback || roomOp.floorId !== state.floorId || !roomOp.operationId) {
            return;
        }
        setSaving(true); setWarning(""); setConfirmRestore(false);
        try {
            const {data} = await valetudoAPI.post<RoomOperation>(roomEndpoint+"/restore",{
                floorId:state.floorId,operationId:roomOp.operationId
            });
            trackOperation(data);
        } catch (err) {
            setWarning(errorMessage(err));
            void roomOpQuery.refetch();
        } finally {
            setSaving(false);
        }
    }
    async function cleanSavedRoom() {
        if (!roomVerified || !roomId || edits.length || busy) {
            return;
        }
        setSaving(true); setWarning("");
        try {
            await valetudoAPI.put(`/robot/capabilities/${Capability.MapSegmentation}`, {
                action:"start_segment_action", segment_ids:[roomId], iterations:1, customOrder:false, useProfiles:true
            }, {headers:{"If-Match":`"${state.floorId}:${state.revision}"`}});
            setNotice("Room cleaning command sent for " + roomName + ".");
        } catch (err) {
            setWarning(errorMessage(err));
        } finally {
            setSaving(false);
        }
    }
    const baseGeometry = React.useMemo(() => paths.map(({path,value}, i) =>
        <path key={i} d={path} fill={paintColor(value)}/>), [paths]);
    const committedPaint = React.useMemo(() => edits.map((edit, i) =>
        "runs" in edit && !!edit.runs.length && <path key={i} d={runPath(edit.runs)}
            fill={paintColor(edit.runs[0][3])}/>), [edits]);
    const append = (edit: Edit) => {
        setEdits(list => [...list, edit]); setFuture([]); setWarning(""); setNotice("");
    };
    const clearGesture = () => {
        gesture.current = null; setPreview([]); setLine(undefined); setWallPreview(undefined);
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
        const toCM = (value: number, max: number) => Math.min(max-1, Math.floor((value+.5) * map.pixelSize));
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
                append({runs: runs, nativeRoom: nativeTarget});
            } else {
                setPreview(runs);
            }
        } else if (g.tool === "navigationWall") {
            const index = g.wall?.index ?? walls.length;
            const tx = toCM(target.x, map.size.x), ty = toCM(target.y, map.size.y);
            let wall: Wall;
            if (!g.wall) {
                wall = [toCM(g.start.x,map.size.x),toCM(g.start.y,map.size.y),tx,ty];
            } else {
                if (target.x === g.start.x && target.y === g.start.y) {
                    setWallPreview(undefined);
                    return;
                }
                const [x,y,endX,endY] = g.wall.original;
                if (g.wall.handle === "start") {
                    wall = [tx,ty,endX,endY];
                } else if (g.wall.handle === "end") {
                    wall = [x,y,tx,ty];
                } else {
                    const dx = Math.max(-Math.min(x,endX), Math.min(map.size.x-1-Math.max(x,endX),(target.x-g.start.x)*map.pixelSize));
                    const dy = Math.max(-Math.min(y,endY), Math.min(map.size.y-1-Math.max(y,endY),(target.y-g.start.y)*map.pixelSize));
                    wall = [x+dx,y+dy,endX+dx,endY+dy];
                }
            }
            if (!finish) {
                setWallPreview(wall);
            } else if (wall[0] !== wall[2] || wall[1] !== wall[3]) {
                const next = walls.slice();
                if (next.some((w, i) => i !== index && sameWalls([w],[wall]))) {
                    throw new Error("A navigation wall already occupies that line.");
                }
                next[index] = wall;
                if (!sameWalls(next,walls)) {
                    append({walls: next});
                }
                setSelectedWall(index);
            }
        } else if (!finish) {
            setLine([g.start, target]);
        } else if (target.x !== g.start.x || target.y !== g.start.y) {
            if (g.tool === "door" && doors.length >= 128) {
                throw new Error("This floor already has 128 manual doors.");
            }
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
                (tool === "navigationWall" && (!wallGeometryReady || wallWritePendingReadback)) ||
                (nativeBrush && (!wallGeometryReady || otherDraft)) ||
                (tool !== "pan" && (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height))) {
                return;
            }
            e.currentTarget.setPointerCapture(e.pointerId);
            gesture.current = {id: e.pointerId, tool: tool, start: p, last: p, cells: new Set()};
            if (tool === "navigationWall") {
                const handle = e.target instanceof Element && e.target.closest<SVGElement>("[data-wall-index]");
                const index = handle ? Number(handle.dataset.wallIndex) : -1;
                setSelectedWall(index);
                if (walls[index] && handle) {
                    gesture.current.wall = {index: index, original: walls[index], handle: handle.dataset.wallHandle as WallHandle};
                }
            }
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
            if (wallChange) {
                const [attributes, current] = await Promise.all([fetchStateAttributes(),valetudoAPI.get<Restrictions>(restrictionsUrl)]);
                if (!attributes.some(a => a.__class === RobotAttributeClass.StatusState && a.value === "docked")) {
                    throw new Error("Dock the robot before saving navigation walls.");
                }
                if (!sameWalls(savedWalls,linesFromRestrictions(current.data))) {
                    throw new Error("The robot's walls changed. Reload this floor before editing.");
                }
                // The native setter replaces all restrictions. Carry the actual no-go/no-mop zones
                // through unchanged and guard the whole write against a stale floor/revision.
                setWallWritePendingReadback(true);
                await sendCombinedVirtualRestrictionsUpdate({
                    virtualWalls: walls.map(([x,y,endX,endY]) => ({points:{pA:{x:x,y:y},pB:{x:endX,y:endY}}})),
                    restrictedZones: current.data.restrictedZones.map(({type, points}) => ({type:type,points:points})),
                    editorPrecondition:{floorId:state.floorId,revision:state.revision}
                });
                for (let n = 0; n < 15; n++) {
                    const reported = await valetudoAPI.get<Restrictions>(restrictionsUrl);
                    if (sameWalls(linesFromRestrictions(reported.data),walls)) {
                        const {data} = await valetudoAPI.get<RawMapData>("/robot/state/map");
                        if (data.metaData.mapEditor?.floorId !== state.floorId || !sameWalls(wallsFromMap(data),walls)) {
                            throw new Error("The floor changed during wall verification. Reload to see its restrictions.");
                        }
                        setEdits([]); setFuture([]); reload("Navigation walls confirmed by the robot.");
                        return;
                    }
                    if (n < 14) {
                        await new Promise(resolve => window.setTimeout(resolve, 2500));
                    }
                }
                throw new Error("Wall command sent. The robot has not returned the new lines yet. Reload the floor to check.");
            }
            const runs = mergedRuns(edits, width);
            const payload = {floorId: state.floorId, revision: state.revision,
                runs: runs.length ? runs : undefined, doors: edits.some(edit => "doors" in edit) ? doors : undefined};
            if (runs.length > 4096 || new Blob([JSON.stringify(payload)]).size > 95 * 1024) {
                throw new Error("Too many separate areas for one save. Undo the last stroke and save in smaller batches.");
            }
            if (roomDraft) {
                if (!roomOp?.available || !runs.length || edits.some(e => !("runs" in e) || !e.nativeRoom)) {
                    throw new Error("Cannot apply this draft to a native room.");
                }
                const {data} = await valetudoAPI.put<RoomOperation>(roomEndpoint,payload);
                trackOperation(data);
                return;
            }
            await valetudoAPI.put(endpoint, payload);
            setEdits([]); setFuture([]); reload("Saved.");
        } catch (err) {
            setWarning(errorMessage(err));
            if (roomDraft) {
                void roomOpQuery.refetch();
            }
        } finally {
            setSaving(false);
        }
    }
    const zoom = React.useCallback((scale: number, u = .5, v = .5) => {
        setView(box => {
            const k = Math.max(8/Math.min(box.w,box.h), Math.min(scale, Math.max(width,height)/Math.max(box.w,box.h)));
            return {x:box.x+box.w*(1-k)*u, y:box.y+box.h*(1-k)*v, w:box.w*k, h:box.h*k};
        });
    }, [width,height]);
    React.useEffect(() => {
        const node = svg.current;
        if (!node) {
            return;
        }
        const wheel = (ev: WheelEvent) => {
            if (!ev.deltaY) {
                return;
            }
            ev.preventDefault();
            const ctm = node.getScreenCTM();
            if (!ctm || gesture.current) {
                return;
            }
            const p = new DOMPoint(ev.clientX,ev.clientY).matrixTransform(ctm.inverse());
            const box = node.viewBox.baseVal;
            const unit = ev.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 :
                ev.deltaMode === WheelEvent.DOM_DELTA_PAGE ? node.clientHeight : 1;
            zoom(Math.exp(Math.max(-1,Math.min(1,ev.deltaY*unit*.0025))),(p.x-box.x)/box.width,(p.y-box.y)/box.height);
        };
        node.addEventListener("wheel",wheel,{passive:false});
        return () => node.removeEventListener("wheel",wheel);
    }, [zoom]);
    const options = {pan: "Pan", brush: "Brush", rectangle: "Rectangle", door: "Add door", moveDoor: "Redraw selected door",
        navigationWall:"Navigation walls"};
    return <Stack spacing={1.5}>
        <Typography variant="h5">Pixel &amp; door editor · floor {state.floorId}</Typography>
        <Typography variant="body2" sx={{"& a": {color: "primary.main"}}}>Use the wheel or trackpad to zoom at the pointer.
            Use Navigation walls to change barriers that the robot obeys. Manual door markers stay until you edit them.{" "}
        <Link to="/options/map_management/segments">Split or merge native rooms</Link> ·{" "}
        <Link to="/options/map_management/virtual_restrictions">Manage no-go and no-mop zones</Link>.</Typography>
        <Stack direction="row" useFlexGap flexWrap="wrap" gap={1} alignItems="center">
            <TextField select size="small" label="Tool" value={tool} disabled={busy}
                onChange={e => setTool(e.target.value as Tool)} sx={{minWidth: 125}}>
                {Object.entries(options).map(([key,label]) => <MenuItem key={key} value={key}
                    disabled={(key === "moveDoor" && !selected) || (!!wallChange && !["pan","navigationWall"].includes(key)) ||
                        (roomDraft && !["pan","brush","rectangle"].includes(key)) ||
                        (otherDraft && nativeTarget && ["brush","rectangle"].includes(key)) ||
                        (key === "navigationWall" && edits.length > 0 && !wallChange)}>{label}</MenuItem>)}
            </TextField>
            {(tool === "brush" || tool === "rectangle") && <TextField select size="small" label="Edit target"
                value={nativeTarget ? "native" : "display"} disabled={busy || !!edits.length} sx={{minWidth:160}}
                onChange={e => {
                    const nativeRoom = e.target.value === "native";
                    setNativeTarget(nativeRoom); setPaint(nativeRoom ? "room:" + firstRoom : "floor");
                }}>
                <MenuItem value="native" disabled={!firstRoom}>Room on robot</MenuItem>
                <MenuItem value="display">Display overlay only</MenuItem>
            </TextField>}
            {(tool === "brush" || tool === "rectangle") && <TextField select size="small" label="Paint" value={paint}
                disabled={busy || (otherDraft && nativeTarget)} onChange={e => setPaint(e.target.value)} sx={{minWidth: 150}}>
                {state.rooms.map(r => <MenuItem key={r.id} value={"room:" + r.id}>{r.name || "Room"} #{r.id}</MenuItem>)}
                {!nativeTarget && Object.entries({floor: "Unassigned floor", wall: "Wall pixel (display)", unknown: "Erase to unknown", native: "Restore robot cells"})
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
        <Typography variant="caption">{tool === "navigationWall" ?
            "Drag on empty space to draw a barrier. Drag the red line to move it, or drag either endpoint to resize. Save while docked." :
            tool === "pan" ? "Drag to pan. Switch to Brush or Rectangle to resize a room." :
                tool === "brush" ? "Tap to paint one brush mark or drag to trace a boundary." :
                    tool === "rectangle" ? "Drag between opposite corners to paint a filled rectangle." :
                        "Drag between the two door jambs to set its position and width."} One cell = {map.pixelSize} cm.
        {(tool === "brush" || tool === "rectangle") && room &&
                ` Saved room area: ${(room.dimensions.pixelCount * map.pixelSize ** 2 / 10000).toFixed(2)} m².`}
        {tool === "rectangle" && preview.length > 0 && ` Selection: ${preview[0][2] * map.pixelSize} × ${preview.length * map.pixelSize} cm.`}
        </Typography>
        {nativeBrush && <Typography variant="caption">Paint mapped floor into the chosen room. Save the room on the robot,
            then use Clean after the firmware confirms the boundary. Display overlays do not change cleaning.</Typography>}
        {nativeBrush && !wallGeometryReady && <Alert severity={native.isError ? "warning" : "info"}>
            {native.isError ? "Native geometry changed. Reload this floor." : "Loading the native room boundaries…"}
        </Alert>}
        <Box sx={{backgroundColor: "#101317", border: "1px solid #596069", borderRadius: 1}}>
            <svg ref={svg} role="img" aria-label="Editable floor map" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
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
                {editingWalls && map.entities.filter(e => e.type === RawMapEntityType.NoGoArea || e.type === RawMapEntityType.NoMopArea)
                    .map((e,i) => <polygon key={i} points={e.points.map(n => n/map.pixelSize).join(" ")}
                        fill={e.type === RawMapEntityType.NoGoArea ? "#d93535" : "#5281cf"} opacity=".4" pointerEvents="none"/>)}
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
                {walls.map((w,i) => {
                    const [x,y,endX,endY] = w.map(n => n/map.pixelSize);
                    const handles = tool === "navigationWall" && i === selectedWall;
                    return <g key={i} data-wall-index={i} data-wall-handle="body"
                        pointerEvents={tool === "navigationWall" ? "auto" : "none"}
                        opacity={i === selectedWall && wallPreview ? .35 : 1}>
                        <title>Navigation wall {i+1}</title>
                        <line x1={x} y1={y} x2={endX} y2={endY} stroke="transparent" strokeWidth={16} vectorEffect="non-scaling-stroke"/>
                        <line x1={x} y1={y} x2={endX} y2={endY} stroke="#ff5858" strokeWidth={handles ? 4 : 2.5} vectorEffect="non-scaling-stroke"/>
                        {handles && [[x,y],[endX,endY]].map(([px,py],j) =>
                            <circle key={j} data-wall-index={i} data-wall-handle={j === 0 ? "start" : "end"}
                                cx={px} cy={py} r={Math.max(1,view.h/75)} fill="white" stroke="#ff5858" strokeWidth={2} vectorEffect="non-scaling-stroke"/>)}
                    </g>;
                })}
                {wallPreview && <line x1={wallPreview[0]/map.pixelSize} y1={wallPreview[1]/map.pixelSize}
                    x2={wallPreview[2]/map.pixelSize} y2={wallPreview[3]/map.pixelSize} stroke="white" strokeDasharray="4 3"
                    strokeWidth={3} vectorEffect="non-scaling-stroke" pointerEvents="none"/>}
            </svg>
        </Box>
        {editingWalls && <Stack direction="row" useFlexGap flexWrap="wrap" gap={1} alignItems="center">
            <TextField select size="small" label="Navigation wall" value={walls[selectedWall] ? selectedWall : -1}
                disabled={busy || wallWritePendingReadback} onChange={e => setSelectedWall(Number(e.target.value))} sx={{minWidth:170}}>
                <MenuItem value={-1}>None</MenuItem>
                {walls.map((w,i) => <MenuItem key={i} value={i}>Wall {i+1} · {Math.round(Math.hypot(w[2]-w[0],w[3]-w[1]))} cm</MenuItem>)}
            </TextField>
            <Button disabled={busy || !walls[selectedWall] || wallWritePendingReadback || !wallGeometryReady} onClick={() => {
                append({walls:walls.filter((_,i) => i !== selectedWall)}); setSelectedWall(-1);
            }}>Remove selected wall</Button>
            {robotStatus?.value !== "docked" && <Typography variant="caption">Dock the robot to save its navigation walls.</Typography>}
            {!wallGeometryReady && <Alert severity={native.isError ? "warning" : "info"}>
                {native.isError ? "Native room geometry changed. Reload the floor." : "Loading native navigation geometry…"}
            </Alert>}
        </Stack>}
        {!editingWalls && !roomDraft && !nativeBrush && <>
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
        </>}
        {(nativeBrush || isRunning(roomOp) || roomOp?.canRollback || roomOp?.phase === "needs_recovery") && <Stack spacing={1}>
            {roomOpQuery.isError && <Alert severity="warning">Native writer status unavailable.
                <Button onClick={() => void roomOpQuery.refetch()}>Check status</Button></Alert>}
            {roomOp?.message && <Alert severity={roomOp.phase === "needs_recovery" || roomOp.phase === "failed" ? "warning" : "info"}>
                {roomOp.message}</Alert>}
            <Stack direction="row" gap={1}>
                {roomId && <Button disabled={!roomVerified || busy || !!edits.length ||
                    (robotStatus?.value !== "docked" && robotStatus?.value !== "idle")}
                onClick={cleanSavedRoom}>Clean {roomName}</Button>}
                {roomOp?.canRollback && roomOp.floorId === state.floorId &&
                    <Button disabled={busy || !!edits.length} onClick={() => setConfirmRestore(true)}>
                        {roomOp.phase === "needs_recovery" ? "Recover floor from snapshot" : "Undo saved room edit"}
                    </Button>}
            </Stack>
            {confirmRestore && <Alert severity="warning">
                {roomOp?.phase === "needs_recovery" ?
                    `Recover the entire native floor ${state.floorId} from its pre-edit snapshot? This may replace later changes to this floor.` :
                    `Undo the last saved room edit on floor ${state.floorId}? Its cells will be reverted against the latest native map.`}
                <Button disabled={busy} onClick={restoreRoom}>
                    {roomOp?.phase === "needs_recovery" ? "Restore snapshot" : "Undo saved cells"}
                </Button>
                <Button onClick={() => setConfirmRestore(false)}>Cancel</Button>
            </Alert>}
        </Stack>}
        {warning && <Alert severity="warning">{warning}</Alert>}{notice && <Alert severity="success">{notice}</Alert>}
        <Stack direction="row" useFlexGap flexWrap="wrap" gap={1} alignItems="center">
            <Button variant="contained" disabled={busy || !edits.length || wallWritePendingReadback ||
                (roomDraft && (!roomOp?.available || roomOpQuery.isError || !wallGeometryReady)) ||
                (!!wallChange && (!wallGeometryReady || robotStatus?.value !== "docked"))} onClick={save}>
                {wallChange ? "Save navigation walls to robot" : roomDraft ? "Save room on robot" : "Save edits"}</Button>
            <Button disabled={busy || !edits.length} onClick={() => {
                setFuture([edits[edits.length-1], ...future]);
                setEdits(edits.slice(0,-1));
            }}>Undo</Button>
            <Button disabled={busy || !future.length} onClick={() => {
                const next = future[0];
                if ("runs" in next) {
                    setNativeTarget(next.nativeRoom); setPaint(next.runs[0][3]); setTool("brush");
                } else {
                    setTool("walls" in next ? "navigationWall" : "door");
                }
                setEdits([...edits, next]); setFuture(future.slice(1));
            }}>Redo</Button>
            <Button disabled={busy || !edits.length} onClick={() => {
                setEdits([]); setFuture([]); setWarning("");
            }}>Discard draft</Button>
            <Button disabled={busy} onClick={() => edits.length ? setConfirmReload(true) : reload()}>Reload floor</Button>
        </Stack>
        {confirmReload && <Alert severity="warning">Reload and discard the current draft?
            <Button onClick={() => reload()}>Reload</Button><Button onClick={() => setConfirmReload(false)}>Keep editing</Button></Alert>}
    </Stack>;
}

export default function PixelEditorPage() {
    const query = useQuery({queryKey: ["d103_pixel_editor"], queryFn: load, staleTime: Infinity,
        retry: (attempt, error) => attempt < 8 && axios.isAxiosError(error) && error.response?.status === 409,
        retryDelay: 5000, refetchOnWindowFocus: false, refetchOnReconnect: false, gcTime: 0});
    const [generation, setGeneration] = React.useState(0);
    const [savedNotice, setSavedNotice] = React.useState("");
    const [initialRoomId, setInitialRoomId] = React.useState<string>();
    const reload = (message = "", roomId?: string) => {
        void query.refetch().then(result => {
            if (!result.isError) {
                setSavedNotice(message);
                setInitialRoomId(roomId);
                setGeneration(n => n+1);
            }
        });
    };
    return <PaperContainer>
        {query.isPending && <Typography>{query.failureCount ? "Waiting for the robot’s localized room map…" : "Loading editor…"}</Typography>}
        {query.isError && <Alert severity="error">{errorMessage(query.error)} <Button onClick={() => reload()}>Retry</Button></Alert>}
        {query.data && <Editor key={generation} data={query.data} reload={reload} refreshing={query.isFetching}
            savedNotice={savedNotice} initialRoomId={initialRoomId}/>}
    </PaperContainer>;
}
