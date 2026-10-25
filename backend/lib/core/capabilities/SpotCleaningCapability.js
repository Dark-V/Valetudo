const Capability = require("./Capability");
const NotImplementedError = require("../NotImplementedError");

/**
 * Clean around a selected point using the firmware's native spot operation.
 * @template {import("../ValetudoRobot")} T
 * @extends Capability<T>
 */
class SpotCleaningCapability extends Capability {
    /**
     * @abstract
     * @param {{coordinates: {x: number, y: number}, iterations?: number}} options
     * @returns {Promise<void>}
     */
    async start(options) {
        throw new NotImplementedError();
    }

    getProperties() {
        return {iterationCount: {min: 1, max: 4}};
    }

    getType() {
        return SpotCleaningCapability.TYPE;
    }
}

SpotCleaningCapability.TYPE = "SpotCleaningCapability";
module.exports = SpotCleaningCapability;
