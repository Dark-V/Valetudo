const Archive = require("./D103CNNativeArchive");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const Info = require("./D103CNNativeRoomInfo");
const Mask = require("./D103CNNativeRoomMask");
const path = require("path");
const {sleep} = require("../../utils/misc");

const ROOT = "/data/.valetudo/room-recovery";
const RECOVER = "/data/multmap_recover";
const READ = [[2,1],[2,2],[3,2],[4,7],[6,11],[6,14]];
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const busy = phase => phase === "applying" || phase === "restoring";
function check(ok, message, status = 409) {
    if (!ok) {
        throw Object.assign(new Error(message), {status: status});
    }
}

function file(name, max = 8 * 1024 * 1024) {
    const stat = fs.lstatSync(name);
    check(stat.isFile() && stat.size > 0 && stat.size <= max, "Invalid native map file: " + path.basename(name));
    return fs.readFileSync(name);
}

function persist(name, bytes) {
    fs.mkdirSync(ROOT, {recursive: true, mode: 0o700});
    const tmp = name + "." + crypto.randomUUID();
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, name);
        const dir = fs.openSync(ROOT, "r");
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

function desired(current, runs) {
    check(Array.isArray(runs) && runs.length > 0 && runs.length <= 4096, "Choose a room and paint some cells.", 400);
    const edits = new Map();
    let count = 0;
    for (const run of runs) {
        check(Array.isArray(run) && run.length === 4, "Invalid room stroke", 400);
        const [x,y,length,paint] = run;
        check(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(length) &&
            x >= 0 && y >= 0 && length > 0 && x + length <= current.width && y < current.height &&
            typeof paint === "string" && /^room:[1-9]\d?$/.test(paint), "A native stroke must select a room on this floor.", 400);
        const to = Number(paint.slice(5));
        count += length;
        check(count <= 65536 && current.rooms.has(3 + to), "Invalid room or too many painted cells", 400);
        for (let cx = x; cx < x+length; cx++) {
            const key = y*current.width+cx, code = current.raster[key];
            check(code > 3, "The stroke crosses an obstacle, unassigned floor, or an unscanned cell. Paint the existing mapped rooms.");
            const from = code-3;
            if (from !== to) {
                edits.set(key, {x: cx, y: y, from: from, to: to});
            } else {
                edits.delete(key);
            }
        }
    }
    check(edits.size > 0, "Those cells already belong to the selected room.");
    return [...edits.values()];
}

function nativeFiles(floorId) {
    const dir = "/data/DivideMap/" + floorId + "/";
    return Object.fromEntries(Mask.files.map(name => [name, file(dir + name)]));
}

// Recovery replaces these directories, so a merely readable tar is insufficient:
// reject a backup that would discard an unrecognized file from the selected floor.
function exactSnapshot(archive,id) {
    for (const [live,prefix] of [["/data/map/"+id,id+"/"],["/data/DivideMap/"+id,"divide/"+id+"/"],
        ["/data/DivideAI/ai_result/"+id,"ai/"+id+"/"]]) {
        const names = [...archive.members.keys()].filter(n => n.startsWith(prefix));
        if (!fs.existsSync(live)) {
            check(names.length === 0, "Unexpected floor directory in the backup.");
            continue;
        }
        const entries = fs.readdirSync(live);
        check(entries.length === names.length && entries.every(n => archive.members.get(prefix+n)?.equals(file(live+"/"+n))),
            "Stock backup is incomplete or this floor just changed. No changes applied.");
    }
    check(archive.members.get(id+".dat2")?.equals(file("/data/ri/"+id+".dat2")), "Native RI changed after backup.");
}

