const Ajv = require("ajv");
const crypto = require("crypto");
const EventEmitter = require("events").EventEmitter;
const fs = require("fs");
const nestedObjectAssign = require("nested-object-assign");
const os = require("os");
const path = require("path");

const DEFAULT_SETTINGS = require("./res/default_config.json");
const env = require("./res/env");
const Logger = require("./Logger");
const SCHEMAS = require("./doc/Configuration.openapi.json");
const Tools = require("./utils/Tools");

class Configuration {

    constructor() {
        /** @private */
        this.eventEmitter = new EventEmitter();
        this.settings = structuredClone(DEFAULT_SETTINGS);

        this.location = process.env[env.ConfigPath] ?? path.join(os.tmpdir(), "valetudo_config.json");

        this.loadConfig();
        this.loadD103UserSettings();
    }

    /**
     * @param {string} key
     * @returns {*}
     */
    get(key) {
        return this.settings[key];
    }

    getAll() {
        return this.settings;
    }

    /**
     * @param {string} key
     * @param {string|object} val
     */
    set(key, val) {
        this.settings[key] = val;

        this.persist();
        this.eventEmitter.emit(CONFIG_UPDATE_EVENT, key);
    }

    persist() {
        if (this.d103UserLocation) {
            try {
                fs.writeFileSync(this.location, this.getSerializedConfig());
                this.persistD103UserSettings();
                this.d103CommittedSettings = structuredClone(this.settings);
            } catch (e) {
                this.settings = structuredClone(this.d103CommittedSettings);
                try {
                    fs.writeFileSync(this.location, this.getSerializedConfig());
                } catch (restoreError) {
                    Logger.error("Error restoring temporary D103CN configuration", restoreError);
                }
                Logger.error("Error while persisting D103CN configuration", e);
                throw e;
            }
            return;
        }
        try {
            fs.writeFileSync(this.location, this.getSerializedConfig());
        } catch (e) {
            Logger.error("Error while persisting configuration", e);
        }
    }

