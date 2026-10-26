const childProcess = require("child_process");
const util = require("util");

const CleaningHistoryCapability = require("../../../core/capabilities/CleaningHistoryCapability");

const execFile = util.promisify(childProcess.execFile);

/** @extends CleaningHistoryCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNCleaningHistoryCapability extends CleaningHistoryCapability {
    constructor(options) {
        super(options);
        this.pages = new Map();
    }

    async getHistory({limit, offset}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
            throw new Error("Invalid history page");
        }
        const key = `${limit}:${offset}`;
        const cached = this.pages.get(key);
        if (cached && Date.now() - cached.created < 15000) {
            return cached.promise;
        }
        // Coalesce concurrent requests and retain at most eight small pages.
        if (this.pages.size >= 8) {
            this.pages.delete(this.pages.keys().next().value);
        }
        const promise = this.readPage(limit, offset);
        const entry = {created: Date.now(), promise: promise};
        this.pages.set(key, entry);
        try {
            return await promise;
        } catch (e) {
            if (this.pages.get(key) === entry) {
                this.pages.delete(key);
            }
            throw e;
        }
    }

    async readPage(limit, offset) {
        // Fixed path, no shell, validated integer pagination. -readonly prevents
        // creation or writes even if the database is missing; query_only adds
        // a second guard. The stock CLI reads the live database consistently.
        const sql = "PRAGMA query_only=ON; SELECT json_object('total', " +
            "(SELECT count(*) FROM clean_log), 'rows', json((SELECT json_group_array(" +
            "json_object('id', rowid, 'startTime', StartTime, 'parameters', CleanParameter)) " +
            "FROM (SELECT rowid, StartTime, CleanParameter FROM clean_log " +
            `ORDER BY StartTime DESC, rowid DESC LIMIT ${limit} OFFSET ${offset}))));`;
        let output;
        try {
            output = await execFile("/usr/bin/sqlite3", [
                "-readonly", "-batch", "-bail", "-noheader", "-init", "/dev/null",
                "/data/config/ava/clean_log.db", sql
            ], {timeout: 3000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8"});
        } catch (e) {
            // Never return stderr/database content (which may contain private
            // fields) through the public error response.
            throw new Error("The stock cleaning history database is unavailable or busy");
        }
        const page = JSON.parse(output.stdout);
        if (!Number.isInteger(page.total) || page.total < 0 || !Array.isArray(page.rows)) {
            throw new Error("Invalid stock cleaning history response");
        }
        /** @type {import("../../../core/capabilities/CleaningHistoryCapability").CleaningRecord[]} */
        const records = [];
        let skippedRecords = 0;
        for (const row of page.rows) {
            try {
                if (typeof row.parameters !== "string" || row.parameters.length > 32768 ||
                    !/^[A-Za-z0-9+/]+={0,2}$/.test(row.parameters)) {
                    throw new Error("Invalid record encoding");
                }
                const p = JSON.parse(Buffer.from(row.parameters, "base64").toString("utf8"));
                if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.startTime) || row.startTime < 0 ||
                    ![p.CleanTime, p.CleanSize, p.WorkMode].every(n => Number.isFinite(n) && n >= 0)) {
                    throw new Error("Invalid record fields");
                }
                records.push({
                    id: String(row.id), startedAt: row.startTime * 1000,
                    duration: p.CleanTime * 60, area: p.CleanSize * 10000,
                    completed: p.CleanComplete === 1 ? true : p.CleanComplete === 0 ? false : null,
                    nativeMode: p.WorkMode
                });
            } catch (e) {
                skippedRecords++;
            }
        }
        return {records: records, total: page.total, offset: offset, limit: limit, skippedRecords: skippedRecords, hasMore: offset + page.rows.length < page.total};
    }
}

module.exports = D103CNCleaningHistoryCapability;
