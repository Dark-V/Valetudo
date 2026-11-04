const DreameMapParser = require("./DreameMapParser");
const fs = require("fs");
const LineMapEntity = require("../../entities/map/entities/LineMapEntity");

/** Read-only doorway geometry from the stock map divider. No navigation writes. */
class D103CNDoorways {
    constructor() {
        this.fingerprint = null;
        this.cached = null;
    }

    /** @param {import("../../entities/map/ValetudoMap")} map */
    appendTo(map) {
        // Local unlocalized scans use another origin. Never overlay saved doors.
        if (map.metaData.unlocalizedScan === true || map.metaData.source === "D103CN saved ProbabilityGrid") {
            return;
        }
        try {
            const selection = D103CNDoorways.READ_JSON("/data/ri/config.json2");
            const id = selection.curr_id;
            if (!Number.isInteger(id) || id < 0 || id > 999999) {
                return;
            }
            const root = `/data/DivideMap/${id}`;
            const paths = ["all_doors_info.json", "unified_doors_info.json", "room_neighbor_table_large.json"];
            const stats = paths.map(p => fs.lstatSync(`${root}/${p}`));
            const fingerprint = `${id}:` + stats.map(s => `${s.ino}:${s.size}:${s.mtimeMs}`).join(":");
            if (fingerprint !== this.fingerprint) {
                const values = paths.map(p => D103CNDoorways.READ_JSON(`${root}/${p}`));
                // Recheck after the native writer: discard an inconsistent read.
                if (paths.some((p, i) => {
                    const after = fs.lstatSync(`${root}/${p}`);
                    return after.ino !== stats[i].ino || after.size !== stats[i].size || after.mtimeMs !== stats[i].mtimeMs;
                })) {
                    return;
                }
                this.cached = {mapId: id, detected: values[0], unified: values[1], topology: values[2],
                    savedAt: new Date(stats[0].mtimeMs).toISOString()};
                this.fingerprint = fingerprint;
            }
            D103CNDoorways.APPEND(map, this.cached);
        } catch (_) {
            // Missing/in-progress native data must not break the live map.
            map.metaData.doorways = {available: false};
        }
    }

