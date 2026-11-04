const crc = require("crc");
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
     * @param {Array<{x: number,y: number,from: number,to: number}>} edits
     * @param {boolean} [restored]
     */
    static matches(files, mapSize, pixelSize, edits, restored = false) {
        check(mapSize?.x === 6554 && mapSize?.y === 6554 && pixelSize === 5, "unsupported SDK geometry");
        check(Array.isArray(edits) && edits.length && edits.length <= 65536, "invalid readback cells");
        const roi = json(files, names.roi), width = roi.x_max - roi.x_min, height = roi.y_max - roi.y_min;
        check(roi.height === 3600 && roi.width === 3600 && [roi.x_min, roi.x_max, roi.y_min, roi.y_max].every(
            v => Number.isInteger(v) && v >= 0 && v <= 3600) && width > 0 && height > 0 && width * height <= MAX_PIXELS,
        "unsupported native ROI");
        const base = image(files[names.base], width, height, 1), obstacle = image(files[names.obstacle], width, height, 1);
        return edits.every(({x, y, from, to}) => {
            const col = x + 1145 - roi.x_min, row = 2455 - y - roi.y_min, target = restored ? from : to;
            return Number.isInteger(x) && Number.isInteger(y) && col >= 0 && col < width && row >= 0 && row < height &&
                base[row * width + col] === target && obstacle[row * width + col] === target;
        });
    }

    static prepare({files, mapSize, pixelSize, edits}) {
        check(mapSize?.x === 6554 && mapSize?.y === 6554 && pixelSize === 5, "unsupported SDK geometry");
        check(Array.isArray(edits) && edits.length > 0 && edits.length <= 65536, "invalid number of room cells");
        const roi = json(files, names.roi), rooms = json(files, names.rooms);
        const width = roi.x_max - roi.x_min, height = roi.y_max - roi.y_min;
        check(roi.width === 3600 && roi.height === 3600 &&
            [roi.x_min, roi.x_max, roi.y_min, roi.y_max].every(v => Number.isInteger(v) && v >= 0 && v <= 3600) &&
            width > 0 && height > 0 && width * height <= MAX_PIXELS, "unsupported native ROI");
        const roomIds = rooms.RoomIdAndColorLookUpTable?.RoomIds;
        check(Array.isArray(roomIds) && roomIds.length > 0 && roomIds.length <= 63 &&
            roomIds.every(id => Number.isInteger(id) && id >= 1 && id <= 63), "invalid native rooms");
        const ids = new Set(roomIds), table = rooms.RoomNeighborTable;
        check(ids.size === roomIds.length && Array.isArray(table) && table.length === ids.size, "invalid room table");
        const base = image(files[names.base], width, height, 1), obstacle = image(files[names.obstacle], width, height, 1);
        const slam = image(files[names.slam], width, height, 1), contour = image(files[names.contour], width, height, 1);
        const color = image(files[names.color], width, height, 3);
        const before = topology(base, width, ids);
        const knownRows = new Set(), palette = new Map();
        for (const row of table) {
            const neighbors = before.graph.get(row.room_id);
            check(neighbors && !knownRows.has(row.room_id) && Array.isArray(row.room_neighbor_id) &&
                neighbors.size === row.room_neighbor_id.length && new Set(row.room_neighbor_id).size === neighbors.size &&
                row.room_neighbor_id.every(id => neighbors.has(id)), "native adjacency and label image disagree");
            knownRows.add(row.room_id);
        }
        // Factory debug colour images use per-room colours with white text.
        for (let p = 0; p < obstacle.length; p++) {
            const id = obstacle[p], rgb = color.readUIntBE(3 * p, 3);
            if (ids.has(id) && rgb !== 0xffffff) {
                check(!palette.has(id) || palette.get(id) === rgb, "unknown room colour encoding");
                palette.set(id, rgb);
            }
        }
        const touched = new Set(), changed = new Set();
        for (const {x, y, from, to} of edits) {
            check(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(from) && (ids.has(from) || from === 0) &&
                ids.has(to) && from !== to, "use existing destination rooms");
            // Native cell (1800,1800) is SDK cell (655,655); native Y grows up.
            const col = x + 1145 - roi.x_min, row = 2455 - y - roi.y_min;
            check(col >= 0 && col < width && row >= 0 && row < height, "paint extends beyond the selected floor");
            const p = row * width + col;
            check(!changed.has(p) && base[p] === from && obstacle[p] === from,
                "cell changed, unsegmented or marked as an obstacle at " + x + "," + y);
            check(slam[p] === 0 && contour[p] === 255,
                "room includes an unobserved or blocked navigation cell at " + x + "," + y);
            check(palette.has(to), "missing native room colour");
            changed.add(p); touched.add(from); touched.add(to);
            base[p] = to; obstacle[p] = to;
            color.writeUIntBE(palette.get(to), 3 * p, 3);
        }
        const after = topology(base, width, ids);
        for (const row of table) {
            const id = row.room_id, next = after.graph.get(id);
            check(after.parts[id] && after.parts[id] <= before.parts[id], "stroke splits or removes room " + id);
            if (next.size !== row.room_neighbor_id.length || row.room_neighbor_id.some(n => !next.has(n))) {
                row.room_neighbor_id = Array.from(next).sort((a, b) => a - b);
                touched.add(id);
            }
            if (touched.has(id)) {
                row.is_user_edited = true;
            }
        }
        return {
            [names.base]: encode(base, width, height, 1),
            [names.obstacle]: encode(obstacle, width, height, 1),
            [names.color]: encode(color, width, height, 3),
            [names.rooms]: Buffer.from(JSON.stringify(rooms), "utf8")
        };
    }
}

D103CNNativeRoomMask.files = Object.values(names);
module.exports = D103CNNativeRoomMask;
