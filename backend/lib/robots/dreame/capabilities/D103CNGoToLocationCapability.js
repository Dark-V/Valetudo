const D103 = require("../D103CNProtocol");
const DreameAICameraGoToLocationCapability = require("./DreameAICameraGoToLocationCapability");
const DreameMapParser = require("../DreameMapParser");
const fs = require("fs");
const Logger = require("../../../Logger");

const JOURNAL = "/data/.valetudo/goto-restore.json";
const WAIT = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Uses the Dreame small-zone fallback and stops the task on arrival. */
class D103CNGoToLocationCapability extends DreameAICameraGoToLocationCapability {
    constructor(options) {
        super(options);
        /** @type {import("../DreameMijiaM30SValetudoRobot")} */
        this.d103Robot = options.robot;
        this.busy = false;
        this.timer = null;
        this.ownsActiveTask = false;
    }
    async goTo(target) {
        const point = target?.coordinates;
        if (!point || ![point.x, point.y].every(n => Number.isFinite(n) && n >= 0 && n <= 5120)) {
            throw new Error("Go-to target must be inside the Valetudo map coordinate range");
        }
        await this.d103Robot.refreshDockState();
        const ready = this.d103Robot.getControlReadiness();
        if (!ready.ready || ![2, 6, 13].includes(ready.status)) {
            throw new Error(ready.reason ?? "Go-to requires an idle or docked robot");
        }
        const battery = this.robot.state.getFirstMatchingAttribute({attributeClass: "BatteryStateAttribute"});
        if (!Number.isFinite(battery?.level) || battery.level < 15) {
            throw new Error("Charge the robot above 15% before sending it to a point");
        }
        if (this.d103Robot.stationActionPending || this.d103Robot.state.map.metaData.savedMapSnapshot === true) {
            throw new Error("Go-to requires the current live map and no pending station request");
        }
        if (this.busy || fs.existsSync(JOURNAL)) {
            throw new Error("Go-to settings restoration is still pending");
        }
        const map = this.robot.state.map;
        if (!map || Date.now() - this.d103Robot.lastLiveMapAt > 120000 || map.metaData.savedMapSnapshot === true) {
            throw new Error("Go-to requires a recent live map");
        }
        const p = DreameMapParser.CONVERT_TO_DREAME_COORDINATES(point.x, point.y);
        const half = 50; // 100 mm square, like the Dreame integration fallback.
        if (![p.x - half, p.y - half, p.x + half, p.y + half].every(n => n >= -32768 && n <= 32767)) {
            throw new Error("Target is too close to the edge of the map");
        }
        this.busy = true;
        try {
            const [originalMode, originalFan, task] = await Promise.all([
                this.robot.miotHelper.readProperty(4, 23), this.robot.miotHelper.readProperty(2, 3),
                this.robot.miotHelper.readProperty(4, 7)
            ]);
            if (!D103.validCleanSettings(originalMode) || !Number.isInteger(originalFan) || originalFan < 0 || originalFan > 3 || task !== 0) {
                throw new Error("Cannot start go-to: settings unavailable or an existing task is active");
            }
            const record = {version: 1, originalMode: originalMode, originalFan: originalFan,
                target: {x: point.x, y: point.y}, phase: "preparing", started: false, created: Date.now()};
            this.save(record);
            try {
                if (originalMode % 256 !== 2) {
                    await this.robot.miotHelper.writeProperty(4, 23, D103.withOperationMode(originalMode, "vacuum"));
                }
                if (originalFan !== 0) {
                    await this.robot.miotHelper.writeProperty(2, 3, 0);
                }
                if ((await this.robot.miotHelper.readProperty(4, 23)) % 256 !== 2 ||
                    await this.robot.miotHelper.readProperty(2, 3) !== 0) {
                    throw new Error("Robot did not confirm vacuum mode and minimum suction");
                }
                await this.d103Robot.refreshDockState();
                const now = this.d103Robot.getControlReadiness();
                if (!now.ready || ![2, 6, 13].includes(now.status) || await this.robot.miotHelper.readProperty(4, 7) !== 0) {
                    throw new Error("Robot state changed while preparing go-to; no motion request sent");
                }
                record.phase = "sent";
                this.save(record);
                this.ownsActiveTask = true;
                // Never retry a motion request if its acknowledgement is lost.
                const response = await this.d103Robot.sendCommand("action", {did: this.robot.deviceId, siid: 4, aiid: 1,
                    in: [{piid: 1, value: 19}, {piid: 10, value: JSON.stringify({areas: [[
                        p.x - half, p.y - half, p.x + half, p.y + half, 1, 0, 1
                    ]]})}]}, {timeout: 2000, noRetry: true});
                if (response?.code !== 0) {
                    throw new Error("Robot did not acknowledge the go-to zone");
                }
                let started = false;
                for (let i = 0; i < 10; i++) {
                    await WAIT(1000);
                    if (await this.robot.miotHelper.readProperty(4, 7) === 2) {
                        started = true;
                        record.started = true;
                        this.save(record);
                        break;
                    }
                }
                if (!started) {
                    throw new Error("Robot acknowledged the zone but did not report a start; check it before retrying");
                }
            } finally {
                this.startRecovery();
            }
        } finally {
            this.busy = false;
        }
    }

