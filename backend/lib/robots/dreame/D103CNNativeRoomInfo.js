const D103CNProtocol = require("./D103CNProtocol");
const DreameMapParser = require("./DreameMapParser");
const zlib = require("zlib");

function check(condition, message) {
    if (!condition) {
        throw new Error("Native room information: " + message);
    }
}

// Replace only the requested top-level members. Other values (including
// opaque factory metadata, numeric literals, field order and whitespace)
// are copied byte-for-byte rather than round-tripped through JSON.stringify.
function replaceMembers(raw, replacements) {
    const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]|[^\s"{}[\],:]+/g;
    const next = () => {
        const token = tokens.exec(raw);
        check(token, "truncated JSON object");
        return token;
    };
    const seen = new Set(), parts = [];
    let copied = 0;
    check(next()[0] === "{", "expected object");
    for (;;) {
        const key = next()[0];
        if (key === "}") {
            break;
        }
        check(key.startsWith('"') && next()[0] === ":", "expected object member");
        const name = JSON.parse(key);
        const first = next();
        let depth = Number(first[0] === "{" || first[0] === "[");
        while (depth > 0) {
            const token = next()[0];
            depth += Number(token === "{" || token === "[") - Number(token === "}" || token === "]");
        }
        if (replacements.has(name)) {
            check(!seen.has(name), "duplicate field " + name);
            seen.add(name);
            parts.push(raw.slice(copied, first.index), replacements.get(name)(raw.slice(first.index, tokens.lastIndex)));
            copied = tokens.lastIndex;
        }
        const separator = next()[0];
        if (separator === "}") {
            break;
        }
        check(separator === ",", "invalid object members");
    }
    check(seen.size === replacements.size, "missing required room fields");
    parts.push(raw.slice(copied));
    return parts.join("");
}

function sameIds(a, b) {
    const ids = new Set(b);
    return a.length === b.length && b.length === ids.size && new Set(a).size === a.length && a.every(id => ids.has(id));
}

function readNeighbors(buf) {
    check(Buffer.isBuffer(buf) && buf.length <= 262144, "invalid neighbor table");
    const table = JSON.parse(buf.toString("utf8"));
    const ids = table.RoomIdAndColorLookUpTable?.RoomIds;
    check(Array.isArray(ids) && ids.length > 0 && ids.length < 62 &&
        ids.every(id => Number.isInteger(id) && id > 0 && id < 62) &&
        Array.isArray(table.RoomNeighborTable) && sameIds(ids, table.RoomNeighborTable.map(r => r.room_id)),
    "room IDs disagree in native neighbor table");
    const byId = new Map();
    for (const room of table.RoomNeighborTable) {
        const neighbors = room.room_neighbor_id;
        check(Array.isArray(neighbors) && new Set(neighbors).size === neighbors.length &&
            neighbors.every(n => n !== room.room_id && ids.includes(n)), "invalid neighbor IDs");
        byId.set(room.room_id, neighbors);
    }
    for (const [id, neighbors] of byId) {
        check(neighbors.every(n => byId.get(n).includes(id)), "asymmetric native neighbor table");
    }
    return byId;
}

function editRoomMetadata(raw, topology) {
    const info = JSON.parse(raw);
    check(sameIds(Object.keys(info).map(Number), [...topology.keys()]), "saved rooms differ from divider");
    const replacements = new Map();
    for (const [id, neighbors] of topology) {
        const old = info[id]?.nei_id;
        check(Array.isArray(old), "missing saved room neighbors");
        if (!sameIds(old, neighbors)) {
            replacements.set(String(id), object => replaceMembers(object, new Map([
                ["nei_id", () => JSON.stringify([...neighbors].sort((a, b) => a - b))]
            ])));
        }
    }
    return replacements.size ? replaceMembers(raw, replacements) : raw;
}

function unpack(encoded) {
    check(typeof encoded === "string" && /^[A-Za-z\d_-]+={0,2}$/.test(encoded),
        "requires a stock local unencrypted base64url I-frame");
    const buffer = D103CNProtocol.decodeMapEnvelope(encoded);
    const header = DreameMapParser.PARSE_HEADER(buffer);
    const count = header.width * header.height;
    check(count <= 1024 * 1024 && header.pixelSize === 5 && buffer.readInt16LE(17) === 50, "unsupported native resolution");
    const metadata = buffer.subarray(27 + count).toString("utf8");
    return {header: header, binary: buffer.subarray(0, 27 + count), metadata: metadata, json: JSON.parse(metadata)};
}

