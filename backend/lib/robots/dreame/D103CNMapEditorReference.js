const D103CNProtocol = require("./D103CNProtocol");
const DreameMapParser = require("./DreameMapParser");
const fs = require("fs");
const path = require("path");

function statVersion(stat) {
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

/** Bind editor geometry to a native floor even when an SDK frame retains the
 * previous curid. The selected floor's own RI file contains its saved room
 * raster. Checking only the set of room IDs confuses similarly numbered floors.
 */
class D103CNMapEditorReference {
    constructor(nativeData = "/data") {
        this.nativeData = nativeData;
        this.cached = null;
    }

    /** @param {number} floorId */
    get(floorId) {
        if (!Number.isSafeInteger(floorId) || floorId < 0 || floorId > 999999) {
            throw new Error("Invalid native map ID");
        }
        const folder = path.join(this.nativeData, "map", String(floorId));
        const file = path.join(this.nativeData, "ri", floorId + ".dat2");
        const dir = fs.lstatSync(folder), stat = fs.lstatSync(file);
        if (!dir.isDirectory() || !stat.isFile() || stat.size < 2 || stat.size > 8 * 1024 * 1024) {
            throw new Error("Invalid native floor reference");
        }
        // Old stock kernels lack statx and libuv substitutes ctime for birthtime.
        // Directory ctime changes when the robot saves. The directory inode
        // survives those saves and reboots; RI stat only invalidates the cache.
        const identity = floorId + "-" + dir.ino;
        const version = statVersion(stat);
        if (identity !== this.cached?.identity || version !== this.cached.version) {
            const ri = JSON.parse(fs.readFileSync(file, "utf8"));
            if (typeof ri.last_app_map !== "string" || !ri.last_app_map) {
                throw new Error("Missing native saved frame");
            }
            const matches = D103CNMapEditorReference.fromStoredMap(ri.last_app_map);
            const after = fs.lstatSync(folder);
            if (statVersion(fs.lstatSync(file)) !== version ||
                after.ino !== dir.ino || after.birthtimeMs !== dir.birthtimeMs) {
                throw new Error("Native floor changed while reading");
            }
            this.cached = {identity: identity, version: version, matches: matches};
        }
        return this.cached;
    }

    /** Derive distributed anchor pixels in each saved room. All matching uses
     * unedited native pixels. A single doorway or matching centroid is not
     * sufficient to identify a room.
     * @param {string} envelope
     */
    static fromStoredMap(envelope) {
        const frame = D103CNProtocol.decodeMapEnvelope(envelope);
        const jsonOffset = 27 + frame.readInt16LE(19) * frame.readInt16LE(21);
        const rism = JSON.parse(frame.subarray(jsonOffset).toString("utf8")).rism;
        if (typeof rism !== "string" || !rism) {
            throw new Error("Missing native room raster");
        }
        const saved = D103CNProtocol.decodeMapEnvelope(rism);
        const header = DreameMapParser.PARSE_HEADER(saved);
        const count = header.width * header.height;
        if (!count || count > 1024 * 1024 || header.pixelSize !== 5) {
            throw new Error("Unsupported native room raster");
        }
        const pixels = saved.subarray(27, 27 + count);
        const counts = new Uint32Array(64), seen = new Uint32Array(64);
        const anchors = new Map();
        for (const pixel of pixels) {
            if (!(pixel & 128)) {
                counts[pixel & 63]++;
            }
        }
        for (let i = 0; i < count; i++) {
            const pixel = pixels[i], id = pixel & 63;
            if (!id || (pixel & 128)) {
                continue;
            }
            const stride = Math.max(1, Math.ceil(counts[id] / 128));
            if (seen[id]++ % stride !== Math.floor(stride / 2)) {
                continue;
            }
            if (!anchors.has(id)) {
                anchors.set(id, []);
            }
            anchors.get(id).push([i % header.width, Math.floor(i / header.width)]);
        }
        if (!anchors.size) {
            throw new Error("Native reference has no rooms");
        }
        /** @param {import("../../entities/map/ValetudoMap")} map
         * @param {Uint8Array} raster Native editor raster (segment codes start at 3 + ID)
         * @param {number} width */
        return (map, raster, width) => {
            const rooms = map.layers.filter(layer => layer.type === "segment");
            if (map.pixelSize !== header.pixelSize || rooms.length !== anchors.size ||
                !rooms.every(room => anchors.has(Number(room.metaData.segmentId)))) {
                return false;
            }
            // Same cell-matrix origin, Y reflection and rounding as PARSE_IMAGE.
            const left = Math.round(header.left / map.pixelSize);
            const top = Math.round((map.size.y - header.top) / map.pixelSize);
            const height = Math.floor(raster.length / width);
            let matched = 0, total = 0;
            for (const [id, samples] of anchors) {
                let hits = 0;
                for (const [col, row] of samples) {
                    const x = left + col, y = top - row;
                    if (x >= 0 && x < width && y >= 0 && y < height && raster[y * width + x] === 3 + id) {
                        hits++;
                    }
                }
                // Room edges can change between the last save and a live scan.
                if (hits < samples.length * 0.7) {
                    return false;
                }
                total += samples.length;
                matched += hits;
            }
            return matched >= total * 0.85;
        };
    }
}

module.exports = D103CNMapEditorReference;
