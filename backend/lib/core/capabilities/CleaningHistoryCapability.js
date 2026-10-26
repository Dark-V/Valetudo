const Capability = require("./Capability");
const NotImplementedError = require("../NotImplementedError");

/**
 * @typedef {object} CleaningRecord
 * @property {string} id
 * @property {number} startedAt Unix milliseconds reported by the robot
 * @property {number} duration Seconds of actual cleaning, excluding pauses
 * @property {number} area Square centimetres
 * @property {boolean|null} completed Null when the firmware does not report it
 * @property {number} nativeMode
 *
 * @typedef {object} CleaningHistoryPage
 * @property {CleaningRecord[]} records
 * @property {number} total
 * @property {number} offset
 * @property {number} limit
 * @property {number} skippedRecords
 * @property {boolean} hasMore
 */

/**
 * @template {import("../ValetudoRobot")} T
 * @extends Capability<T>
 */
class CleaningHistoryCapability extends Capability {
    /**
     * @param {{limit: number, offset: number}} options
     * @returns {Promise<CleaningHistoryPage>}
     */
    async getHistory(options) {
        throw new NotImplementedError();
    }

    getType() {
        return CleaningHistoryCapability.TYPE;
    }
}

CleaningHistoryCapability.TYPE = "CleaningHistoryCapability";
module.exports = CleaningHistoryCapability;