    /** @param {string} path @returns {any} */
    static READ_JSON(path) {
        const stat = fs.lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 262144) {
            throw new Error("Invalid native doorway file");
        }
        return JSON.parse(fs.readFileSync(path, "utf8"));
    }

    /**
     * Factory CvtGrid2MM at 0x12d6c8: (cell - 1800 + .5) * .05 * 1000.
     * Verified against the native split line and existing SDK room boundaries.
     * @param {number} x
     * @param {number} y
     */
    static POINT(x, y) {
        return DreameMapParser.CONVERT_TO_VALETUDO_COORDINATES(
            Math.trunc((x - 1799.5) * 50), Math.trunc((y - 1799.5) * 50));
    }

    /** @param {number[]} p */
    static KEY(p) {
        const a = `${p[0]},${p[1]}`, b = `${p[2]},${p[3]}`;
        return a < b ? a + ":" + b : b + ":" + a;
    }

    /**
     * Pure parsing of actual native captures; also used by the on-device reader.
     * @param {import("../../entities/map/ValetudoMap")} map
     * @param {{mapId: number, detected: any, unified: any, topology: any, savedAt: string}} data
     */
    static APPEND(map, data) {
        const actualIds = map.getSegments().map(s => Number(s.id)).sort((a, b) => a - b);
        const nativeIds = data.topology?.RoomIdAndColorLookUpTable?.RoomIds;
        if (!Array.isArray(nativeIds) || actualIds.length === 0 ||
            JSON.stringify([...nativeIds].sort((a, b) => a - b)) !== JSON.stringify(actualIds)) {
            map.metaData.doorways = {available: false};
            return;
        }
        if (!Array.isArray(data.detected?.doors) || data.detected.doors.length > 128 ||
            !Array.isArray(data.unified?.doors) || data.unified.doors.length > 256) {
            throw new Error("Invalid native doorway collection");
        }
        // Unified data also contains manual/reused room split lines (type 9).
        // Use the actual detected-opening list as the geometry authority.
        const unified = new Map();
        for (const d of data.unified.doors) {
            if (Array.isArray(d.beg_pt) && Array.isArray(d.end_pt)) {
                unified.set(D103CNDoorways.KEY([...d.beg_pt, ...d.end_pt]), d);
            }
        }
        const seen = new Set();
        const doors = [];
        for (const d of data.detected.doors) {
            const points = [d["start_point.x_"], d["start_point.y_"], d["end_point.x_"], d["end_point.y_"]];
            if (points.some(v => !Number.isInteger(v) || v < 0 || v >= 3600) || d.user_line_ === true) {
                continue;
            }
            const length = Math.hypot(points[2] - points[0], points[3] - points[1]);
            if (length < 6 || length > 60) {
                continue;
            }
            const key = D103CNDoorways.KEY(points);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const a = D103CNDoorways.POINT(points[0], points[1]);
            const b = D103CNDoorways.POINT(points[2], points[3]);
            const native = unified.get(key);
            doors.push(new LineMapEntity({type: LineMapEntity.TYPE.DOOR,
                points: [a.x, a.y, b.x, b.y],
                metaData: {id: `${data.mapId}:${key}`, source: "native_detected_opening",
                    nativeMapId: data.mapId, nativeDoorStatus: native?.door_status,
                    nativeDoorType: native?.door_type,
                    // All inspected factory producer overloads explicitly write
                    // zero here. No open/closed enum has been established.
                    doorState: "unknown", mapPassability: "unknown", savedAt: data.savedAt}}));
        }
        const samples = [];
        const rows = new Map();
        for (const door of doors) {
            const [x0, y0, x1, y1] = door.points;
            const length = Math.hypot(x1-x0, y1-y0);
            const nx = -(y1-y0)/length, ny = (x1-x0)/length;
            const cells = new Set();
            // Ignore the jambs; inspect the centre 60% and a narrow ribbon.
            for (let n = 0; n <= 12; n++) {
                const t = .2 + .6 * n / 12;
                for (const offset of [-map.pixelSize, 0, map.pixelSize]) {
                    const x = Math.round((x0 + (x1-x0)*t + nx*offset) / map.pixelSize);
                    const y = Math.round((y0 + (y1-y0)*t + ny*offset) / map.pixelSize);
                    const key = `${x}:${y}`;
                    cells.add(key);
                    if (!rows.has(y)) {
                        rows.set(y, new Map());
                    }
                    rows.get(y).set(x, 0);
                }
            }
            samples.push(cells);
        }
        for (const layer of map.layers) {
            const wall = layer.type === "wall";
            if (!wall && !["floor", "segment"].includes(layer.type)) {
                continue;
            }
            for (let n = 0; n < layer.compressedPixels.length; n += 3) {
                const x0 = layer.compressedPixels[n], y = layer.compressedPixels[n+1];
                const row = rows.get(y);
                if (!row) {
                    continue;
                }
                const x1 = x0 + layer.compressedPixels[n+2];
                for (const [x, value] of row) {
                    if (x >= x0 && x < x1) {
                        row.set(x, wall ? 2 : value || 1);
                    }
                }
            }
        }
        const counts = {clear: 0, blocked: 0, unknown: 0};
        for (const [i, door] of doors.entries()) {
            let free = 0, wall = 0;
            for (const p of samples[i]) {
                const [x, y] = p.split(":").map(Number);
                const value = rows.get(y)?.get(x);
                free += value === 1 ? 1 : 0;
                wall += value === 2 ? 1 : 0;
            }
            const total = samples[i].size;
            const state = free / total >= .8 && wall / total <= .1 ? "clear" :
                wall / total >= .65 ? "blocked" : "unknown";
            door.metaData.mapPassability = state;
            counts[state]++;
        }
        map.addEntities(doors);
        map.metaData.doorways = {available: true, nativeMapId: data.mapId, ...counts,
            physicalStateAvailable: false, source: "saved_map", savedAt: data.savedAt};
    }
}

module.exports = D103CNDoorways;