    /** Preserve user settings independently of the generated RAM-only network configuration. */
    loadD103UserSettings() {
        if (this.settings.embedded !== true || this.settings.robot?.implementation !== "DreameMijiaM30SValetudoRobot" ||
            !/^\/tmp\/d103-valetudo-manual\.[^/]+\/valetudo-config\.json$/.test(this.location)) {
            return;
        }
        const location = "/data/.valetudo/user-config.json";
        if (fs.existsSync(location)) {
            const stat = fs.lstatSync(location);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
                throw new Error("D103CN user configuration is not a regular file or is too large");
            }
            let stored;
            try {
                stored = JSON.parse(fs.readFileSync(location, "utf8"));
            } catch (e) {
                throw new Error("D103CN user configuration is unreadable; the original file was retained");
            }
            if (!stored || Array.isArray(stored) || typeof stored !== "object" ||
                Object.keys(stored).some(key => !D103_USER_KEYS.includes(key))) {
                throw new Error("D103CN user configuration contains unsupported keys; the original file was retained");
            }
            const candidate = structuredClone(this.settings);
            // Replace entire user-owned fields: an empty timers object must
            // delete every previously defined timer instead of merging them back.
            for (const key of Object.keys(stored)) {
                candidate[key] = structuredClone(stored[key]);
            }
            // Validate without mutating stored data or discarding unknown fields.
            //@ts-ignore
            const ajv = new Ajv();
            Object.keys(SCHEMAS.components.schemas).forEach(schemaName => {
                ajv.addSchema(SCHEMAS.components.schemas[schemaName], "#/components/schemas/" + schemaName);
            });
            if (!ajv.validate(SCHEMAS.components.schemas.Configuration, candidate)) {
                throw new Error("D103CN user configuration failed validation; the original file was retained");
            }
            this.settings = candidate;
        }
        this.d103UserLocation = location;
        this.d103CommittedSettings = structuredClone(this.settings);
    }

    persistD103UserSettings() {
        const settings = {};
        for (const key of D103_USER_KEYS) {
            if (this.settings[key] !== undefined) {
                settings[key] = this.settings[key];
            }
        }
        const location = this.d103UserLocation;
        if (fs.existsSync(location)) {
            const stat = fs.lstatSync(location);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new Error("D103CN user configuration is not a regular file");
            }
        }
        const tmp = location + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
        try {
            const fd = fs.openSync(tmp, "wx", 0o600);
            try {
                fs.writeFileSync(fd, JSON.stringify(settings, null, 2) + "\n");
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmp, location);
            const dir = fs.openSync(path.dirname(location), "r");
            try {
                fs.fsyncSync(dir);
            } finally {
                fs.closeSync(dir);
            }
        } finally {
            if (fs.existsSync(tmp)) {
                fs.unlinkSync(tmp);
            }
        }
    }

    /**
     * @public
     * @param {(key: string) => void} listener
     */
    onUpdate(listener) {
        this.eventEmitter.on(CONFIG_UPDATE_EVENT, listener);
    }

    /**
     * @private
     */
    loadConfig() {
        /* load an existing configuration file. if it is not present or invalid, create it using the default configuration */
        if (fs.existsSync(this.location)) {
            Logger.info("Loading configuration file:", this.location);

            try {
                //@ts-ignore
                const ajv = new Ajv({removeAdditional: true});
                Object.keys(SCHEMAS.components.schemas).forEach(schemaName => {
                    ajv.addSchema(SCHEMAS.components.schemas[schemaName], "#/components/schemas/" + schemaName);
                });

                const config = fs.readFileSync(this.location, {"encoding": "utf-8"}).toString();
                const parsedConfig = JSON.parse(config);

                if (parsedConfig._version !== Tools.GET_VALETUDO_VERSION()) {
                    Logger.info(`Migrating config from ${parsedConfig._version} to ${Tools.GET_VALETUDO_VERSION()}`);

                    // BEGIN migration code to be removed with the next version

                    delete(parsedConfig.mqtt?.customizations?.provideMapData);
                    delete(parsedConfig.mqtt?.interfaces);

                    // END migration code to be removed with the next version

                    parsedConfig._version = Tools.GET_VALETUDO_VERSION();
                }

                if (!ajv.validate(SCHEMAS.components.schemas.Configuration, parsedConfig)) {
                    Logger.error("Error while validating configuration file", ajv.errors);

                    // noinspection ExceptionCaughtLocallyJS
                    throw new Error("Schema Validation Error");
                }

                this.settings = nestedObjectAssign(
                    {},
                    this.settings,
                    parsedConfig
                );

                if (this.getSerializedConfig() !== config) {
                    Logger.info(`Schema changes were applied to the configuration file at: ${this.location}`);

                    this.persist();
                }
            } catch (e) {
                Logger.error("Invalid configuration file: ", e.message);
                Logger.info("Writing new configuration file using defaults");

                try {
                    fs.renameSync(this.location, this.location + ".backup");
                    Logger.info(`Backup moved to ${this.location}.backup`);
                } catch (e) {
                    Logger.info("Failed to move backup", e);
                }

                this.settings._version = Tools.GET_VALETUDO_VERSION();
                this.persist();
            }
        } else {
            Logger.info(`No configuration file present. Creating one at: ${this.location}`);
            Tools.MK_DIR_PATH(path.dirname(this.location));

            this.persist();
        }
    }

    /**
     * @public
     */
    reset() {
        Logger.info("Restoring config to default settings.");

        // A config reset should not reset the robot config
        const robotSettings = this.settings.robot;

        this.settings = structuredClone(DEFAULT_SETTINGS);
        this.settings.robot = robotSettings;

        this.persist();

        Object.keys(this.settings).forEach(key => {
            this.eventEmitter.emit(CONFIG_UPDATE_EVENT, key);
        });
    }

    /**
     * @private
     */
    getSerializedConfig() {
        return JSON.stringify(this.settings, null, 2);
    }
}

const CONFIG_UPDATE_EVENT = "ConfigUpdated";
// Never carry over embedded, robot, generated IP, or implementation settings.
const D103_USER_KEYS = ["webserver", "mqtt", "ntpClient", "networkAdvertisement", "updater",
    "duststreaming", "timers", "logLevel", "debug", "oobe", "valetudo"];

module.exports = Configuration;
