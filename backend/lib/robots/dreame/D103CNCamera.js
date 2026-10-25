const childProcess = require("child_process");
const crc = require("crc");
const fs = require("fs");
const Logger = require("../../Logger");
const zlib = require("zlib");

const ROOT = "/data/.valetudo";
const SIZE = 640 * 480;

/** One bounded factory diagnostic stream, shared by HTTP viewers; never opens video1. */
class D103CNCamera {
    /** @param {import("./DreameMijiaM30SValetudoRobot")} robot */
    constructor(robot) {
        this.robot = robot;
        /** @type {import("child_process").ChildProcessWithoutNullStreams|null} */
        this.child = null;
        this.buffer = Buffer.alloc(0);
        /** @type {{png: Buffer, sequence: number, at: number, sourceMs: number}|null} */
        this.frame = null;
        this.encoding = false;
        this.epoch = 0;
        this.received = 0;
        this.started = 0;
        this.lastRequest = 0;
        this.bright = false;
        this.error = null;
        /** @type {Promise<void>|null} */
        this.stopping = null;
        this.timer = null;
        this.closed = Promise.resolve();
        this.ready = Promise.resolve();
    }

    state() {
        return {available: fs.existsSync(ROOT + "/camera-session.sh"), running: !!this.child,
            width: 640, height: 480, bright: this.bright, experimental: true,
            frameAgeMs: this.frame ? Math.round(performance.now() - this.frame.at) : null,
            sequence: this.frame?.sequence ?? 0,
            fps: this.started ? Math.round(this.received * 10000 / Math.max(1, performance.now() - this.started)) / 10 : 0,
            error: this.error, maxFps: 10, leaseSeconds: 5, readiness: this.robot.getControlReadiness(),
            description: "SC035GS monochrome navigation camera; factory exposure while driving"};
    }