class D103CNNativeRoomEditor {
    constructor(robot) {
        this.robot = robot;
        this.instruction = null;
        this.working = false;
        this.journal = path.join(ROOT, "last.json");
        this.record = {phase: "idle", message: "", floorId: null, operationId: null, roomIds: []};
        if (fs.existsSync(this.journal)) {
            try {
                const previous = JSON.parse(file(this.journal).toString());
                check(Number.isInteger(previous.floorId) && /^[a-f0-9-]{36}$/.test(previous.operationId), "Invalid recovery journal");
                this.record = previous;
                if (busy(previous.phase)) {
                    this.record.phase = "needs_recovery";
                    this.record.message = "Valetudo restarted during a native edit. Inspect the map or restore the saved floor.";
                }
            } catch (_) {
                this.record.phase = "needs_recovery";
                this.record.message = "The native recovery journal is unreadable. Check the private backup before editing.";
            }
        }
    }

    status() {
        const {phase,message,floorId,operationId,roomIds} = this.record;
        const current = this.robot.mapEditor.current?.floorId;
        return {phase: phase, message: message, floorId: floorId ?? current ?? null, operationId: operationId, roomIds: roomIds,
            available: current !== undefined && !this.working && phase !== "needs_recovery",
            canRollback: !this.working && (current === floorId || (phase === "needs_recovery" && current === undefined)) && !!operationId &&
                ["confirmed","needs_recovery"].includes(phase)};
    }

    get blocksNavigation() {
        return this.working || this.record.phase === "needs_recovery";
    }

    async command(method, args) {
        // Only this exact in-flight object may bypass the ordinary RPC allowlist.
        this.instruction = args;
        try {
            return await this.robot.sendCommand(method, args, {timeout: 5500, noRetry: true});
        } finally {
            this.instruction = null;
        }
    }

    async stockState() {
        const props = await this.robot.miotHelper.readProperties(READ.map(([siid,piid]) => ({siid: siid,piid: piid})));
        return READ.map(([s,p]) => {
            const item = props.find(v => v.siid === s && v.piid === p && v.code === 0);
            check(item && Number.isInteger(item.value), "Native map service status is unavailable");
            return item.value;
        });
    }

    async requireDock(floorId) {
        const [status,fault,charge,task,recovery,backup] = await this.stockState();
        check([6,13].includes(status) && fault === 0 && charge === 1 && task === 0 &&
            ![1,2].includes(recovery) && ![1,2].includes(backup), "Dock the idle robot and wait for station and map operations to finish.");
        check(JSON.parse(file("/data/ri/config.json2").toString()).curr_id === floorId, "The native floor has changed.");
    }

    store(phase, message) {
        const record = {...this.record, phase: phase, message: message};
        persist(this.journal, JSON.stringify(record));
        this.record = record;
    }

    start(body, restore) {
        const r = this.robot, editor = r.mapEditor;
        check(!this.working, "A native map operation is already running.");
        const floor = body?.floorId;
        check(Number.isInteger(floor) && floor >= 0 && floor <= 999999, "Invalid floor", 400);
        const previous = this.record;
        let edits;
        if (restore) {
            check(floor === previous.floorId && body.operationId === previous.operationId &&
                /^[a-f0-9-]{36}$/.test(previous.operationId) && ["confirmed","needs_recovery"].includes(previous.phase),
            "No matching native backup is available.");
            edits = previous.edits;
        } else {
            check(this.record.phase !== "needs_recovery", "Recover the previous native edit before saving another.");
            editor.requireRevision(r.state.map, floor, body.revision);
            edits = desired(editor.current, body.runs);
        }
        this.working = true;
        const op = restore ? previous.operationId : crypto.randomUUID();
        this.record = {...(restore ? previous : {}), floorId: floor, operationId: op,
            phase: restore ? "restoring" : "applying", roomIds: [...new Set(edits.map(e => String(e.to)))],
            message: restore ? "Checking the saved native floor." : "Checking the native room mask.", edits: edits};
        this.execute(body, restore, previous).finally(() => {
            this.working = false;
        });
        return this.status();
    }

