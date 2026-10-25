const CurrentStatisticsCapability = require("../../../core/capabilities/CurrentStatisticsCapability");
const ValetudoDataPoint = require("../../../entities/core/ValetudoDataPoint");

/** @extends CurrentStatisticsCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNCurrentStatisticsCapability extends CurrentStatisticsCapability {
    async getStatistics() {
        // Same MIOT properties and minutes/m² units as the Dreame protocol.
        // Read the device; do not manufacture a previous clean from a saved map.
        const response = await this.robot.miotHelper.readProperties([{siid: 4, piid: 2}, {siid: 4, piid: 3}]);
        if (!response.every(p => p.code === 0 && Number.isFinite(p.value) && p.value >= 0)) {
            throw new Error("Current cleaning statistics are unavailable from the firmware");
        }
        return response.map(p => new ValetudoDataPoint({
            type: p.piid === 2 ? ValetudoDataPoint.TYPES.TIME : ValetudoDataPoint.TYPES.AREA,
            value: p.value * (p.piid === 2 ? 60 : 10000),
            metaData: {source: "stock MIOT", rawValue: p.value, rawUnit: p.piid === 2 ? "min" : "m2"}
        }));
    }

    getProperties() {
        return {availableStatistics: [ValetudoDataPoint.TYPES.TIME, ValetudoDataPoint.TYPES.AREA]};
    }
}

module.exports = D103CNCurrentStatisticsCapability;
