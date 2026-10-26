const crypto = require("crypto");
const fs = require("fs");
const RoomProfilesCapability = require("../../../core/capabilities/RoomProfilesCapability");

const FILE = "/data/.valetudo/room-profiles.json";
const FANS = ["low", "medium", "high", "max"];
const WATER = ["low", "medium", "high"];

/** @extends RoomProfilesCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNRoomProfilesCapability extends RoomProfilesCapability {
    readStore() {
        if (!fs.existsSync(FILE)) {
            return {version: 1, maps: {}};
        }
        const stat = fs.lstatSync(FILE);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
            throw new Error("Invalid room profiles file");
        }
        const store = JSON.parse(fs.readFileSync(FILE, "utf8"));
        if (store.version !== 1 || !store.maps || typeof store.maps !== "object" || Array.isArray(store.maps)) {
            throw new Error("Unsupported room profiles file");
        }
        return store;
    }

    async getProfiles() {
        const map = this.robot.state.map;
        const mapId = map.metaData.vendorMapId;
        if (!Number.isInteger(mapId) || mapId < 0 || map.metaData.savedMapSnapshot === true ||
            Date.now() - this.robot.lastLiveMapAt > 120000) {
            throw new Error("Wait for a recent live map with room identities");
        }
        const segments = map.getSegments().sort((a, b) => Number(a.id) - Number(b.id));
        if (segments.length === 0 || segments.length > 64) {
            throw new Error("No usable rooms on this map");
        }
        const stored = this.readStore().maps[String(mapId)] ?? {};
        const rooms = segments.map(room => ({id: room.id, name: room.name ?? room.id, profile: stored[room.id] ?? null}));
        const revision = crypto.createHash("sha256").update(JSON.stringify({mapId: mapId, rooms: rooms})).digest("hex");
        return {mapId: mapId, revision: revision, rooms: rooms};
    }

    async setProfiles(request) {
        const current = await this.getProfiles();
        if (request.mapId !== current.mapId || request.revision !== current.revision) {
            throw new Error("Map or profiles changed. Refresh before saving");
        }
        if (!Array.isArray(request.rooms) || request.rooms.length !== current.rooms.length) {
            throw new Error("Submit exactly the rooms from the current map");
        }
        const ids = new Set(current.rooms.map(room => room.id));
        const profiles = {};
        for (const room of request.rooms) {
            if (!ids.delete(room.id)) {
                throw new Error("Unknown or duplicate room");
            }
            if (room.profile !== null) {
                const p = room.profile;
                if (!p || Object.keys(p).sort().join(",") !== "fan,iterations,water" ||
                    !FANS.includes(p.fan) || !WATER.includes(p.water) ||
                    !Number.isInteger(p.iterations) || p.iterations < 1 || p.iterations > 3) {
                    throw new Error("Invalid room profile");
                }
                profiles[room.id] = {fan: p.fan, water: p.water, iterations: p.iterations};
            }
        }
        const store = this.readStore();
        if (!Object.hasOwn(store.maps, String(current.mapId)) && Object.keys(store.maps).length >= 16) {
            throw new Error("Room profile map limit reached");
        }
        store.maps[String(current.mapId)] = profiles;
        const serialized = JSON.stringify(store) + "\n";
        if (Buffer.byteLength(serialized) > 65536) {
            throw new Error("Room profiles storage limit reached");
        }
        const temp = FILE + "." + crypto.randomBytes(6).toString("hex");
        try {
            const fd = fs.openSync(temp, "wx", 0o600);
            try {
                fs.writeFileSync(fd, serialized); fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(temp, FILE);
            const directoryFd = fs.openSync("/data/.valetudo", "r");
            try {
                fs.fsyncSync(directoryFd);
            } finally {
                fs.closeSync(directoryFd);
            }
        } finally {
            if (fs.existsSync(temp)) {
                fs.unlinkSync(temp);
            }
        }
        return this.getProfiles();
    }

    getProperties() {
        return {fanPresets: FANS, waterPresets: WATER, iterationCount: {min: 1, max: 3},
            scope: "selected_rooms", storage: "valetudo_per_map"};
    }

    async preview() {
        const current = await this.getProfiles();
        const value = (siid, piid, fallback) => this.robot.d103State.find(p => p.siid === siid && p.piid === piid)?.value ?? fallback;
        const rows = await this.robot.capabilities.MapSegmentationCapability.getSegmentSettings(
            current.rooms, {useProfiles: true}, {iterations: 1, fan: value(2, 3, 1), water: value(4, 5, 2)});
        return {mapId: current.mapId, mode: 18, parameters: {selects: rows}, sent: false};
    }
}
module.exports = D103CNRoomProfilesCapability;