    save(record) {
        const tmp = JOURNAL + ".tmp";
        const fd = fs.openSync(tmp, "w", 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, JOURNAL);
        const directory = fs.openSync("/data/.valetudo", "r");
        try {
            fs.fsyncSync(directory);
        } finally {
            fs.closeSync(directory);
        }
    }

    startRecovery() {
        if (this.timer || !fs.existsSync(JOURNAL)) {
            return;
        }
        const tick = async () => {
            if (this.busy) {
                return;
            }
            this.busy = true;
            try {
                await this.recover();
            } catch (err) {
                Logger.warn(`D103CN go-to recovery: ${err.message}`);
            } finally {
                this.busy = false;
            }
        };
        this.timer = setInterval(tick, 3000);
        this.timer.unref();
        tick();
    }

    async recover() {
        if (!fs.existsSync(JOURNAL)) {
            clearInterval(this.timer); this.timer = null; return;
        }
        const r = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));
        if (r.version !== 1 || !D103.validCleanSettings(r.originalMode) || ![0, 1, 2, 3].includes(r.originalFan) ||
            !r.target || ![r.target.x, r.target.y].every(Number.isFinite)) {
            throw new Error("Invalid recovery journal; settings were not changed");
        }
        const [status, task, mode] = await Promise.all([
            this.robot.miotHelper.readProperty(2, 1), this.robot.miotHelper.readProperty(4, 7),
            this.robot.miotHelper.readProperty(4, 1)
        ]);
        if (r.phase === "sent" && mode === 19 && task === 2 && [1, 7, 12].includes(status)) {
            if (!r.started) {
                r.started = true; this.save(r);
            }
            const entity = this.robot.state.map?.entities?.find(e => e.type === "robot_position");
            if (this.ownsActiveTask && Date.now() - this.d103Robot.lastLiveMapAt < 10000 && this.d103Robot.lastLiveMapAt > r.created &&
                Array.isArray(entity?.points) && Math.abs(entity.points[0] - r.target.x) <= 10 &&
                Math.abs(entity.points[1] - r.target.y) <= 10) {
                r.phase = "stopping";
                this.save(r); // persist before the one-shot stop request
                await this.d103Robot.sendCommand("action", {did: this.robot.deviceId, siid: 4, aiid: 2, in: []},
                    {timeout: 2000, noRetry: true});
            }
            return;
        }
        // Do not restore during another task, a paused task, or an uncertain start.
        if (task !== 0 || ![2, 6, 13].includes(status) ||
            (r.phase === "sent" && !r.started && Date.now() - r.created < 30000)) {
            return;
        }
        const currentMode = await this.robot.miotHelper.readProperty(4, 23);
        const currentFan = await this.robot.miotHelper.readProperty(2, 3);
        if (!D103.validCleanSettings(currentMode) || ![0, 1, 2, 3].includes(currentFan)) {
            throw new Error("Settings readback is invalid; restoration deferred");
        }
        if (currentMode % 256 === 2 && r.originalMode % 256 !== 2) {
            await this.robot.miotHelper.writeProperty(4, 23, D103.withOperationMode(currentMode, D103.operationMode(r.originalMode)));
        }
        if (currentFan === 0 && r.originalFan !== 0) {
            await this.robot.miotHelper.writeProperty(2, 3, r.originalFan);
        }
        await WAIT(300);
        const modeAfter = await this.robot.miotHelper.readProperty(4, 23);
        const fanAfter = await this.robot.miotHelper.readProperty(2, 3);
        if ((currentMode % 256 === 2 && modeAfter % 256 !== r.originalMode % 256) ||
            (currentFan === 0 && fanAfter !== r.originalFan)) {
            throw new Error("Restoration not confirmed; will retry while idle");
        }
        fs.unlinkSync(JOURNAL);
        this.ownsActiveTask = false;
        clearInterval(this.timer); this.timer = null;
    }
}

module.exports = D103CNGoToLocationCapability;
