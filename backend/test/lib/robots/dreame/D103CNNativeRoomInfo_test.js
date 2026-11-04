const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const {describe, it} = require("node:test");
const {prepare} = require("../../../../lib/robots/dreame/D103CNNativeRoomInfo");

const size = {x: 6554, y: 6554};
const rooms = {1: {nei_id: [7]}, 7: {nei_id: [1]}};
const neighbors = Buffer.from(JSON.stringify({
    RoomIdAndColorLookUpTable: {RoomIds: [1, 7]},
    RoomNeighborTable: [{room_id: 1, room_neighbor_id: [7]}, {room_id: 7, room_neighbor_id: [1]}]
}));

// A single cell at the coordinate-system origin, with no household geometry.
function frame(pixel, metadata) {
    const bytes = Buffer.alloc(28);
    bytes.writeInt16LE(1, 0);   // floor ID
    bytes.write("I", 4);        // complete frame
    bytes.writeInt16LE(50, 17); // 50 mm
    bytes.writeInt16LE(1, 19);
    bytes.writeInt16LE(1, 21);
    bytes[27] = pixel;
    return zlib.deflateSync(Buffer.concat([bytes, Buffer.from(JSON.stringify(metadata))])).toString("base64url");
}

function roomInfo(saved, live, isHistory) {
    return Buffer.from(JSON.stringify({
        last_app_map_id: 1,
        last_app_map: frame(live, {curid: 1, ris: 2, iscleanlog: isHistory, rism: frame(saved, {seg_inf: rooms})}),
        seg_info: JSON.stringify(rooms)
    }));
}

function pixels(buffer) {
    const outer = zlib.inflateSync(Buffer.from(JSON.parse(buffer).last_app_map, "base64url"));
    const inner = zlib.inflateSync(Buffer.from(JSON.parse(outer.subarray(28)).rism, "base64url"));
    return {saved: inner[27], live: outer[27]};
}

function stroke(from) {
    return {x: 655, y: 655, from: from, to: 7, before: {obstacle: from}};
}

describe("D103CN native room edits", () => {
    it("keeps the stock cleaning log intact and accepts an inverse after it is republished", () => {
        const edit = stroke(7);
        // Observed on the device before and after a real occupancy correction.
        const normalized = roomInfo(7, 0, true);
        assert.deepEqual(pixels(prepare(normalized, size, 5, [edit], neighbors)), {saved: 7, live: 0});
        assert.deepEqual(pixels(prepare(normalized, size, 5, [edit], neighbors, true)), {saved: 7, live: 0});
        assert.deepEqual(pixels(prepare(roomInfo(1, 4, true), size, 5, [stroke(1)], neighbors)), {saved: 7, live: 4});
    });

    it("retries the v36.4 journal after the firmware replaces its projected live byte with zero", () => {
        const oldEdit = {...stroke(7), ri: [7, 0]};
        assert.deepEqual(pixels(prepare(roomInfo(7, 0, true), size, 5, [oldEdit], neighbors, true)), {saved: 7, live: 0});
    });

    it("keeps a later live observation on undo but refuses to overwrite a changed saved cell", () => {
        const edit = stroke(1);
        const applied = prepare(roomInfo(1, 4, false), size, 5, [edit], neighbors);
        assert.deepEqual(pixels(applied), {saved: 7, live: 28});
        assert.deepEqual(pixels(prepare(applied, size, 5, [edit], neighbors, true)), {saved: 1, live: 4});
        assert.deepEqual(pixels(prepare(roomInfo(7, 252, false), size, 5, [edit], neighbors, true)), {saved: 1, live: 252});
        assert.throws(() => prepare(roomInfo(135, 252, false), size, 5, [edit], neighbors, true), /saved room cell has changed/);
    });

    it("clears a carpet-marked saved cell and restores its flag without changing cleaning history", () => {
        const edit = {...stroke(7), to: 0};
        const original = roomInfo(0x47, 31, true);
        const erased = prepare(original, size, 5, [edit], neighbors);
        assert.deepEqual(pixels(erased), {saved: 0, live: 31});
        assert.deepEqual(pixels(prepare(erased, size, 5, [edit], neighbors, true)), {saved: 0x47, live: 31});
    });
});
