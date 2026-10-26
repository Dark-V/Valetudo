const capabilities = require("./capabilities");
const D103CNAutoEmptyDockManualTriggerCapability = require("./capabilities/D103CNAutoEmptyDockManualTriggerCapability");
const D103CNCleaningHistoryCapability = require("./capabilities/D103CNCleaningHistoryCapability");
const D103CNGoToLocationCapability = require("./capabilities/D103CNGoToLocationCapability");
const D103CNMaintenanceReminderCapability = require("./capabilities/D103CNMaintenanceReminderCapability");
const D103CNMapSegmentationCapability = require("./capabilities/D103CNMapSegmentationCapability");
const D103CNMopDockCleanManualTriggerCapability = require("./capabilities/D103CNMopDockCleanManualTriggerCapability");
const D103CNMopDockDryManualTriggerCapability = require("./capabilities/D103CNMopDockDryManualTriggerCapability");
const D103CNRoomProfilesCapability = require("./capabilities/D103CNRoomProfilesCapability");
const D103CNSpotCleaningCapability = require("./capabilities/D103CNSpotCleaningCapability");
const D103CNWifiConfigurationCapability = require("./capabilities/D103CNWifiConfigurationCapability");
const D103CNWifiScanCapability = require("./capabilities/D103CNWifiScanCapability");
const ValetudoMapAnnotation = require("../../entities/core/ValetudoMapAnnotation");
const ValetudoRestrictedZone = require("../../entities/core/ValetudoRestrictedZone");

/**
 * Reuse the normal Valetudo/Dreame UI and command encoders. These constructors
 * do not start jobs, write settings, edit maps or reset consumable counters.
 * @param {import("./DreameMijiaM30SValetudoRobot")} robot
 */
function registerFeatures(robot) {
    robot.registerCapability(new D103CNCleaningHistoryCapability({robot: robot}));
    robot.registerCapability(new D103CNMaintenanceReminderCapability({robot: robot}));
    robot.registerCapability(new D103CNRoomProfilesCapability({robot: robot}));
    robot.registerCapability(new D103CNWifiConfigurationCapability({robot: robot}));
    robot.registerCapability(new D103CNWifiScanCapability({robot: robot}));
    robot.registerCapability(new D103CNSpotCleaningCapability({robot: robot}));
    robot.registerCapability(new D103CNGoToLocationCapability({robot: robot}));
    robot.registerCapability(new D103CNMopDockCleanManualTriggerCapability({robot: robot}));
    robot.registerCapability(new D103CNMopDockDryManualTriggerCapability({robot: robot}));
    robot.registerCapability(new D103CNAutoEmptyDockManualTriggerCapability({robot: robot}));
    const dreame = /** @type {import("./DreameValetudoRobot")} */ (/** @type {unknown} */ (robot));
    const task = {
        robot: dreame,
        miot_actions: {start: {siid: 4, aiid: 1}},
        miot_properties: {mode: {piid: 1}, additionalCleanupParameters: {piid: 10}}
    };
    robot.registerCapability(new D103CNMapSegmentationCapability({
        ...task, segmentCleaningModeId: 18, iterationsSupported: 4, customOrderSupported: true, newOrder: true
    }));
    robot.registerCapability(new capabilities.DreameZoneCleaningCapability({
        ...task, zoneCleaningModeId: 19, maxZoneCount: 4
    }));

    const map = {
        robot: dreame,
        miot_actions: {map_edit: {siid: 6, aiid: 2}},
        miot_properties: {mapDetails: {piid: 4}, actionResult: {piid: 6}}
    };
    robot.registerCapability(new capabilities.DreameMapSegmentEditCapability(map));
    robot.registerCapability(new capabilities.DreameMapSegmentRenameCapability(map));
    robot.registerCapability(new capabilities.DreameMapResetCapability(map));
    robot.registerCapability(new capabilities.DreameMapAnnotationsCapability({...map,
        supportedAnnotationTypes: [ValetudoMapAnnotation.TYPE.CARPET, ValetudoMapAnnotation.TYPE.CARPET_IGNORED]
    }));
    robot.registerCapability(new capabilities.DreameCombinedVirtualRestrictionsCapability({
        ...map, supportedRestrictedZoneTypes: [ValetudoRestrictedZone.TYPE.REGULAR, ValetudoRestrictedZone.TYPE.MOP]
    }));
    robot.registerCapability(new capabilities.DreameMappingPassCapability({robot: dreame}));
    robot.registerCapability(new capabilities.DreameTotalStatisticsCapability({robot: dreame, miot_properties: {
        time: {siid: 12, piid: 2}, count: {siid: 12, piid: 3}, area: {siid: 12, piid: 4}
    }}));
    robot.registerCapability(new capabilities.DreameMopDockMopDryingTimeControlCapability({robot: dreame}));
    robot.registerCapability(new capabilities.DreameMopDockMopAutoDryingControlCapability({robot: dreame}));
    robot.registerCapability(new capabilities.DreameCarpetModeControlCapability({robot: dreame}));
    robot.registerCapability(new capabilities.DreameCarpetSensorModeControlCapability({
        robot: dreame, liftSupported: true, detachSupported: false
    }));
    robot.registerCapability(new capabilities.DreameDoNotDisturbCapability({robot: dreame}));
    robot.registerCapability(new capabilities.DreameKeyLockCapability({robot: dreame}));
    robot.registerCapability(new capabilities.DreameLocateCapability({robot: dreame, siid: 7, aiid: 1}));
    robot.registerCapability(new capabilities.DreameConsumableMonitoringCapability({
        robot: dreame,
        miot_properties: {
            main_brush: {siid: 9, piid: 1}, side_brush: {siid: 10, piid: 1},
            filter: {siid: 11, piid: 2}, mop: {siid: 18, piid: 1}
        },
        miot_actions: {
            reset_main_brush: {siid: 9, aiid: 1}, reset_side_brush: {siid: 10, aiid: 1},
            reset_filter: {siid: 11, aiid: 1}, reset_mop: {siid: 18, aiid: 1}
        }
    }));
}

module.exports = registerFeatures;
