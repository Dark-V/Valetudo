/* Native D103CN feature contracts. No transport, setters or emulated device. */
const READ_PROPERTIES = Object.freeze([
    [4, 12], [4, 27], [4, 28], [4, 33], [4, 36],
    [5, 1], [5, 2], [5, 3], [9, 1], [10, 1], [11, 2], [18, 1],
    [4, 40], [12, 2], [12, 3], [12, 4]
]);

const segmentId = value => Number.isInteger(value) && value >= 1 && value <= 255;
const coordinate = value => Number.isFinite(value) && value >= -32768 && value <= 32767;
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(coordinate);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keysAre = (value, names) => object(value) && Object.keys(value).sort().join(",") === names.slice().sort().join(",");

function jsonObject(value) {
    if (typeof value !== "string" || value.length > 16384) {
        return null;
    }
    try {
        const decoded = JSON.parse(value);
        return object(decoded) ? decoded : null;
    } catch (_) {
        return null;
    }
}

function validTask(inputs) {
    if (inputs.length === 1) {
        // Same mapping pass used by upstream DreameMappingPassCapability.
        return inputs[0].piid === 1 && inputs[0].value === 21;
    }
    if (inputs.length !== 2 || inputs[0].piid !== 1 || inputs[1].piid !== 10) {
        return false;
    }
    const mode = inputs[0].value;
    const payload = jsonObject(inputs[1].value);
    if (mode === 23 && keysAre(payload, ["tpoint"])) {
        return Array.isArray(payload.tpoint) && payload.tpoint.length === 1 &&
            payload.tpoint.every(row => Array.isArray(row) && row.length === 4 &&
                row.slice(0, 2).every(n => Number.isInteger(n) && coordinate(n)) && row[2] === 0 && row[3] === 0);
    }
    if (mode === 20 && keysAre(payload, ["points"])) {
        const rows = payload.points;
        return Array.isArray(rows) && rows.length === 1 && rows.every(row =>
            Array.isArray(row) && row.length === 5 && row.slice(0, 2).every(n => Number.isInteger(n) && coordinate(n)) &&
            Number.isInteger(row[2]) && row[2] >= 1 && row[2] <= 4 &&
            Number.isInteger(row[3]) && row[3] >= 0 && row[3] <= 3 &&
            Number.isInteger(row[4]) && row[4] >= 1 && row[4] <= 3);
    }
    if (mode === 18 && keysAre(payload, ["selects"])) {
        const rows = payload.selects;
        return Array.isArray(rows) && rows.length > 0 && rows.length <= 64 &&
            new Set(rows.map(row => Array.isArray(row) ? row[0] : null)).size === rows.length &&
            rows.every(row => Array.isArray(row) && row.length === 5 && segmentId(row[0]) &&
                Number.isInteger(row[1]) && row[1] >= 1 && row[1] <= 4 &&
                Number.isInteger(row[2]) && row[2] >= 0 && row[2] <= 3 &&
                Number.isInteger(row[3]) && row[3] >= 1 && row[3] <= 3 &&
                Number.isInteger(row[4]) && row[4] >= 1 && row[4] <= 64);
    }
    if (mode === 19 && keysAre(payload, ["areas"])) {
        const rows = payload.areas;
        return Array.isArray(rows) && rows.length > 0 && rows.length <= 4 && rows.every(row =>
            Array.isArray(row) && row.length === 7 && row.slice(0, 4).every(coordinate) &&
            row[0] !== row[2] && row[1] !== row[3] &&
            Number.isInteger(row[4]) && row[4] >= 1 && row[4] <= 4 &&
            Number.isInteger(row[5]) && row[5] >= 0 && row[5] <= 3 &&
            Number.isInteger(row[6]) && row[6] >= 1 && row[6] <= 3);
    }
    return false;
}

