const childProcess = require("child_process");
const fs = require("fs");

const MAX_PACKED = 8 * 1024 * 1024;
const MAX_TAR = 16 * 1024 * 1024;
const BLOCK = 512;
const BACKUP = "/tmp/map_bak.tbz2";
const DIVIDE_FILES = [
    "laser_steps_info.json", "map_roi_large.json", "all_doors_info.json", "carpet_path_large.txt",
    "contours_with_obstacle_large.png", "segmented_map_large.png", "room_neighbor_table_large.json",
    "doors_info_large.json", "slam_map.png", "segmented_map_color.png", "unified_doors_info.json",
    "vision_doors_info.json", "carpet_map_large.json", "user_confirm.txt", "out_walls_large.json",
    "segmented_map_with_obstacle_large.png"
];
const EDITABLE = ["segmented_map_large.png", "segmented_map_with_obstacle_large.png",
    "segmented_map_color.png", "room_neighbor_table_large.json"];

function check(ok, message) {
    if (!ok) {
        throw new Error("Native map archive: " + message);
    }
}

function packed(data) {
    check(Buffer.isBuffer(data) && data.length >= 14 && data.length <= MAX_PACKED &&
        /^BZh[1-9]1AY&SY$/.test(data.toString("latin1", 0, 10)), "invalid bzip2 stream");
}

function octal(bytes) {
    const text = bytes.toString("latin1");
    check(/^[ 0-7]*[0-7][\0 ]*$/.test(text), "invalid tar numeric field");
    return parseInt(text.trim(), 8);
}

function checksum(header) {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
        sum += i >= 148 && i < 156 ? 32 : header[i];
    }
    return sum;
}

function zero(bytes) {
    return bytes.every(n => n === 0);
}

function layout(floorId) {
    check(Number.isSafeInteger(floorId) && floorId >= 0 && floorId <= 999999, "invalid native floor ID");
    const id = String(floorId);
    return {
        directories: new Set([id, "ai", "ai/" + id, "divide", "divide/" + id]),
        files: new Set([id + ".dat2", ...["map_status.json", "fine_large.bin", "docker_pose_large.json"].map(x => id + "/" + x),
            ...["ai_rooms_large.txt", "ai_furnitures_large.txt", "ai_floors_large.txt"].map(x => "ai/" + id + "/" + x),
            ...DIVIDE_FILES.map(x => "divide/" + id + "/" + x)]),
        required: [id + ".dat2", id + "/fine_large.bin", id + "/docker_pose_large.json",
            ...["map_roi_large.json", "room_neighbor_table_large.json", "slam_map.png", "contours_with_obstacle_large.png",
                "segmented_map_large.png", "segmented_map_with_obstacle_large.png", "segmented_map_color.png"]
                .map(x => "divide/" + id + "/" + x)]
    };
}

function readTar(raw, floorId) {
    const allowed = layout(floorId);
    check(Buffer.isBuffer(raw) && raw.length >= 3 * BLOCK && raw.length <= MAX_TAR && raw.length % BLOCK === 0,
        "unexpected raw tar size");
    const entries = [], seen = new Set(), members = new Map();
    let pos = 0;
    while (pos + BLOCK <= raw.length) {
        const header = raw.subarray(pos, pos + BLOCK);
        if (zero(header)) {
            break;
        }
        check(entries.length < 64 && header.toString("latin1", 257, 265) === "ustar  \0" &&
            zero(header.subarray(157, 257)) && zero(header.subarray(345, 512)), "unsupported tar header or link");
        check(checksum(header) === octal(header.subarray(148, 156)), "tar header checksum mismatch");
        check(octal(header.subarray(108, 116)) === 0 && octal(header.subarray(116, 124)) === 0 &&
            octal(header.subarray(100, 108)) <= 0o777, "unexpected tar owner or special permission bits");
        const end = header.indexOf(0), directory = header[156] === 53;
        check(end > 0 && end < 100 && zero(header.subarray(end, 100)) && (directory || header[156] === 48),
            "invalid tar name or member type");
        const rawName = header.toString("latin1", 0, end);
        const name = directory ? rawName.replace(/\/$/, "") : rawName;
        check((directory ? allowed.directories : allowed.files).has(name) && !seen.has(name), "unexpected or duplicate member");
        const size = octal(header.subarray(124, 136)), start = pos + BLOCK, next = start + Math.ceil(size / BLOCK) * BLOCK;
        check(size <= 8 * 1024 * 1024 && (!directory || size === 0) && next + 2 * BLOCK <= raw.length &&
            zero(raw.subarray(start + size, next)), "invalid tar member size or padding");
        const body = raw.subarray(start, start + size);
        entries.push({name: name, header: header, body: body});
        if (!directory) {
            members.set(name, body);
        }
        seen.add(name);
        pos = next;
    }
    check(raw.length - pos >= 2 * BLOCK && zero(raw.subarray(pos)), "truncated tar terminator");
    check(allowed.required.every(name => members.get(name)?.length > 0), "incomplete stock floor bundle");
    return {entries: entries, members: members, floorId: floorId};
}

