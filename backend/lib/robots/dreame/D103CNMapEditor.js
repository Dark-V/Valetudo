const crypto = require("crypto");
const D103CNDoorways = require("./D103CNDoorways");
const D103CNMapEditorReference = require("./D103CNMapEditorReference");
const fs = require("fs");
const LineMapEntity = require("../../entities/map/entities/LineMapEntity");
const Logger = require("../../Logger");
const MapLayer = require("../../entities/map/MapLayer");
const path = require("path");

const DIRECTORY = "/data/.valetudo/map-editor";
const MAX_CELLS = 65536;
const UNKNOWN = 0, FLOOR = 1, WALL = 2, ROOM_OFFSET = 3;

function requireValue(condition, message, status = 400) {
    if (!condition) {
        throw Object.assign(new Error(message), {status: status});
    }
}

function layerCode(layer) {
    if (layer.type === "segment") {
        return ROOM_OFFSET + Number(layer.metaData.segmentId);
    }
    return layer.type === "wall" ? WALL : FLOOR;
}

function paintCode(name, rooms) {
    switch (name) {
        case "native": return -1;
        case "unknown": return UNKNOWN;
        case "floor": return FLOOR;
        case "wall": return WALL;
        default: {
            requireValue(typeof name === "string" && /^room:[1-9]\d?$/.test(name), "Invalid brush");
            const code = ROOM_OFFSET + Number(name.slice(5));
            requireValue(rooms.has(code), "This room is missing from the native map", 409);
            return code;
        }
    }
}

function checkDoors(doors, size) {
    requireValue(Array.isArray(doors) && doors.length <= 128, "Invalid door list");
    const ids = new Set();
    return doors.map(door => {
        requireValue(door && typeof door.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(door.id) &&
            !ids.has(door.id), "Door IDs must be valid and unique");
        requireValue(["open", "closed", "unknown"].includes(door.state), "Invalid manual door state");
        requireValue(Array.isArray(door.points) && door.points.length === 4 && door.points.every((n, i) =>
            Number.isInteger(n) && n >= 0 && n < (i % 2 ? size.y : size.x)), "Door outside map");
        const [x, y, x1, y1] = door.points;
        requireValue(x !== x1 || y !== y1, "Door must have two distinct endpoints");
        ids.add(door.id);
        return {id: door.id, state: door.state, points: [...door.points]};
    });
}

// Geometry alone drives conflicts. Pose, path, the per-frame nonce and active
// room indicators change while an otherwise identical map is being edited.
function geometryHash(map) {
    const hash = crypto.createHash("sha256");
    const layers = [...map.layers].sort((a, b) => layerCode(a) - layerCode(b));
    for (const layer of layers) {
        hash.update(layerCode(layer) + ":" + layer.compressedPixels.length + ":");
        hash.update(Buffer.from(Uint32Array.from(layer.compressedPixels).buffer));
    }
    // An editor may also submit a native virtual restriction against this
    // snapshot. Include its geometry without invalidating on robot motion.
    const barriers = map.entities.filter(e => ["virtual_wall", "no_go_area", "no_mop_area"].includes(e.type))
        .map(e => e.type + ":" + e.points.join(",")).sort();
    hash.update(JSON.stringify(barriers));
    return hash.digest("hex");
}

// A bounded native raster is only needed when reading brush baselines.
// Rooms may overlay floor in SDK frames that include both live and saved data.
function rasterFor(map, width, height) {
    const raster = new Uint8Array(width * height);
    const ordered = [...map.layers].sort((a, b) => {
        const rank = l => l.type === "floor" ? 0 : l.type === "wall" ? 2 : 1;
        return rank(a) - rank(b);
    });
    for (const layer of ordered) {
        const code = layerCode(layer);
        const pixels = layer.compressedPixels;
        for (let i = 0; i < pixels.length; i += 3) {
            const x = pixels[i], y = pixels[i + 1], length = pixels[i + 2];
            requireValue(x >= 0 && y >= 0 && y < height && length > 0 && x + length <= width,
                "Native raster lies outside the map");
            raster.fill(code, y * width + x, y * width + x + length);
        }
    }
    return raster;
}

