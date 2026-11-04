const crc = require("crc");
const MapLayer = require("../../entities/map/MapLayer");
const zlib = require("zlib");

// The factory divider reads 8-bit OpenCV PNGs. Refuse different encodings
// rather than guessing how the navigation firmware interprets their pixels.
const MAX_PIXELS = 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const names = {
    base: "segmented_map_large.png", obstacle: "segmented_map_with_obstacle_large.png",
    color: "segmented_map_color.png", slam: "slam_map.png", contour: "contours_with_obstacle_large.png",
    roi: "map_roi_large.json", rooms: "room_neighbor_table_large.json"
};

function check(ok, message) {
    if (!ok) {
        throw new Error("Native room edit: " + message);
    }
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function image(file, width, height, channels) {
    check(Buffer.isBuffer(file) && file.length <= 5 * 1024 * 1024 && file.subarray(0, 8).equals(PNG), "invalid PNG");
    let pos = 8, header = false, end = false;
    const chunks = [];
    while (pos < file.length) {
        check(pos + 12 <= file.length, "truncated PNG chunk");
        const len = file.readUInt32BE(pos), type = file.toString("latin1", pos + 4, pos + 8), start = pos + 8;
        check(start + len + 4 <= file.length, "truncated PNG data");
        check(file.readUInt32BE(start + len) === (crc.crc32(file.subarray(pos + 4, start + len)) >>> 0), "PNG checksum mismatch");
        if (type === "IHDR") {
            check(pos === 8 && len === 13 && file.readUInt32BE(start) === width && file.readUInt32BE(start + 4) === height &&
                file[start + 8] === 8 && file[start + 9] === (channels === 1 ? 0 : 2) &&
                file[start + 10] === 0 && file[start + 11] === 0 && file[start + 12] === 0, "unsupported PNG header or ROI");
            header = true;
        } else if (type === "IDAT") {
            check(header && !end, "PNG data outside the image");
            chunks.push(file.subarray(start, start + len));
        } else {
            check(type === "IEND" && len === 0 && start + 4 === file.length && chunks.length > 0,
                "unexpected PNG chunk or trailing data");
            end = true;
        }
        pos = start + len + 4;
    }
    check(end, "missing PNG end");
    const stride = width * channels;
    const raw = zlib.inflateSync(Buffer.concat(chunks), {maxOutputLength: (stride + 1) * height});
    check(raw.length === (stride + 1) * height, "PNG decoded length mismatch");
    const out = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const offset = y * (stride + 1), filter = raw[offset];
        check(filter <= 4, "invalid PNG row filter");
        for (let x = 0; x < stride; x++) {
            const i = y * stride + x, a = x >= channels ? out[i - channels] : 0;
            const b = y ? out[i - stride] : 0, c = y && x >= channels ? out[i - stride - channels] : 0;
            const delta = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >>> 1 : paeth(a, b, c);
            out[i] = raw[offset + 1 + x] + delta;
        }
    }
    return out;
}

function chunk(name, body) {
    const data = Buffer.alloc(body.length + 12);
    data.writeUInt32BE(body.length); data.write(name, 4, 4, "latin1"); body.copy(data, 8);
    data.writeUInt32BE(crc.crc32(data.subarray(4, data.length - 4)) >>> 0, data.length - 4);
    return data;
}

function encode(pixels, width, height, channels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
    header[8] = 8; header[9] = channels === 1 ? 0 : 2;
    const stride = width * channels, scan = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        const offset = y * (stride + 1);
        scan[offset] = 1; // Sub filter preserves the small native file size.
        for (let x = 0; x < stride; x++) {
            const i = y * stride + x;
            scan[offset + 1 + x] = pixels[i] - (x >= channels ? pixels[i - channels] : 0);
        }
    }
    return Buffer.concat([PNG, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(scan)), chunk("IEND", Buffer.alloc(0))]);
}