    async execute(body, restoring, previous) {
        const r = this.robot, op = this.record, id = op.floorId;
        const backupName = path.join(ROOT, op.operationId + ".tbz2");
        let sent = false, journaled = false;
        try {
            await this.requireDock(id);
            const grid = "/data/map/" + id + "/fine_large.bin";
            if (restoring && this.record.stage && fs.existsSync(RECOVER)) {
                this.releaseStage();
            }
            check(!fs.existsSync(RECOVER), "A stock recovery directory is already present. No map was replaced.");
            let archive, bytes;
            const emergency = restoring && previous.phase === "needs_recovery";
            if (emergency) {
                check(digest(file(grid)) === previous.gridHash, "The SLAM map changed since the backup; snapshot restore is disabled.");
                bytes = file(backupName);
                check(digest(bytes) === previous.backupHash, "The saved backup checksum does not match.");
            } else {
                const map = r.state.map;
                const revision = restoring ? r.mapEditor.describe(map).revision : body.revision;
                op.size = {...map.size};
                op.pixelSize = map.pixelSize;
                op.editorIdentity = r.mapEditor.current.identity;
                const live = nativeFiles(id);
                const changes = restoring ? op.edits.map(e => ({...e, from:e.to, to:e.from})) : op.edits;
                const replacements = Mask.prepare({files: live, mapSize: map.size, pixelSize: map.pixelSize, edits: changes});
                const space = fs.statfsSync("/data");
                check(space.bavail * space.bsize > 8*1024*1024, "Free at least 8 MiB on /data for native map recovery.");
                archive = await Archive.capture(id, async () => {
                    const ack = await this.command("action", {did: r.deviceId, siid: 6, aiid: 3,
                        in: [{piid: 4, value: String(id)}]});
                    check(ack?.code === 0, "Firmware rejected its own map backup.");
                });
                const prefix = "divide/" + id + "/";
                for (const name of Mask.files) {
                    check(archive.members.get(prefix+name)?.equals(live[name]), "Native rooms changed during backup. Reload and retry.");
                }
                const riName = id + ".dat2";
                const ri = archive.members.get(riName);
                const updates = Object.fromEntries(Object.entries(replacements).map(([name,buf]) => [prefix+name,buf]));
                updates[riName] = Info.prepare(ri, map.size, map.pixelSize, changes, replacements["room_neighbor_table_large.json"] ?? live["room_neighbor_table_large.json"]);
                const storedGrid = archive.members.get(id + "/fine_large.bin");
                op.gridHash = digest(storedGrid);
                bytes = await Archive.repack(archive, updates);
                exactSnapshot(archive,id);
                if (!restoring) {
                    op.backupHash = digest(archive.original);
                    persist(backupName, archive.original);
                }
                check(digest(file(backupName)) === op.backupHash && digest(file(grid)) === op.gridHash,
                    "Original map changed during backup.");
                await this.requireDock(id);
                r.mapEditor.requireRevision(r.state.map, id, revision);
                for (const name of Mask.files) {
                    check(file("/data/DivideMap/"+id+"/"+name).equals(live[name]), "Native divider changed before restore.");
                }
                check(file("/data/ri/"+riName).equals(ri), "Room configuration changed during backup. Reload and retry.");
            }
            archive = await Archive.read(bytes,id);
            await this.requireDock(id);
            this.store(restoring ? "restoring" : "applying", "Waiting for the firmware to load and publish the room mask.");
            journaled = true;
            const frames = r.mapFramesParsed;
            await this.feedStockRestore(id, archive, () => {
                sent = true;
            });
            await this.verify(op, restoring, frames);
            r.mapEditor.inheritRestoredFloor(r.state.map, op.editorIdentity);
            r.emitMapUpdated();
            this.store(restoring ? "restored" : "confirmed", restoring ? "Previous native map restored and verified." :
                "Saved on the robot. The native room mask and a new firmware map agree.");
            try {
                this.releaseStage();
            } catch (_) {
                this.store(this.record.phase, this.record.message + " Stock recovery staging still exists.");
            }
            if (!restoring && previous.operationId && previous.operationId !== op.operationId) {
                fs.rmSync(path.join(ROOT, previous.operationId + ".tbz2"), {force: true});
            }
        } catch (err) {
            const message = String(err.message).slice(0,320);
            if (journaled) {
                const phase = (sent && !err.rejected) || restoring ? "needs_recovery" : "failed";
                try {
                    this.store(phase, message);
                } catch (_) {
                    this.record = {...op, phase: "needs_recovery", message: message};
                }
            } else if (restoring || previous.phase === "confirmed" || previous.phase === "needs_recovery") {
                this.record = {...previous, message: message};
            } else {
                this.record = {...op, phase: "failed", message: message};
            }
        }
    }