function editedLayers(map, width, cells) {
    if (!cells.size) {
        return map.layers;
    }
    const additions = new Map(), carpets = new Map();
    for (const [index, [, target]] of cells) {
        if (target !== UNKNOWN) {
            if (!additions.has(target)) {
                additions.set(target, []);
            }
            additions.get(target).push(index);
        }
    }
    // Move the native carpet mask along with the floor when reassigning rooms.
    for (const layer of map.layers) {
        const source = layerCode(layer);
        const mask = layer.metaData.carpetPixels || [];
        for (let i = 0; i < mask.length; i += 2) {
            const index = mask[i + 1] * width + mask[i];
            const target = cells.get(index)?.[1] ?? source;
            if (target === WALL || target === UNKNOWN) {
                continue;
            }
            if (!carpets.has(target)) {
                carpets.set(target, new Set());
            }
            carpets.get(target).add(index);
        }
    }
    const layers = [];
    const codes = new Set([...map.layers.map(layerCode), ...additions.keys()]);
    for (const code of codes) {
        const layer = map.layers.find(l => layerCode(l) === code);
        const indices = [...(additions.get(code) || [])];
        const rle = layer?.compressedPixels || [];
        let changed = indices.length > 0;
        for (let i = 0; i < rle.length; i += 3) {
            const start = rle[i + 1] * width + rle[i];
            for (let j = start; j < start + rle[i + 2]; j++) {
                if (cells.has(j)) {
                    changed = true;
                } else {
                    indices.push(j);
                }
            }
        }
        if (!changed && layer) {
            layers.push(layer);
            continue;
        }
        if (!indices.length) {
            continue;
        }
        const pairs = values => values.sort((a, b) => a - b).flatMap(n => [n % width, Math.floor(n / width)]);
        const metaData = {...layer?.metaData};
        delete metaData.carpetPixels;
        if (carpets.has(code)) {
            metaData.carpetPixels = pairs([...carpets.get(code)]);
        }
        metaData.area = indices.length * map.pixelSize ** 2;
        layers.push(new MapLayer({type: layer?.type ?? (code === WALL ? "wall" : "floor"),
            metaData: metaData, pixels: pairs(indices)}));
    }
    return layers;
}

function sameDoor(a, b, tolerance) {
    const near = (u, v) => Math.hypot(a[u] - b[v], a[u + 1] - b[v + 1]) <= tolerance;
    return (near(0, 0) && near(2, 2)) || (near(0, 2) && near(2, 0));
}

function survivingCells(cells, current) {
    const retained = new Map(cells);
    for (const [index, [baseline, target]] of cells) {
        if (current.raster[index] !== baseline || (target >= ROOM_OFFSET && !current.rooms.has(target))) {
            retained.delete(index);
        }
    }
    return retained;
}

class D103CNMapEditor {
    constructor(directory = DIRECTORY, nativeData = "/data") {
        this.directory = directory;
        this.selectionPath = path.join(nativeData, "ri", "config.json2");
        this.reference = new D103CNMapEditorReference(nativeData);
        this.current = null;
        this.file = null;
        this.data = null;
    }

    /** @param {import("../../entities/map/ValetudoMap")} map */
    observe(map) {
        const previous = this.current;
        this.current = null;
        if (map.metaData.unlocalizedScan || map.metaData.relocalizationRequired || map.metaData.dreamePendingMapChange ||
            map.metaData.source === "D103CN saved ProbabilityGrid" || map.pixelSize !== 5 || !map.getSegments().length) {
            return;
        }
        try {
            const floorId = D103CNDoorways.READ_JSON(this.selectionPath).curr_id;
            requireValue(Number.isInteger(floorId) && floorId >= 0 && floorId <= 999999 &&
                (map.metaData.doorways?.nativeMapId === undefined || map.metaData.doorways.nativeMapId === floorId),
            "No stable selected floor", 409);
            const width = Math.ceil(map.size.x / map.pixelSize), height = Math.ceil(map.size.y / map.pixelSize);
            requireValue(width > 0 && height > 0 && width * height <= 4 * 1024 * 1024, "Unsupported raster size");
            const reference = this.reference.get(floorId);
            const file = path.join(this.directory, reference.identity + ".json");
            if (this.file !== file) {
                const data = this.load(file, width, height, map.size);
                this.file = file;
                this.data = data;
            }
            requireValue(this.data.width === width && this.data.height === height, "Stored map dimensions differ");
            const current = {floorId: floorId, width: width, height: height, map: map, hash: geometryHash(map), raster: null,
                identity: reference.identity, referenceVersion: reference.version,
                rooms: new Set(map.layers.filter(l => l.type === "segment").map(layerCode))};
            if (previous?.floorId === floorId && previous.identity === reference.identity && previous.hash === current.hash &&
                previous.referenceVersion === reference.version) {
                current.raster = previous.raster;
            } else {
                current.raster = rasterFor(map, width, height);
                requireValue(reference.matches(map, current.raster, width),
                    "SDK map geometry does not match the selected native floor", 409);
            }
            if (this.data.cells.size && current.raster !== previous?.raster) {
                const retained = survivingCells(this.data.cells, current);
                if (retained.size !== this.data.cells.size) {
                    this.save({...this.data, cells: retained});
                }
            }
            this.current = current;
            this.render();
        } catch (err) {
            this.current = null;
            Logger.warn("D103CN map editor unavailable", err.message);
        }
    }

