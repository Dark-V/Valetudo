const DreameMapParser = require("../DreameMapParser");
const SpotCleaningCapability = require("../../../core/capabilities/SpotCleaningCapability");

/** @extends SpotCleaningCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNSpotCleaningCapability extends SpotCleaningCapability {
    async start(options) {
        const iterations = options.iterations ?? 1;
        if (!options.coordinates || !Number.isFinite(options.coordinates.x) || !Number.isFinite(options.coordinates.y) ||
            !Number.isInteger(iterations) || iterations < 1 || iterations > 4) {
            throw new Error("Invalid spot coordinates or iteration count");
        }
        const point = DreameMapParser.CONVERT_TO_DREAME_COORDINATES(options.coordinates.x, options.coordinates.y);
        if (![point.x, point.y].every(n => Number.isFinite(n) && n >= -32768 && n <= 32767)) {
            throw new Error("Spot coordinates are outside the native map coordinate range");
        }
        await this.robot.refreshControlState({force: true});
        const readiness = this.robot.getControlReadiness();
        if (!readiness.ready || ![2, 3, 6, 13].includes(readiness.status)) {
            throw new Error(readiness.reason ?? "Spot cleaning requires a recent idle/paused/docked state without a fault");
        }
        const settings = await this.robot.miotHelper.readProperties([{siid: 2, piid: 3}, {siid: 4, piid: 5}]);
        const fan = settings.find(p => p.siid === 2 && p.piid === 3 && p.code === 0)?.value;
        const water = settings.find(p => p.siid === 4 && p.piid === 5 && p.code === 0)?.value;
        if (!Number.isInteger(fan) || fan < 0 || fan > 3 || !Number.isInteger(water) || water < 1 || water > 3) {
            throw new Error("Spot cleaning cannot read the current fan/water settings");
        }
        // Native ActStartClean handles mode 20 with piid 10. This is the exact
        // points encoder documented by Tasshack/dreame-vacuum v2.0.0b17,
        // device.py clean_spot; it is not an approximation using a small zone.
        await this.robot.miotHelper.executeAction(4, 1, [
            {piid: 1, value: 20},
            {piid: 10, value: JSON.stringify({points: [[Math.round(point.x), Math.round(point.y), iterations, fan, water]]})}
        ]);
    }
}

module.exports = D103CNSpotCleaningCapability;