// Connectivity and adjacency share the factory's four-neighbour geometry.
function topology(pixels, width, ids) {
    const graph = new Map(Array.from(ids, id => [id, new Set()]));
    const parts = new Uint32Array(64), seen = new Uint8Array(pixels.length), queue = new Int32Array(pixels.length);
    for (let start = 0; start < pixels.length; start++) {
        const id = pixels[start];
        if (!id || seen[start]) {
            continue;
        }
        check(ids.has(id), "unregistered native room ID");
        parts[id]++;
        let head = 0, tail = 1;
        seen[start] = 1; queue[0] = start;
        while (head < tail) {
            const p = queue[head++], x = p % width;
            for (const n of [x ? p - 1 : -1, x + 1 < width ? p + 1 : -1, p - width, p + width]) {
                if (n < 0 || n >= pixels.length || !pixels[n]) {
                    continue;
                }
                if (pixels[n] !== id) {
                    graph.get(id).add(pixels[n]);
                } else if (!seen[n]) {
                    seen[n] = 1; queue[tail++] = n;
                }
            }
        }
    }
    return {graph: graph, parts: parts};
}

function json(files, name) {
    const file = files[name];
    check(Buffer.isBuffer(file) && file.length <= 256 * 1024, "invalid " + name);
    return JSON.parse(file.toString("utf8"));
}

function nativeGeometry(files, mapSize, pixelSize) {
    check(mapSize?.x === 6554 && mapSize?.y === 6554 && pixelSize === 5, "unsupported SDK geometry");
    const roi = json(files, names.roi), width = roi.x_max - roi.x_min, height = roi.y_max - roi.y_min;
    check(roi.width === 3600 && roi.height === 3600 &&
        [roi.x_min, roi.x_max, roi.y_min, roi.y_max].every(v => Number.isInteger(v) && v >= 0 && v <= 3600) &&
        width > 0 && height > 0 && width * height <= MAX_PIXELS, "unsupported native ROI");
    // Native grid cell (1800,1800) corresponds to SDK cell (655,655).
    const left = roi.x_min - 1145, bottom = 2455 - roi.y_min;
    return {width: width, height: height, left: left, bottom: bottom, offset: function(x, y) {
        const col = x - left, row = bottom - y;
        return Number.isInteger(col) && Number.isInteger(row) && col >= 0 && col < width && row >= 0 && row < height ?
            row * width + col : -1;
    }};
}

function roomIdsFrom(rooms) {
    const roomIds = rooms.RoomIdAndColorLookUpTable?.RoomIds;
    check(Array.isArray(roomIds) && roomIds.length > 0 && roomIds.length <= 63 &&
        roomIds.every(id => Number.isInteger(id) && id >= 1 && id <= 63), "invalid native rooms");
    const ids = new Set(roomIds);
    check(ids.size === roomIds.length, "duplicate native rooms");
    return ids;
}

function nativeSource(files, mapSize, pixelSize) {
    const geometry = nativeGeometry(files, mapSize, pixelSize);
    const {width, height} = geometry;
    const rooms = json(files, names.rooms), ids = roomIdsFrom(rooms);
    return {...geometry, rooms: rooms, ids: ids,
        base: image(files[names.base], width, height, 1), obstacle: image(files[names.obstacle], width, height, 1),
        slam: image(files[names.slam], width, height, 1), contour: image(files[names.contour], width, height, 1)};
}

function paintable(source, i) {
    const base = source.base[i], obstacle = source.obstacle[i], label = obstacle & 127;
    return (base === 0 || source.ids.has(base)) && (label === 0 || source.ids.has(label)) &&
        [0, 99, 255].includes(source.slam[i]) && [0, 180, 255].includes(source.contour[i]);
}

function needsObservation(source, i) {
    return source.slam[i] !== 0 || source.contour[i] !== 255 || (source.obstacle[i] & 128) !== 0;
}

function paintedCell(to, from, original, palette) {
    // Stock unknown space: no label, unknown occupancy, gray contour, black diagnostic pixel.
    if (to === 0) {
        return {obstacle:0, slam:255, contour:180, color:0};
    }
    return {obstacle:to, slam:0, contour:255, color:
        original && from === to && original.obstacle === to ? original.color : palette.get(to)};
}

function roomPalette(ids, obstacle, color) {
    const palette = new Map();
    // Factory debug colours are constant per free-room ID, apart from white text labels.
    for (let p = 0; p < obstacle.length; p++) {
        const id = obstacle[p], rgb = color.readUIntBE(3 * p, 3);
        if (ids.has(id) && rgb !== 0xffffff) {
            check(!palette.has(id) || palette.get(id) === rgb, "unknown room colour encoding");
            palette.set(id, rgb);
        }
    }
    return palette;
}

function appendUnavailable(runs, x, y) {
    const i = runs.length - 3;
    if (i >= 0 && runs[i + 1] === y && runs[i] + runs[i + 2] === x) {
        runs[i + 2]++;
        return false;
    }
    runs.push(x, y, 1);
    return true;
}

