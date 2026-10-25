const crypto = require("crypto");
const fs = require("fs");
const MapLayer = require("../../entities/map/MapLayer");
const ValetudoMap = require("../../entities/map/ValetudoMap");

const ROOT = "/data/map";

/**
 * Decode the owner's actual ProbabilityGrid 1.4 file, not a robot emulator.
 * Layout verified against stock node_lidar_slam.so:
 * ProbabilityGrid::DeSerializeFromBuffer (0x1225a4), version-4 cells,
 * big-endian header/probability, bounded byte-RLE, AA BB / EE FF framing.
 * Saved occupancy only: no invented live pose, path, rooms or cleaned area.
 */
class D103CNSavedMap {
    /**
     * @param {Buffer} data
     * @param {{mapId: string, savedAt: string}} info
     * @returns {import("../../entities/map/ValetudoMap")}
     */
    static PARSE(data, info) {
        if (data.length < 31 || data.length > 8 * 1024 * 1024 || data.readUInt16BE(0) !== 0xaabb ||
            data.readUInt32BE(2) + 8 !== data.length || data.readUInt16BE(data.length - 2) !== 0xeeff ||
            data[6] !== 1 || data[7] !== 4 || data.readUInt16BE(8) !== 25 ||
            data.readUInt16BE(10) !== 8192 || data.readUInt16BE(12) !== 8192 || data.readUInt16BE(14) !== 4) {
            throw new Error("Unsupported or incomplete D103CN saved-map header");
        }
        const x0 = data.readUInt16BE(16), y0 = data.readUInt16BE(18);
        const x1 = data.readUInt16BE(20), y1 = data.readUInt16BE(22);
        const width = x1 - x0 + 1, height = y1 - y0 + 1;
        const length = data.readUInt32BE(25);
        if (x1 >= 8192 || y1 >= 8192 || width < 1 || height < 1 || width * height > 2 * 1024 * 1024 ||
            data[24] !== 1 || length + 31 !== data.length) {
            throw new Error("Unsupported D103CN saved-map bounds or encoding");
        }
        const raw = Buffer.alloc(width * height * 4);
        let offset = 0, repeat = 0;
        for (let i = 29; i < 29 + length; i++) {
            const value = data[i];
            if (repeat) {
                if (offset + repeat > raw.length) {
                    throw new Error("Saved-map RLE exceeds declared bounds");
                }
                raw.fill(value, offset, offset + repeat);
                offset += repeat;
                repeat = 0;
            } else if (value & 0x80) {
                repeat = value & 0x7f;
            } else {
                if (offset >= raw.length) {
                    throw new Error("Saved-map literal exceeds declared bounds");
                }
                raw[offset++] = value;
            }
        }
        if (repeat || offset !== raw.length) {
            throw new Error("Saved-map RLE length mismatch");
        }
        // Native 25-mm cells -> standard 5-cm display pixels. Occupied wins
        // inside each 2x2 cell so thin saved obstacles are not erased.
        // Native ProbabilityGrid Y grows upwards (FetchGridmapROI maps
        // increasing row indices to increasing world Y). Valetudo/canvas Y
        // grows downwards. Reflect cell indices within the 1024-cell window;
        // a rotation alone cannot correct this change of handedness.
        const left = Math.floor(x0 / 2), top = Math.floor(y0 / 2);
        const right = Math.floor(x1 / 2), bottom = Math.floor(y1 / 2);
        if (left < 1536 || top < 1536 || right >= 2560 || bottom >= 2560) {
            throw new Error("Saved map is outside the validated 51.2-m display window");
        }
        const floor = [], wall = [];
        for (let y = top; y <= bottom; y++) {
            for (let x = left; x <= right; x++) {
                let known = false, occupied = false;
                for (let dy = 0; dy < 2; dy++) {
                    for (let dx = 0; dx < 2; dx++) {
                        const nx = x * 2 + dx, ny = y * 2 + dy;
                        if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1) {
                            const p = raw.readUInt16BE(((ny - y0) * width + nx - x0) * 4);
                            if (p > 32767) {
                                throw new Error("Unsupported saved probability marker");
                            }
                            known ||= p > 0;
                            occupied ||= p >= 16384;
                        }
                    }
                }
                if (known) {
                    (occupied ? wall : floor).push(x - 1536, 2559 - y);
                }
            }
        }
        if (floor.length < 100 || wall.length < 10) {
            throw new Error("Saved map lacks a usable occupancy grid");
        }
        return new ValetudoMap({size: {x: 5120, y: 5120}, pixelSize: 5,
            layers: [new MapLayer({type: MapLayer.TYPE.FLOOR, pixels: floor}),
                new MapLayer({type: MapLayer.TYPE.WALL, pixels: wall})], entities: [],
            metaData: {source: "D103CN saved ProbabilityGrid", savedMapSnapshot: true,
                mapId: info.mapId, savedAt: info.savedAt, livePoseAvailable: false,
                displayTransform: "native-x, inverted-native-y",
                nativeResolutionMm: 25, nativeBounds: {x0: x0, y0: y0, x1: x1, y1: y1},
                sha256: crypto.createHash("sha256").update(data).digest("hex")}});
    }

    /**
     * @param {string|null} previous
     * @returns {{fingerprint: string, map: import("../../entities/map/ValetudoMap")}|null}
     */
    static READ_NEW(previous) {
        if (!fs.existsSync(ROOT)) {
            return null;
        }
        const ids = fs.readdirSync(ROOT).filter(n => /^\d{1,6}$/.test(n));
        if (ids.length > 64) {
            throw new Error("Too many local saved-map directories");
        }
        const candidates = [];
        for (const id of ids) {
            const folder = ROOT + "/" + id;
            const path = folder + "/fine_large.bin";
            if (fs.lstatSync(folder).isDirectory() && fs.existsSync(path)) {
                const stat = fs.lstatSync(path);
                if (stat.isFile() && !stat.isSymbolicLink() && stat.size >= 31 && stat.size <= 8 * 1024 * 1024) {
                    candidates.push({id: id, path: path, stat: stat});
                }
            }
        }
        candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        const selected = candidates[0];
        if (!selected) {
            return null;
        }
        const fingerprint = `${selected.id}:${selected.stat.ino}:${selected.stat.size}:${selected.stat.mtimeMs}`;
        if (fingerprint === previous) {
            return null;
        }
        const data = fs.readFileSync(selected.path);
        const after = fs.lstatSync(selected.path);
        if (after.ino !== selected.stat.ino || after.size !== selected.stat.size || after.mtimeMs !== selected.stat.mtimeMs) {
            throw new Error("Saved map changed while being read; retry next poll");
        }
        return {fingerprint: fingerprint,
            map: D103CNSavedMap.PARSE(data, {mapId: selected.id, savedAt: selected.stat.mtime.toISOString()})};
    }
}

module.exports = D103CNSavedMap;