function replaceTar(archive, replacements) {
    const id = String(archive.floorId), allowed = new Set([id + ".dat2", ...EDITABLE.map(n => "divide/" + id + "/" + n)]);
    const edits = replacements instanceof Map ? new Map(replacements) : new Map(Object.entries(replacements));
    check(edits.size && [...edits].every(([name, data]) => allowed.has(name) && archive.members.has(name) &&
        Buffer.isBuffer(data) && data.length && data.length <= 8 * 1024 * 1024), "invalid replacement");
    const blocks = [];
    let total = 2 * BLOCK;
    for (const {name, header, body} of archive.entries) {
        const replacement = edits.get(name);
        let h = header;
        if (replacement) {
            h = Buffer.from(header);
            h.write(replacement.length.toString(8).padStart(11, "0") + "\0", 124, 12, "latin1");
            h.write(checksum(h).toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
        }
        const data = replacement || body, padding = (BLOCK - data.length % BLOCK) % BLOCK;
        total += BLOCK + padding + data.length;
        check(total <= MAX_TAR, "candidate bundle exceeds supported size");
        blocks.push(h, data, Buffer.alloc(padding));
    }
    blocks.push(Buffer.alloc(2 * BLOCK));
    return Buffer.concat(blocks, total);
}

// Only compression runs in a child. No tar extractor ever sees an archive,
// and no firmware filename is interpolated into a shell.
function bzip(data, encode) {
    const limit = encode ? MAX_PACKED : MAX_TAR;
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn("/bin/busybox", encode ? ["bzip2", "-6", "-c"] : ["bunzip2", "-c"],
            {stdio:["pipe", "pipe", "ignore"]});
        const chunks = [];
        let bytes = 0, failed = false;
        const timer = setTimeout(() => fail("bzip2 timed out"), 30000);
        function fail(message) {
            if (!failed) {
                failed = true;
                clearTimeout(timer);
                proc.kill("SIGKILL"); reject(new Error("Native map archive: " + message));
            }
        }
        proc.on("error", err => fail(err.message));
        proc.stdin.on("error", err => fail(err.message));
        proc.stdout.on("error", err => fail(err.message));
        proc.stdout.on("data", chunk => {
            bytes += chunk.length;
            if (bytes > limit) {
                fail("bzip2 output exceeds limit");
            } else if (!failed) {
                chunks.push(chunk);
            }
        });
        proc.once("close", code => {
            clearTimeout(timer);
            if (code !== 0) {
                fail("bzip2 integrity check failed");
            } else if (!failed) {
                resolve(Buffer.concat(chunks, bytes));
            }
        });
        proc.stdin.end(data);
    });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class D103CNNativeArchive {
    static async read(original, floorId) {
        packed(original);
        const data = readTar(await bzip(original, false), floorId);
        return {...data, original: original};
    }

    static async repack(archive, replacements) {
        const raw = replaceTar(archive, replacements);
        const compressed = await bzip(raw, true);
        packed(compressed);
        check((await bzip(compressed, false)).equals(raw), "compressed candidate did not round-trip");
        return compressed;
    }

    /** The stock uploader may unlink the file before the backup action's
     * result arrives. Hold a descriptor, then independently validate the
     * bzip2 and tar ends and required members before accepting any bytes.
     * triggerBackup must itself validate the MIOT action acknowledgement.
     * @param {number} floorId
     * @param {() => Promise<unknown>} triggerBackup
     */
    static async capture(floorId, triggerBackup) {
        layout(floorId);
        try {
            fs.lstatSync(BACKUP);
            throw new Error("Stock backup already present");
        } catch (err) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }
        let stop = false, fd;
        const deadline = Date.now() + 25000;
        const readWhenComplete = async () => {
            let previousSize = -1, lastAttempt = -1;
            while (!stop && Date.now() < deadline) {
                if (fd === undefined) {
                    try {
                        fd = fs.openSync(BACKUP, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
                    } catch (err) {
                        if (err.code !== "ENOENT") {
                            throw err;
                        }
                    }
                }
                if (fd !== undefined) {
                    const stat = fs.fstatSync(fd);
                    check(stat.isFile() && stat.uid === 0 && stat.size <= MAX_PACKED, "invalid stock backup file");
                    if (stat.size >= 14 && stat.size === previousSize && stat.size !== lastAttempt) {
                        lastAttempt = stat.size;
                        const body = Buffer.alloc(stat.size);
                        let count = 0;
                        while (count < body.length) {
                            const n = fs.readSync(fd, body, count, body.length - count, count);
                            if (!n) {
                                break;
                            }
                            count += n;
                        }
                        if (count === body.length) {
                            try {
                                return await D103CNNativeArchive.read(body, floorId);
                            } catch (err) {
                                if (!stat.nlink && fs.fstatSync(fd).size === stat.size) {
                                    throw err;
                                }
                            }
                        }
                    }
                    previousSize = stat.size;
                }
                await wait(35);
            }
            throw new Error("A complete factory backup could not be captured");
        };
        let timeout;
        try {
            const started = readWhenComplete();
            const action = Promise.race([
                Promise.resolve().then(triggerBackup),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error("Stock backup action timed out")), 30000);
                })
            ]);
            const [archive] = await Promise.all([started, action]);
            return archive;
        } finally {
            stop = true;
            clearTimeout(timeout);
            if (fd !== undefined) {
                fs.closeSync(fd);
            }
        }
    }
}

D103CNNativeArchive.readTar = readTar;
D103CNNativeArchive.replaceTar = replaceTar;
module.exports = D103CNNativeArchive;