function validMapEdit(inputs) {
    if (inputs.length !== 1 || inputs[0].piid !== 4) {
        return false;
    }
    const p = jsonObject(inputs[0].value);
    if (keysAre(p, ["cpt"]) && keysAre(p.cpt, ["addcpt", "nocpt"])) {
        return [p.cpt.addcpt, p.cpt.nocpt].every((rows, kind) => Array.isArray(rows) && rows.length <= 20 &&
            rows.every((row, i) => Array.isArray(row) &&
                (kind === 0 ? [5, 6].includes(row.length) : [4, 6].includes(row.length)) &&
                row.slice(0, 4).every(n => Number.isInteger(n) && coordinate(n)) &&
                row[0] < row[2] && row[1] < row[3] &&
                (kind === 0 ? row[4] === i + 1 : row.length === 4 || row[4] === 0) &&
                (row.length < 6 || Number.isInteger(row[5]) && row[5] >= 0 && row[5] <= 255)));
    }
    if (keysAre(p, ["msr"])) {
        return Array.isArray(p.msr) && p.msr.length === 2 && p.msr.every(segmentId) && p.msr[0] !== p.msr[1];
    }
    if (keysAre(p, ["dsr", "dsrid"])) {
        return vector(p.dsr, 4) && Array.isArray(p.dsrid) && p.dsrid.length === 5 &&
            p.dsr.every((x, i) => x === p.dsrid[i]) && segmentId(p.dsrid[4]) &&
            (p.dsr[0] !== p.dsr[2] || p.dsr[1] !== p.dsr[3]);
    }
    if (keysAre(p, ["nsr"]) && object(p.nsr) && Object.keys(p.nsr).length === 1) {
        const [id, name] = Object.entries(p.nsr)[0];
        return /^[1-9]\d{0,2}$/.test(id) && segmentId(Number(id)) && keysAre(name, ["type", "name"]) &&
            name.type === 0 && typeof name.name === "string" && name.name.length > 0 && name.name.length <= 688 &&
            /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(name.name);
    }
    if (keysAre(p, ["vw"]) && keysAre(p.vw, ["rect", "line", "mop"])) {
        return [p.vw.rect, p.vw.line, p.vw.mop].every(rows => Array.isArray(rows) && rows.length <= 20 &&
            rows.every(row => vector(row, 4) && (row[0] !== row[2] || row[1] !== row[3])));
    }
    return keysAre(p, ["cm"]) && keysAre(p.cm, []);
}

function actionAllowed(args) {
    if (!args || !Array.isArray(args.in) || args.in.some(p => !object(p) || !Number.isInteger(p.piid))) {
        return false;
    }
    if (args.siid === 4 && args.aiid === 1) {
        return validTask(args.in);
    }
    if (args.siid === 6 && args.aiid === 2) {
        return validMapEdit(args.in);
    }
    if (args.siid === 4 && args.aiid === 4) {
        return args.in.length === 1 && args.in[0].piid === 10 && ["2,1", "1,0", "3,1", "3,0"].includes(args.in[0].value);
    }
    if (args.siid === 4 && args.aiid === 3) {
        return args.in.length === 1 && args.in[0].piid === 10 && args.in[0].value === "[114]";
    }
    if (args.siid === 15 && args.aiid === 1 && args.in.length === 0) {
        return true;
    }
    return args.in.length === 0 && args.aiid === 1 && [7, 9, 10, 11, 18].includes(args.siid);
}

function writeAllowed(p) {
    if (!p) {
        return false;
    }
    if (p.siid === 5) {
        return (p.piid === 1 && typeof p.value === "boolean") ||
            ([2, 3].includes(p.piid) && typeof p.value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(p.value));
    }
    return p.siid === 4 && Number.isInteger(p.value) && (
        ([12, 27, 33].includes(p.piid) && [0, 1].includes(p.value)) ||
        (p.piid === 28 && [1, 2, 3].includes(p.value)) ||
        (p.piid === 36 && [1, 2].includes(p.value)) ||
        (p.piid === 40 && [2, 3, 4].includes(p.value))
    );
}

module.exports = {READ_PROPERTIES: READ_PROPERTIES, actionAllowed: actionAllowed, writeAllowed: writeAllowed};