    async start(bright) {
        if (this.child || this.stopping) {
            throw new Error("Camera is already open or restoring; stop it before changing mode");
        }
        await this.robot.refreshControlState();
        if (this.child || this.stopping) {
            throw new Error("Camera session changed during state refresh; retry");
        }
        const manual = this.robot.capabilities.HighResolutionManualControlCapability;
        if (manual?.enabling || manual?.stopping || (bright && manual?.active)) {
            throw new Error("Bright camera mode is unavailable with manual control enabled");
        }
        const readiness = this.robot.getControlReadiness();
        if (!readiness.ready) {
            throw new Error(`Camera not ready: status=${readiness.status}, fault=${readiness.fault}, ageMs=${readiness.ageMs}`);
        }
        this.frame = null;
        this.epoch++;
        this.buffer = Buffer.alloc(0);
        this.error = null;
        this.received = 0;
        this.started = performance.now();
        this.lastRequest = this.started;
        this.bright = bright;
        const child = childProcess.spawn("/bin/sh", [ROOT + "/camera-session.sh", bright ? "bright" : "factory"], {
            stdio: ["pipe", "pipe", "pipe"], env: {PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C"}
        });
        this.child = child;
        this.robot.beginControlMonitoring("camera");
        if (manual?.active) {
            child.stdin.write("M");
        }
        let diagnostics = "";
        let markReady;
        let rejectReady;
        this.ready = new Promise((resolve, reject) => {
            markReady = resolve; rejectReady = reject;
        });
        let ready = false;
        child.stderr.on("data", data => {
            diagnostics = (diagnostics + data.toString("utf8")).slice(-4096);
        });
        child.stderr.on("data", () => {
            if (!ready && diagnostics.includes("CAMERA_READY")) {
                ready = true;
                this.lastRequest = performance.now();
                markReady();
            }
        });
        child.stdout.on("data", data => this.consume(data));
        child.stdin.on("error", () => {});
        child.on("error", () => {
            this.error = "Camera helper failed to start";
        });
        this.closed = new Promise(resolve => {
            child.once("close", code => {
                rejectReady(new Error("Camera session closed before readiness"));
                clearInterval(this.timer);
                this.timer = null;
                this.child = null;
                this.robot.endControlMonitoring("camera");
                this.frame = null;
                this.buffer = Buffer.alloc(0);
                this.bright = false;
                if (code !== 0) {
                    this.error = "Camera session ended; check sensor restoration before retrying";
                }
                Logger.info("D103CN camera session closed", {code: code, diagnostics: diagnostics});
                resolve();
            });
        });
        this.timer = setInterval(() => {
            const now = performance.now();
            const statusNow = this.robot.d103State.find(p => p.siid === 2 && p.piid === 1)?.value;
            const manualNow = this.robot.capabilities.HighResolutionManualControlCapability;
            const readinessNow = this.robot.getControlReadiness();
            if ((ready && now - this.lastRequest > 5000) || readinessNow.fault !== 0 ||
                readinessNow.ageMs === null || readinessNow.ageMs > 10000 ||
                (!manualNow?.active && ![2, 3, 6, 13, 21, 23].includes(statusNow)) ||
                (this.frame ? now - this.frame.at > 5000 : now - this.started > 10000)) {
                this.stop().catch(() => Logger.warn("D103CN camera restore did not finish"));
            } else if (child.stdin.writableLength < 128) {
                child.stdin.write("K");
            }
        }, 500);
        this.timer.unref();
        await this.ready;
    }

    async factoryForManual() {
        if (this.stopping) {
            await this.stopping;
        }
        if (!this.child) {
            return;
        }
        await this.ready;
        // Mark camera ownership transfer before enabling navigation; do not close its stream on page exit.
        await this.exec("/usr/bin/avacmd", ["camera_laser",
            '{"type":"camera_laser","cmd":"set_exposure_gain","expose":950,"gain":48}']);
        let restored = false;
        for (let n = 0; n < 10; n++) {
            const readback = await this.exec(ROOT + "/camera-controls", []);
            if (/name=Exposure value=950 /.test(readback) && /name=Gain value=48 /.test(readback)) {
                restored = true;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!restored) {
            throw new Error("Factory camera exposure was not restored; manual enable refused");
        }
        if (!this.child || this.stopping) {
            throw new Error("Camera session changed during manual enable; retry");
        }
        const child = this.child;
        await new Promise((resolve, reject) => {
            let response = "";
            const onData = data => {
                response = (response + data.toString("utf8")).slice(-512);
                if (response.includes("MANUAL_CAMERA_OWNERSHIP")) {
                    clearTimeout(timer);
                    child.stderr.removeListener("data", onData);
                    resolve();
                }
            };
            const timer = setTimeout(() => {
                child.stderr.removeListener("data", onData);
                reject(new Error("Camera ownership transfer timed out; manual enable refused"));
            }, 2500);
            child.stderr.on("data", onData);
            child.stdin.write("MR");
        });
        this.epoch++;
        this.bright = false;
        this.frame = null;
    }

    /**
     * @param {string} executable
     * @param {string[]} args
     * @returns {Promise<string>}
     */
    exec(executable, args) {
        return new Promise((resolve, reject) => {
            childProcess.execFile(executable, args, {timeout: 4500, maxBuffer: 8192}, (error, stdout) => {
                if (error) {
                    reject(new Error("Factory camera command/readback failed"));
                } else {
                    resolve(stdout);
                }
            });
        });
    }

    async stop() {
        if (this.stopping) {
            return this.stopping;
        }
        if (!this.child) {
            return;
        }
        const child = this.child;
        this.frame = null;
        this.stopping = (async () => {
            child.stdin.end("Q");
            // The wrapper survives Valetudo and restores on EOF, heartbeat loss or helper exit.
            let timeout;
            try {
                await Promise.race([this.closed, new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error("Camera restore timeout")), 16000);
                })]);
            } finally {
                clearTimeout(timeout);
            }
        })();
        try {
            await this.stopping;
        } finally {
            this.stopping = null;
        }
    }

    /** @param {Buffer} data */
    consume(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        if (this.buffer.length > (SIZE + 24) * 2) {
            this.error = "Camera framing overflow";
            this.stop().catch(() => {});
            return;
        }
        while (this.buffer.length >= SIZE + 24) {
            const packet = this.buffer.subarray(0, SIZE + 24);
            if (packet.toString("ascii", 0, 4) !== "D103" || packet.readUInt32LE(4) !== SIZE) {
                this.error = "Invalid camera frame";
                this.stop().catch(() => {});
                return;
            }
            this.buffer = this.buffer.subarray(SIZE + 24);
            if (!this.encoding && !this.stopping) {
                this.encoding = true;
                const sequence = packet.readUInt32LE(8);
                const sourceMs = Number(packet.readBigUInt64LE(12));
                const age = Number(process.hrtime.bigint() / BigInt(1000000)) - sourceMs;
                const packetAt = performance.now() - age;
                if (age < 0 || age > 1000) {
                    this.encoding = false;
                    continue;
                }
                const child = this.child;
                const epoch = this.epoch;
                const scanlines = Buffer.alloc(SIZE + 480);
                for (let y = 0; y < 480; y++) {
                    packet.copy(scanlines, y * 641 + 1, 24 + y * 640, 24 + (y + 1) * 640);
                }
                zlib.deflate(scanlines, {level: 1}, (err, compressed) => {
                    this.encoding = false;
                    if (!err && this.child === child && epoch === this.epoch && !this.stopping) {
                        const ihdr = Buffer.alloc(13);
                        ihdr.writeUInt32BE(640, 0); ihdr.writeUInt32BE(480, 4); ihdr[8] = 8;
                        this.frame = {png: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"),
                            pngChunk("IHDR", ihdr), pngChunk("IDAT", compressed), pngChunk("IEND", Buffer.alloc(0))]),
                        sequence: sequence, sourceMs: sourceMs, at: packetAt};
                        this.received++;
                    }
                });
            }
        }
    }

    getFrame() {
        this.lastRequest = performance.now();
        if (!this.frame || performance.now() - this.frame.at > 1500 || this.stopping) {
            return null;
        }
        return this.frame;
    }
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function pngChunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc.crc32(body) >>> 0);
    return Buffer.concat([header, body, checksum]);
}

module.exports = D103CNCamera;