/** Prepare replacements for an inactive native map transaction. This class
 * owns no files and never selects/reloads a floor or commands a cleaning run.
 * Caller must compare baselines and verify the planner readback separately.
 */
class D103CNNativeRoomMask {
    /** Independent pixel readback after the firmware republishes PNGs. Invalid
     * files throw; valid images with different room labels return false.
     * @param {Object<string, Buffer>} files
     * @param {{x: number, y: number}} mapSize
     * @param {number} pixelSize
     * @param {Array<{x:number,y:number,from:number,to:number,before?:{obstacle:number,slam:number,contour:number,color:number}}>} edits
     * @param {boolean} [restored]
     */
    static matches(files, mapSize, pixelSize, edits, restored = false) {
        check(Array.isArray(edits) && edits.length && edits.length <= 65536, "invalid readback cells");
        const {width, height, offset, base, obstacle, slam, contour, ids} = nativeSource(files, mapSize, pixelSize);
        const color = image(files[names.color], width, height, 3);
        const palette = roomPalette(ids, obstacle, color);
        return edits.every(({x, y, from, to, before}) => {
            const i = offset(x, y), target = restored ? from : to;
            if (i < 0 || base[i] !== target) {
                return false;
            }
            if (!before) { // A confirmed edit journal from v36.
                return obstacle[i] === target;
            }
            if (restored) {
                return obstacle[i] === before.obstacle && slam[i] === before.slam && contour[i] === before.contour &&
                    color.readUIntBE(3*i, 3) === before.color;
            }
            const filled = paintedCell(to, from, before, palette);
            return obstacle[i] === filled.obstacle && slam[i] === filled.slam && contour[i] === filled.contour &&
                color.readUIntBE(3*i, 3) === filled.color;
        });
    }

    static editableLayers(files, mapSize, pixelSize, templateLayers) {
        const s = nativeSource(files, mapSize, pixelSize);
        const WALL = 64, FLOOR = 65;
        const counts = new Uint32Array(66), labels = new Uint8Array(s.base.length);
        for (let i = 0; i < labels.length; i++) {
            // Keep the saved room/obstacle presentation. A brush can replace
            // a recognized stale observation even if the cell currently has no room.
            const room = s.obstacle[i];
            const blocked = (room & 128) || s.contour[i] === 0 || s.slam[i] === 99;
            const floor = s.contour[i] === 255 && s.slam[i] === 0;
            const code = s.ids.has(room) ? room : blocked ? WALL : floor ? FLOOR : 0;
            labels[i] = code;
            counts[code]++;
        }
        const groups = new Map();
        for (let id = 1; id < counts.length; id++) {
            if (counts[id]) {
                // MapLayer consumes sorted x/y pairs. Allocate them outside the
                // small V8 heap so a large floor does not exhaust the robot.
                groups.set(id, {points: new Int32Array(counts[id] * 2), n: 0, eligible: 0, unavailable: []});
            }
        }
        let runCount = 0;
        for (let row = s.height - 1; row >= 0; row--) {
            let last = 0;
            for (let col = 0; col < s.width; col++) {
                const i = row * s.width + col, code = labels[i];
                if (code) {
                    const group = groups.get(code), x = s.left + col, y = s.bottom - row;
                    check(x >= 0 && x < Math.ceil(mapSize.x / pixelSize) && y >= 0 && y < Math.ceil(mapSize.y / pixelSize),
                        "native floor extends outside the supported editor frame");
                    group.points[group.n++] = x;
                    group.points[group.n++] = y;
                    if (code !== last) {
                        runCount++;
                    }
                    if (s.ids.has(code)) {
                        if (paintable(s, i)) {
                            group.eligible++;
                        } else if (appendUnavailable(group.unavailable, x, y)) {
                            runCount++;
                        }
                    }
                }
                last = code;
            }
            check(runCount <= 150000, "native raster too fragmented to display");
        }
        return [...groups.entries()].map(([id, group]) => {
            const type = id === WALL ? MapLayer.TYPE.WALL : id === FLOOR ? MapLayer.TYPE.FLOOR : MapLayer.TYPE.SEGMENT;
            const metaData = {area:counts[id] * pixelSize * pixelSize};
            if (type === MapLayer.TYPE.SEGMENT) {
                // Only borrow the room name/material, never live geometry or masks.
                const label = templateLayers?.find(l => l.type === type && Number(l.metaData.segmentId) === id)?.metaData;
                Object.assign(metaData, {segmentId:String(id), name:label?.name, material:label?.material,
                    nativePaintablePixels:group.eligible});
                if (group.unavailable.length) {
                    Object.assign(metaData, {nativeUnavailableRuns:group.unavailable});
                }
            }
            return new MapLayer({type: type, pixels:group.points, metaData: metaData});
        });
    }

