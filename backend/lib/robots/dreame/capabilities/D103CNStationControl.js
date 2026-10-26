/**
 * Keep the stock Valetudo/Dreame encoders and add D103CN state/attachment checks.
 * No constructors or GET requests start a station operation.
 * @param {import("../DreameMijiaM30SValetudoRobot")} robot
 * @param {string[]} allowed
 * @param {string[]} components
 * @param {boolean} needsMop
 * @param {() => Promise<void>} action
 */
async function run(robot, allowed, components, needsMop, action) {
    if (robot.stationActionPending) {
        throw new Error("A station request is already awaiting acknowledgement");
    }
    const manual = robot.capabilities.HighResolutionManualControlCapability;
    if (manual?.active || manual?.enabling) {
        throw new Error("Disable manual control before using the station");
    }
    robot.stationActionPending = true;
    try {
        await robot.refreshDockState();
        const readiness = robot.getControlReadiness();
        const charging = robot.d103State.find(p => p.siid === 3 && p.piid === 2)?.value;
        if (charging !== 1 || readiness.effectiveFault !== 0 || ![6, 8, 9, 13, 20, 21, 22, 30].includes(readiness.status)) {
            throw new Error("Station operation requires the robot on its dock without an active fault");
        }
        const dock = robot.state.getFirstMatchingAttribute({attributeClass: "DockStatusStateAttribute"});
        if (!allowed.includes(dock?.value)) {
            throw new Error(`The station is ${dock?.value ?? "unavailable"}; wait for its current operation`);
        }
        if (needsMop && robot.state.getFirstMatchingAttribute({attributeClass: "AttachmentStateAttribute", attributeType: "mop"})?.attached !== true) {
            throw new Error("Station operation requires installed mop pads");
        }
        for (const component of components) {
            const item = robot.state.getFirstMatchingAttribute({attributeClass: "DockComponentStateAttribute", attributeType: component});
            if (item?.value !== "ok") {
                throw new Error(`Check station ${component}: ${item?.value ?? "unknown"}`);
            }
        }
        await robot.camera.stop();
        await action();
        // ACK is not proof that the physical state has changed. Refresh actual
        // telemetry after dispatch instead of inventing an optimistic state.
        for (const delay of [400, 1500]) {
            const timer = setTimeout(() => robot.refreshDockState().catch(() => {}), delay);
            timer.unref();
        }
    } finally {
        robot.stationActionPending = false;
    }
}

module.exports = run;
