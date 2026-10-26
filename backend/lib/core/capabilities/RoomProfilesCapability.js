const Capability = require("./Capability");
const NotImplementedError = require("../NotImplementedError");

/** @template {import("../ValetudoRobot")} T @extends Capability<T> */
class RoomProfilesCapability extends Capability {
    /** @returns {Promise<any>} */
    async preview() {
        throw new NotImplementedError();
    }
    /** @returns {Promise<any>} */
    async getProfiles() {
        throw new NotImplementedError();
    }
    /** @param {object} request @returns {Promise<any>} */
    async setProfiles(request) {
        throw new NotImplementedError();
    }
    getType() {
        return RoomProfilesCapability.TYPE;
    }
}
RoomProfilesCapability.TYPE = "RoomProfilesCapability";
module.exports = RoomProfilesCapability;