    async feedStockRestore(id, archive, onSend) {
        const uri = "/native-room-map/" + crypto.randomUUID() + ".tbz2";
        let delivered = false;
        const server = http.createServer((req,res) => {
            if (req.method !== "GET" || req.url !== uri) {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, {"Content-Type":"application/octet-stream","Content-Length":archive.original.length});
            res.end(archive.original, () => {
                delivered = true;
            });
        });
        try {
            await new Promise((resolve,reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => resolve(undefined));
            });
            const address = /** @type {import("net").AddressInfo} */ (server.address());
            // An extant stock staging directory takes a separate fast path which
            // ignores the URL. Never let that directory substitute an old map.
            check(!fs.existsSync(RECOVER), "Stock map recovery is already staged.");
            const url = "http://127.0.0.1:" + address.port + uri;
            this.record.stage = {sums: Object.fromEntries([...archive.members].map(([key,value]) => [key,digest(value)]))};
            this.store(this.record.phase, this.record.message);
            onSend();
            const ack = await this.command("set_properties", [{did:this.robot.deviceId, siid:6, piid:10,
                value:JSON.stringify({map_id:id,map_url:url})}]).catch(() => null);
            if (ack !== null && (ack.length !== 1 || ack[0].code !== 0) && !delivered) {
                throw Object.assign(new Error("Firmware rejected the native map restore."), {rejected:true});
            }
            for (let n=0; n<70 && !delivered; n++) {
                await sleep(500);
            }
            check(delivered, "The firmware did not fetch the map backup over loopback.");
        } finally {
            server.closeAllConnections();
            server.close();
        }
    }

    releaseStage() {
        const stage = this.record.stage;
        if (!stage || !fs.existsSync(RECOVER) || !fs.lstatSync(RECOVER).isDirectory()) {
            return;
        }
        const remaining = [];
        const dirs = [];
        const walk = dir => {
            for (const name of fs.readdirSync(dir)) {
                const full = path.join(dir,name), stat = fs.lstatSync(full);
                if (stat.isDirectory()) {
                    walk(full);
                } else {
                    check(stat.isFile() && stage.sums[path.relative(RECOVER,full)] === digest(file(full)),
                        "Unrecognized file in the stock recovery staging directory.");
                    remaining.push(full);
                }
            }
            dirs.push(dir);
        };
        // Inspect every member before removing any. Firmware can consume a
        // subset during import; an unrelated staging tree must stay intact.
        walk(RECOVER);
        for (const name of remaining) {
            fs.unlinkSync(name);
        }
        for (const dir of dirs) {
            fs.rmdirSync(dir);
        }
    }

    async verify(op, restored, frames) {
        const r = this.robot;
        for (let i=0; i<65; i++) {
            if (i % 15 === 0) {
                r.pollMap().catch(() => {});
            }
            await sleep(2000);
            const state = await this.stockState().catch(() => null);
            if (!state) {
                continue;
            }
            check(![4,5].includes(state[4]), "Stock firmware reports map recovery failed.");
            const current = r.mapEditor.current;
            if ([1,2].includes(state[4]) || r.mapFramesParsed <= frames || current?.floorId !== op.floorId ||
                !current.raster || !op.edits.every(e => {
                const id = restored ? e.from : e.to;
                return current.raster[e.y*current.width+e.x] === (id ? id+3 : 1);
            })) {
                continue;
            }
            if (Mask.matches(nativeFiles(op.floorId),op.size,op.pixelSize,op.edits,restored) &&
                digest(file("/data/map/"+op.floorId+"/fine_large.bin")) === op.gridHash) {
                return;
            }
        }
        throw new Error("The new native room mask could not be verified on disk and in a fresh firmware frame. Backup retained.");
    }
}

module.exports = D103CNNativeRoomEditor;
