import type {RawMapData} from "../../api/RawMapData";

export type Cell = {x: number; y: number};
export type Run = [x: number, y: number, length: number, value: string];
export type Door = {id: string; state: "open" | "closed" | "unknown"; points: [number, number, number, number]};
export type Wall = [number, number, number, number]; // endpoints in firmware map cm
export type Snapshot = {floorId: number; revision: string; pixelSize: number; doors: Door[];
    rooms: Array<{id: string; name: string}>; editedCells: number};
export type Edit = {runs: Run[]; nativeRoom: boolean; paint: string; tool: "brush" | "eraser" | "rectangle"} |
    {doors: Door[]} | {walls: Wall[]};
export const maxCells = 65536;
export const manualDoorColor = "#66daf5";
const roomColors = ["#167d80", "#829f3d", "#c27d36", "#926baf", "#527ab7", "#b05762", "#479695"];

export function paintColor(value: string) {
    if (value.startsWith("room:")) {
        return roomColors[Number(value.slice(5)) % roomColors.length] ?? roomColors[0];
    }
    switch (value) {
        case "floor": return "#398de6";
        case "wall": return "#8d9197";
        case "native": return "url(#restore-native)";
        default: return "#101317";
    }
}

export function extendBrush(cells: Set<number>, start: Cell, end: Cell, width: number, height: number, radius: number) {
    const steps = Math.max(1, Math.abs(end.x - start.x), Math.abs(end.y - start.y));
    for (let i = 0; i <= steps; i++) {
        const cx = Math.round(start.x + (end.x - start.x) * i / steps);
        const cy = Math.round(start.y + (end.y - start.y) * i / steps);
        for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
            for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
                cells.add(y * width + x);
            }
        }
        if (cells.size > maxCells) {
            return;
        }
    }
}

function append(runs: Run[], x: number, y: number, paint: string) {
    const last = runs[runs.length - 1];
    if (last && last[1] === y && last[0] + last[2] === x && last[3] === paint) {
        last[2]++;
    } else {
        runs.push([x, y, 1, paint]);
    }
}

export function brushRuns(cells: Set<number>, width: number, paint: string): Run[] {
    const runs: Run[] = [];
    Array.from(cells).sort((a,b) => a-b).forEach(key => append(runs, key % width, Math.floor(key / width), paint));
    return runs;
}

export function rectRuns(a: Cell, b: Cell, paint: string): Run[] {
    const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
    const width = Math.abs(a.x-b.x)+1, height = Math.abs(a.y-b.y)+1;
    if (width * height > maxCells) {
        throw new Error("Select up to 65,536 cells per save.");
    }
    return Array.from({length: height}, (_, k) => [left, top+k, width, paint]);
}

// Erasing a newly painted extension reveals its original cell, including another
// room or a wall. Only erase cells belonging to the selected room in the saved map.
export function applyRuns(cells: Map<number,string>, runs: Run[], width: number, savedRooms: Map<number,string>) {
    for (const [x,y,n,value] of runs) {
        const erasedRoom = value.startsWith("erase:") ? "room:" + value.slice(6) : undefined;
        for (let k = y*width+x; k < y*width+x+n; k++) {
            if (erasedRoom && erasedRoom !== savedRooms.get(k)) {
                cells.delete(k);
            } else {
                cells.set(k,value);
            }
        }
    }
}

export function mergedRuns(cells: Map<number,string>, width: number): Run[] {
    const result: Run[] = [];
    Array.from(cells.keys()).sort((a,b) => a-b).forEach(k => append(result, k%width, Math.floor(k/width), cells.get(k)!));
    return result;
}

export function latestDoors(edits: Edit[], original: Door[]): Door[] {
    for (let i = edits.length - 1; i >= 0; i--) {
        const edit = edits[i];
        if ("doors" in edit) {
            return edit.doors;
        }
    }
    return original;
}

export function sameWalls(a: Wall[], b: Wall[]): boolean {
    const keys = (walls: Wall[]) => walls.map(([x,y,endX,endY]) =>
        (x < endX || (x === endX && y <= endY) ? [x,y,endX,endY] : [endX,endY,x,y]).join(",")).sort();
    return a.length === b.length && keys(a).join(";") === keys(b).join(";");
}

export function runPath(runs: Run[]): string {
    return runs.map(([x,y,n]) => `M${x} ${y}h${n}v1h-${n}z`).join("");
}

// Map layers provide cell runs or x/y pairs in the same top-left pixel space as the live map.
export function layerPaths(map: RawMapData) {
    const order = {floor: 0, segment: 1, wall: 2};
    return [...map.layers].sort((a,b) => order[a.type] - order[b.type]).map(layer => {
        const value = layer.type === "segment" ? "room:" + layer.metaData.segmentId : layer.type;
        const runs: Run[] = [];
        const compressed = layer.compressedPixels;
        if (compressed?.length) {
            for (let i = 0; i < compressed.length; i += 3) {
                runs.push([compressed[i], compressed[i+1], compressed[i+2], value]);
            }
        } else {
            for (let i = 0; i < layer.pixels.length; i += 2) {
                append(runs, layer.pixels[i], layer.pixels[i+1], value);
            }
        }
        return {value: value, path: runPath(runs), layer: layer, runs: runs};
    });
}
