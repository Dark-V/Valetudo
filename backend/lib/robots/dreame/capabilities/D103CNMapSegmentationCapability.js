const DreameMapSegmentationCapability = require("./DreameMapSegmentationCapability");

class D103CNMapSegmentationCapability extends DreameMapSegmentationCapability {
    async getSegmentSettings(segments, options, defaults) {
        if (options?.useProfiles === false) {
            return super.getSegmentSettings(segments, options, defaults);
        }
        const profiles = /** @type {import("./D103CNRoomProfilesCapability")} */ (
            this.robot.capabilities.RoomProfilesCapability);
        const current = await profiles.getProfiles();
        const known = new Map(current.rooms.map(room => [room.id, room.profile]));
        if (segments.some(room => !known.has(room.id))) {
            throw new Error("A selected room no longer exists. Refresh the map");
        }
        if (!segments.some(room => known.get(room.id))) {
            return super.getSegmentSettings(segments, options, defaults);
        }
        // Native customized cleaning can override selects. Never silently
        // overwrite that firmware setting to make local profiles appear to work.
        const state = await this.robot.sendCommand("get_properties", [{siid: 4, piid: 26, did: this.robot.deviceId}]);
        if (!Array.isArray(state) || state[0]?.code !== 0 || state[0]?.value !== 0) {
            throw new Error("Native customized cleaning is active or unreadable; it can override room profiles");
        }
        return segments.map((room, i) => {
            const profile = known.get(room.id);
            return [Number(room.id), profile?.iterations ?? defaults.iterations,
                profile ? ["low", "medium", "high", "max"].indexOf(profile.fan) : defaults.fan,
                profile ? ["low", "medium", "high"].indexOf(profile.water) + 1 : defaults.water,
                this.newOrder ? 1 : i + 1];
        });
    }
    getProperties() {
        return {...super.getProperties(), roomProfilesSupported: true};
    }
}
module.exports = D103CNMapSegmentationCapability;