function pack(frame, metadata) {
    return zlib.deflateSync(Buffer.concat([frame.binary, Buffer.from(metadata)]), {level: 3})
        .toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

// Mirrors PARSE_IMAGE: the SDK frame stores rows bottom-up; Valetudo uses
// rounded cell indices with its origin in the top-left.
function offsetFor(header, mapSize, pixelSize, x, y) {
    const col = x - Math.round(header.left / pixelSize);
    const row = Math.round((mapSize.y - header.top) / pixelSize) - y;
    return col >= 0 && col < header.width && row >= 0 && row < header.height ? 27 + row * header.width + col : -1;
}

/**
 * Prepare a stock RI member. This module never installs a map or runs an action.
 * @param {Buffer} riBuffer
 * @param {{x:number,y:number}} mapSize
 * @param {number} pixelSize
 * @param {Array<{x:number,y:number,from:number,to:number,before?:{obstacle:number},ri?:number[]}>} edits
 * @param {Buffer} newNeighborTableBuffer
 * @param {boolean} [restoring]
 * @returns {Buffer}
 */
function prepare(riBuffer, mapSize, pixelSize, edits, newNeighborTableBuffer, restoring = false) {
    check(Buffer.isBuffer(riBuffer) && riBuffer.length <= 8 * 1024 * 1024, "invalid RI size");
    check(pixelSize === 5 && mapSize?.x === 6554 && mapSize?.y === 6554, "unknown SDK coordinate frame");
    check(Array.isArray(edits) && edits.length > 0 && edits.length <= 65536, "invalid cell batch");
    const raw = riBuffer.toString("utf8");
    const ri = JSON.parse(raw);
    const topology = readNeighbors(newNeighborTableBuffer);
    const outer = unpack(ri.last_app_map);
    const inner = unpack(outer.json.rism);
    check(Number.isInteger(ri.last_app_map_id) && ri.last_app_map_id === inner.header.id, "saved floor identity mismatch");
    const sameFloor = Number(outer.json.curid) === ri.last_app_map_id && outer.json.ris === 2;
    if (!sameFloor) {
        check(!outer.binary.subarray(27).some(sample => (sample >> 2) > 0 && (sample >> 2) < 62),
            "outer frame contains rooms with an unverified floor origin");
    }
    const savedInfo = JSON.parse(ri.seg_info);
    for (const id of topology.keys()) {
        const primary = savedInfo[id]?.nei_id, copy = inner.json.seg_inf?.[id]?.nei_id;
        check(Array.isArray(primary) && Array.isArray(copy) && sameIds(primary, copy),
            "saved room-neighbor copies disagree");
    }
    const seen = new Set();
    for (const edit of edits) {
        const {x, y, from, to} = edit;
        check(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < Math.ceil(mapSize.x/pixelSize) &&
            y >= 0 && y < Math.ceil(mapSize.y/pixelSize) && (topology.has(from) || (from === 0 && edit.before)) && topology.has(to),
        "invalid room-cell transition");
        const offset = offsetFor(inner.header, mapSize, pixelSize, x, y);
        check(offset >= 27 && !seen.has(offset), "cell outside saved room image or specified twice");
        seen.add(offset);
        const byte = inner.binary[offset];
        // The RISM uses bit 7 for walls and bit 6 for carpet; the outer
        // (live) frame uses a different code. On this firmware an observed
        // wall can be 0xfc in the outer frame and 0x80|room in the RISM.
        // Only project into an outer frame that identifies this same floor.
        const live = sameFloor ? offsetFor(outer.header, mapSize, pixelSize, x, y) : -1;
        const sample = live < 27 ? -1 : outer.binary[live];
        if (!edit.before) {
            // Existing v36 journals only ever changed observed room labels.
            const src = restoring ? to : from, dest = restoring ? from : to;
            check((byte & 191) === src, "saved room differs or cell is a wall");
            inner.binary[offset] = (byte & 64) | dest;
            if (sample >= 0 && sample !== 0) {
                check((sample >> 2) === src, "live and saved room labels disagree");
                outer.binary[live] = (dest << 2) | (sample & 3);
            }
            continue;
        }
        if (!restoring) {
            check((byte & 191) === edit.before.obstacle, "saved room and divider disagree at the brush mark");
            const segment = sample >> 2;
            check(sample < 0 || sample === 0 || segment === from || segment === 62 || segment === 63,
                "another room occupies the live frame at this brush mark");
            edit.ri = [byte, sample];
        }
        check(Array.isArray(edit.ri) && edit.ri.length === 2, "missing original saved cell");
        const [oldSaved, oldLive] = edit.ri;
        const paintedSaved = (oldSaved & 64) | to;
        // Reproduce the regular frame's observed per-room encoding. For
        // unsegmented space keep carpet if present, discard its obstacle type.
        const paintedLive = oldLive < 0 ? -1 : (to << 2) |
            ((oldLive >> 2) > 0 && (oldLive >> 2) < 62 ? oldLive & 3 : Number((oldLive & 3) === 3) * 3);
        check(!restoring || (byte === paintedSaved && sample === paintedLive),
            "the robot has rescanned this cell; its newer saved or live reading was kept");
        inner.binary[offset] = restoring ? oldSaved : paintedSaved;
        if (live >= 27) {
            outer.binary[live] = restoring ? oldLive : paintedLive;
        }
    }
    const innerMeta = replaceMembers(inner.metadata, new Map([
        ["seg_inf", value => editRoomMetadata(value, topology)]
    ]));
    const outerChanges = new Map([["rism", () => JSON.stringify(pack(inner, innerMeta))]]);
    if (Object.hasOwn(outer.json, "seg_inf")) {
        check(Number(outer.json.curid) === ri.last_app_map_id, "unbound outer room metadata");
        outerChanges.set("seg_inf", value => editRoomMetadata(value, topology));
    }
    const outerMeta = replaceMembers(outer.metadata, outerChanges);
    const result = replaceMembers(raw, new Map([
        ["last_app_map", () => JSON.stringify(pack(outer, outerMeta))],
        ["seg_info", value => JSON.stringify(editRoomMetadata(JSON.parse(value), topology))]
    ]));
    return Buffer.from(result);
}

module.exports = {prepare: prepare};
