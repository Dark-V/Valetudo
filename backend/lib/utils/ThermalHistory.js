const fs = require("fs");

const SAMPLE_SECONDS = 10;
const CAPACITY = 8640 + 1;
const WINDOWS = [60, 3600, 86400];

/** Bounded RAM-only sampling; no thermal settings or flash writes. */
class ThermalHistory {
    constructor() {
        this.started = process.hrtime.bigint();
        this.times = new Float64Array(CAPACITY);
        /** @type {Map<string, {type: string, values: Float32Array}>} */
        this.sensors = new Map();
        this.next = 0;
        this.length = 0;
        this.pending = false;
        this.lastDiscovery = -Infinity;
        this.stopped = false;
        this.sample();
        this.timer = setInterval(() => this.sample(), SAMPLE_SECONDS * 1000);
        this.timer.unref();
    }

    elapsed() {
        return Number(process.hrtime.bigint() - this.started) / 1e9;
    }

    async sample() {
        if (this.pending || this.stopped) {
            return;
        }
        this.pending = true;
        try {
            const now = this.elapsed();
            if (now - this.lastDiscovery >= 60) {
                this.lastDiscovery = now;
                const names = await fs.promises.readdir("/sys/class/thermal");
                for (const name of names.filter(n => /^thermal_zone\d+$/.test(n)).sort().slice(0, 8)) {
                    if (!this.sensors.has(name)) {
                        const type = (await fs.promises.readFile(`/sys/class/thermal/${name}/type`, "utf8")).trim().slice(0, 80);
                        const values = new Float32Array(CAPACITY);
                        values.fill(NaN);
                        this.sensors.set(name, {type: type, values: values});
                    }
                }
            }
            const slot = this.next;
            const readings = await Promise.all(Array.from(this.sensors, async ([id, sensor]) => {
                let temperature = NaN;
                try {
                    const raw = (await fs.promises.readFile(`/sys/class/thermal/${id}/temp`, "utf8")).trim();
                    if (/^-?\d+$/.test(raw)) {
                        temperature = Number(raw) / 1000;
                    }
                } catch (e) {
                    // Missing/unreadable samples stay missing, never zero.
                }
                return {sensor: sensor, temperature: temperature};
            }));
            if (this.stopped) {
                return;
            }
            this.times[slot] = this.elapsed();
            for (const reading of readings) {
                reading.sensor.values[slot] = reading.temperature;
            }
            this.next = (slot + 1) % CAPACITY;
            this.length = Math.min(CAPACITY, this.length + 1);
        } catch (e) {
            // Unsupported hosts have no readings. Keep the webserver usable.
        } finally {
            this.pending = false;
        }
    }

    snapshot() {
        const now = this.elapsed();
        const last = (this.next - 1 + CAPACITY) % CAPACITY;
        const sampleAge = this.length ? now - this.times[last] : null;
        return {
            sampledAt: sampleAge === null ? null : Date.now() - Math.round(sampleAge * 1000),
            sampleIntervalSeconds: SAMPLE_SECONDS,
            retentionSeconds: 86400,
            collectedSeconds: Math.floor(now),
            storage: "RAM; resets when Valetudo restarts",
            sensors: Array.from(this.sensors, ([id, sensor]) => {
                const statistics = WINDOWS.map(seconds => ({seconds: seconds, count: 0, sum: 0, min: Infinity, max: -Infinity}));
                for (let i = 0; i < this.length; i++) {
                    const slot = (this.next - 1 - i + CAPACITY) % CAPACITY;
                    const age = now - this.times[slot];
                    const value = sensor.values[slot];
                    if (!Number.isFinite(value)) {
                        continue;
                    }
                    for (const window of statistics) {
                        if (age >= 0 && age <= window.seconds) {
                            window.count++;
                            window.sum += value;
                            window.min = Math.min(window.min, value);
                            window.max = Math.max(window.max, value);
                        }
                    }
                }
                return {
                    id: id, type: sensor.type,
                    current: sampleAge !== null && sampleAge <= 25 && Number.isFinite(sensor.values[last]) ? sensor.values[last] : null,
                    windows: statistics.map(window => {
                        const coverage = Math.min(window.seconds, now, window.count * SAMPLE_SECONDS);
                        return {
                            seconds: window.seconds, samples: window.count,
                            average: window.count ? window.sum / window.count : null,
                            min: window.count ? window.min : null,
                            max: window.count ? window.max : null,
                            coverageSeconds: Math.floor(coverage),
                            complete: now >= window.seconds && coverage >= window.seconds * 0.95
                        };
                    })
                };
            })
        };
    }

    shutdown() {
        this.stopped = true;
        clearInterval(this.timer);
    }
}

module.exports = ThermalHistory;