    static editsFromRuns(files, mapSize, pixelSize, runs, fineOccupied = undefined) {
        check(Array.isArray(runs) && runs.length > 0 && runs.length <= 4096, "invalid room brush runs");
        const s = nativeSource(files, mapSize, pixelSize), desired = new Map();
        let count = 0;
        for (const run of runs) {
            check(Array.isArray(run) && run.length === 4, "invalid native room stroke");
            const [x, y, n, paint] = run;
            check(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(n) && n > 0 &&
                typeof paint === "string" && /^(room|erase):[1-9]\d?$/.test(paint) && x >= 0 && y >= 0 &&
                x + n <= Math.ceil(mapSize.x / pixelSize) && y < Math.ceil(mapSize.y / pixelSize), "invalid native room stroke");
            const [tool, roomText] = paint.split(":");
            const room = Number(roomText);
            count += n;
            check(count <= 65536 && s.ids.has(room), "too many cells or invalid selected room");
            for (let cx = x; cx < x + n; cx++) {
                const i = s.offset(cx, y);
                check(i >= 0, "outside scanned native floor at " + cx + "," + y);
                if (tool === "room") {
                    desired.set(i, room);
                } else if ((desired.get(i) ?? s.base[i]) === room) {
                    // Erasing a draft extension over another room or a wall
                    // reveals that original cell. Never erase its underlying data.
                    if (s.base[i] === room && (s.obstacle[i] & 127) === room) {
                        desired.set(i, 0);
                    } else {
                        desired.delete(i);
                    }
                }
            }
        }
        /** @type {Array<{x:number,y:number,from:number,to:number,reopen:boolean,
         * before:{obstacle:number,slam:number,contour:number,color:number},
         * originalIslands?:Object<string,number>,roomFlags?:Object<string,boolean|null>,sdkBefore?:number}>} */
        const edits = [];
        const color = image(files[names.color], s.width, s.height, 3);
        for (const [i, to] of desired) {
            const x = s.left + i % s.width, y = s.bottom - Math.floor(i / s.width);
            const reopen = to !== 0 && (needsObservation(s, i) || !!fineOccupied?.(x, y));
            if (!reopen && s.obstacle[i] === to && s.base[i] === to) {
                continue;
            }
            check(paintable(s, i), "unrecognized native cell encoding at " + x + "," + y);
            edits.push({x:x, y:y, from:s.base[i], to:to, reopen:reopen,
                before:{obstacle:s.obstacle[i], slam:s.slam[i], contour:s.contour[i], color:color.readUIntBE(3*i, 3)}});
        }
        check(edits.length, "no selected room cells would change");
        // Keep sufficient pre-edit topology to undo a stroke that joins two
        // previously disconnected islands of the same factory room.
        const {parts} = topology(s.base, s.width, s.ids);
        edits[0].originalIslands = Object.fromEntries([...s.ids].filter(id => parts[id] > 1).map(id => [id, parts[id]]));
        if (!edits.some(e => e.reopen || e.to === 0)) {
            // v36 marked manual room-ID transfers. Preserve missing flags too,
            // because some factory tables predate is_user_edited.
            edits[0].roomFlags = Object.fromEntries(s.rooms.RoomNeighborTable.map(row => {
                check(row.is_user_edited === undefined || typeof row.is_user_edited === "boolean", "unknown room edit flag");
                return [row.room_id, row.is_user_edited ?? null];
            }));
        }
        return edits;
    }