    load(file, width, height, size) {
        const empty = {width: width, height: height, revision: "0", cells: new Map(), doors: []};
        let stat;
        try {
            stat = fs.lstatSync(file);
        } catch (err) {
            if (err.code === "ENOENT") {
                return empty;
            }
            throw err;
        }
        requireValue(stat.isFile() && stat.size > 0 && stat.size <= 4 * 1024 * 1024, "Invalid map edits file");
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        requireValue(value.version === 1 && value.width === width && value.height === height &&
            typeof value.revision === "string" && value.revision.length <= 64 &&
            Array.isArray(value.cells) && value.cells.length <= MAX_CELLS, "Unsupported map edits file");
        const cells = new Map();
        for (const row of value.cells) {
            requireValue(Array.isArray(row) && row.length === 3 && row.every(Number.isInteger) &&
                row[0] >= 0 && row[0] < width * height && !cells.has(row[0]) &&
                row.slice(1).every(code => code >= 0 && code <= ROOM_OFFSET + 63), "Invalid stored cell");
            cells.set(row[0], [row[1], row[2]]);
        }
        return {width: width, height: height, revision: value.revision, cells: cells, doors: checkDoors(value.doors, size)};
    }

    save(data) {
        const revision = crypto.randomUUID();
        const temp = this.file + "." + revision + ".tmp";
        fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
        try {
            const fd = fs.openSync(temp, "wx", 0o600);
            try {
                fs.writeFileSync(fd, JSON.stringify({version: 1, width: data.width, height: data.height, revision: revision,
                    cells: Array.from(data.cells, ([index, pair]) => [index, ...pair]), doors: data.doors}));
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(temp, this.file);
            // The commit is visible once renamed, including if directory fsync fails.
            this.data = {...data, revision: revision};
            try {
                const dir = fs.openSync(this.directory, "r");
                try {
                    fs.fsyncSync(dir);
                } finally {
                    fs.closeSync(dir);
                }
            } catch (err) {
                Logger.warn("D103CN map edit committed, directory sync failed", err.message);
            }
        } finally {
            if (fs.existsSync(temp)) {
                fs.unlinkSync(temp);
            }
        }
    }

    revision() {
        return this.current.identity + "." + this.current.hash + "." + this.data.revision;
    }

    describe(map) {
        requireValue(this.current && this.current.map === map, "Wait for a localized map on the selected floor", 409);
        return {floorId: this.current.floorId, revision: this.revision(), pixelSize: map.pixelSize,
            doors: this.data.doors, editedCells: this.data.cells.size,
            rooms: map.getSegments().map(room => ({id: String(room.id), name: room.name || String(room.id)}))};
    }

    requireRevision(map, floorId, revision) {
        const old = this.describe(map);
        requireValue(floorId === old.floorId && revision === old.revision,
            "Map geometry or edits changed. Reload before saving.", 409);
        // The native floor can switch before the SDK delivers its next frame.
        requireValue(D103CNDoorways.READ_JSON(this.selectionPath).curr_id === old.floorId,
            "Native floor changed. Wait for its current map.", 409);
        const reference = this.reference.get(floorId);
        requireValue(reference.identity === this.current.identity && reference.matches(map, this.current.raster, this.current.width),
            "Native floor geometry changed. Reload before saving.", 409);
    }

    // Called only after the restore transaction verified the native floor.
    // Normal floor switches and deletion/recreation never inherit another map's edits.
    inheritRestoredFloor(map, oldIdentity) {
        const snapshot = this.describe(map);
        this.requireRevision(map, snapshot.floorId, snapshot.revision);
        requireValue(typeof oldIdentity === "string" && /^(0|[1-9]\d{0,5})-\d{1,20}$/.test(oldIdentity) &&
            oldIdentity.split("-")[0] === String(snapshot.floorId), "Previous floor identity does not match this floor", 409);
        const {identity, width, height} = this.current;
        if (oldIdentity === identity) {
            return;
        }
        const old = this.load(path.join(this.directory, oldIdentity + ".json"), width, height, map.size);
        const cells = survivingCells(old.cells, this.current);
        // Read the target again. A retry after a completed migration is harmless;
        // independent owner edits (including an explicit deletion) win.
        const target = this.load(this.file, width, height, map.size);
        const identical = target.cells.size === cells.size &&
            [...cells].every(([index, pair]) => {
                const actual = target.cells.get(index);
                return actual && actual[0] === pair[0] && actual[1] === pair[1];
            }) && JSON.stringify(target.doors) === JSON.stringify(old.doors);
        if (identical) {
            if (this.data.revision !== target.revision) {
                this.data = target;
                this.render();
            }
            return;
        }
        requireValue(target.revision === "0" && !target.cells.size && !target.doors.length,
            "Restored floor already has separate owner edits; refusing to overwrite them", 409);
        this.save({...target, cells: cells, doors: old.doors});
        this.render();
    }

    update(map, body) {
        this.requireRevision(map, body?.floorId, body?.revision);
        requireValue(body.runs !== undefined || body.doors !== undefined, "No edits specified");
        const runs = body.runs === undefined ? [] : body.runs;
        requireValue(Array.isArray(runs) && runs.length <= 4096, "Too many brush runs");
        const doors = body.doors === undefined ? this.data.doors : checkDoors(body.doors, map.size);
        const {width, height, rooms} = this.current;
        const cells = new Map(this.data.cells);
        let total = 0;
        if (runs.length) {
            this.current.raster ??= rasterFor(map, width, height);
        }
        for (const run of runs) {
            requireValue(Array.isArray(run) && run.length === 4, "Invalid brush run");
            const [x, y, length, paint] = run;
            requireValue(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(length) && length > 0 &&
                x >= 0 && y >= 0 && y < height && x + length <= width, "Brush outside map");
            total += length;
            requireValue(total <= MAX_CELLS, "Too many cells in one edit");
            const code = paintCode(paint, rooms);
            for (let i = y * width + x; i < y * width + x + length; i++) {
                const baseline = this.current.raster[i];
                if (code === -1 || code === baseline) {
                    cells.delete(i);
                } else {
                    cells.set(i, [baseline, code]);
                }
            }
        }
        requireValue(cells.size <= MAX_CELLS, "Maximum edited cells per floor exceeded");
        this.save({...this.data, cells: cells, doors: doors});
        this.render();
        return this.describe(map);
    }

    render() {
        const {map, floorId, width} = this.current;
        const manual = this.data.doors;
        const layers = editedLayers(map, width, this.data.cells);
        const entities = map.entities.filter(e => e.type !== LineMapEntity.TYPE.DOOR ||
            !manual.some(d => sameDoor(e.points, d.points, map.pixelSize * 2)));
        const doorways = {...(map.metaData.doorways ?? {available: false}), clear: 0, blocked: 0, unknown: 0};
        for (const door of entities.filter(e => e.type === LineMapEntity.TYPE.DOOR)) {
            doorways[door.metaData.mapPassability || "unknown"]++;
        }
        for (const d of manual) {
            entities.push(new LineMapEntity({type: LineMapEntity.TYPE.DOOR, points: d.points,
                metaData: {source: "user", id: d.id, nativeMapId: floorId, doorState: d.state,
                    mapPassability: "unknown"}}));
        }
        const result = {...map, layers: layers, entities: entities, metaData: {...map.metaData, nonce: crypto.randomUUID(),
            totalLayerArea: layers.reduce((sum, layer) => sum + layer.dimensions.pixelCount * map.pixelSize ** 2, 0),
            doorways: doorways, mapEditor: {floorId: floorId, revision: this.revision(), editedCells: this.data.cells.size}}};
        map.setPresentation(result);
    }
}

module.exports = D103CNMapEditor;