    static prepare({files, mapSize, pixelSize, edits, restoring = false}) {
        check(Array.isArray(edits) && edits.length > 0 && edits.length <= 65536, "invalid number of room cells");
        const source = nativeSource(files, mapSize, pixelSize);
        const {width, height, rooms, ids, base, obstacle, slam, contour} = source;
        const table = rooms.RoomNeighborTable;
        check(Array.isArray(table) && table.length === ids.size, "invalid room table");
        const color = image(files[names.color], width, height, 3);
        const before = topology(base, width, ids);
        const knownRows = new Set(), palette = roomPalette(ids, obstacle, color);
        for (const row of table) {
            const neighbors = before.graph.get(row.room_id);
            check(neighbors && !knownRows.has(row.room_id) && Array.isArray(row.room_neighbor_id) &&
                neighbors.size === row.room_neighbor_id.length && new Set(row.room_neighbor_id).size === neighbors.size &&
                row.room_neighbor_id.every(id => neighbors.has(id)), "native adjacency and label image disagree");
            knownRows.add(row.room_id);
        }
        const touched = new Set(), changed = new Set();
        let baseChanged = false, obstacleChanged = false, colorChanged = false, slamChanged = false, contourChanged = false;
        for (const {x, y, from, to, before: original} of edits) {
            check(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(from) && (ids.has(from) || from === 0) &&
                (ids.has(to) || (to === 0 && ids.has(from) && original)) &&
                (original || from !== to), "use existing rooms");
            const p = source.offset(x, y);
            check(p >= 0 && !changed.has(p), "cell outside the selected floor or specified twice");
            const old = original ?? {obstacle:from, slam:0, contour:255, color:palette.get(from)};
            const filled = paintedCell(to, from, original, palette);
            const expected = restoring ? filled : old, write = restoring ? old : filled;
            check(paintable(source, p) && base[p] === (restoring ? to : from) && obstacle[p] === expected.obstacle &&
                slam[p] === expected.slam && contour[p] === expected.contour &&
                (!original || color.readUIntBE(3*p,3) === expected.color),
            "native cell changed since this edit at " + x + "," + y);
            check(Number.isSafeInteger(write.color), "missing native room colour");
            changed.add(p); touched.add(from); touched.add(to);
            const id = restoring ? from : to;
            baseChanged ||= base[p] !== id;
            obstacleChanged ||= obstacle[p] !== write.obstacle;
            colorChanged ||= color.readUIntBE(3*p, 3) !== write.color;
            base[p] = id;
            obstacle[p] = write.obstacle;
            slamChanged ||= slam[p] !== write.slam;
            contourChanged ||= contour[p] !== write.contour;
            slam[p] = write.slam;
            contour[p] = write.contour;
            color.writeUIntBE(write.color, 3*p, 3);
        }
        const after = topology(base, width, ids);
        let tableChanged = false;
        for (const row of table) {
            const id = row.room_id, next = after.graph.get(id);
            const permitted = Math.max(before.parts[id], restoring ? edits[0].originalIslands?.[id] ?? 0 : 0);
            check(after.parts[id] && after.parts[id] <= permitted, "stroke splits or removes room " + id);
            if (next.size !== row.room_neighbor_id.length || row.room_neighbor_id.some(n => !next.has(n))) {
                row.room_neighbor_id = Array.from(next).sort((a, b) => a - b);
                touched.add(id);
                tableChanged = true;
            }
            // A guessed occupancy correction must not pin this room. Native
            // label-only transfers retain the earlier manual-edit behaviour.
            if (touched.has(id) && (edits[0].roomFlags || !edits[0].before)) {
                const flag = restoring && edits[0].roomFlags ? edits[0].roomFlags[id] : true;
                if (row.is_user_edited !== (flag ?? undefined)) {
                    check(!restoring || row.is_user_edited === true, "room edit flag changed since this stroke");
                    if (flag === null) {
                        delete row.is_user_edited;
                    } else {
                        row.is_user_edited = flag;
                    }
                    tableChanged = true;
                }
            }
        }
        return {
            [names.base]: baseChanged ? encode(base, width, height, 1) : files[names.base],
            [names.obstacle]: obstacleChanged ? encode(obstacle, width, height, 1) : files[names.obstacle],
            [names.color]: colorChanged ? encode(color, width, height, 3) : files[names.color],
            ...(slamChanged ? {[names.slam]: encode(slam, width, height, 1)} : {}),
            ...(contourChanged ? {[names.contour]: encode(contour, width, height, 1)} : {}),
            [names.rooms]: tableChanged ? Buffer.from(JSON.stringify(rooms), "utf8") : files[names.rooms]
        };
    }
}

D103CNNativeRoomMask.files = Object.values(names);
D103CNNativeRoomMask.viewFiles = D103CNNativeRoomMask.files.filter(name => name !== names.color);
module.exports = D103CNNativeRoomMask;
