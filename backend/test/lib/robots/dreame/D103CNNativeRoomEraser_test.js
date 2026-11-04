const assert = require("node:assert/strict");
const Fine = require("../../../../lib/robots/dreame/D103CNNativeFineGrid");
const Mask = require("../../../../lib/robots/dreame/D103CNNativeRoomMask");
const {describe, it} = require("node:test");

// A five-column saved divider. Top/bottom rows: 0 7 7 1 1. Middle row: 7 7 7 1 1.
// (655,655) is the rightmost room 7 pixel in the top row.
const png = b64 => Buffer.from(b64, "base64");
const rooms = Buffer.from(JSON.stringify({
    RoomIdAndColorLookUpTable: {RoomIds: [1, 7]},
    RoomNeighborTable: [{room_id: 1, room_neighbor_id: [7]}, {room_id: 7, room_neighbor_id: [1]}]
}));
const labels = png("iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAAAAAB+XZokAAAAGElEQVR4nGNkYGf4xcDEzsDAwMD0E0QCABOOAgchUVdIAAAAAElFTkSuQmCC");
const files = {
    "map_roi_large.json": Buffer.from(JSON.stringify({width: 3600, height: 3600, x_min: 1798, x_max: 1803, y_min: 1800, y_max: 1803})),
    "room_neighbor_table_large.json": rooms,
    "segmented_map_large.png": labels, "segmented_map_with_obstacle_large.png": labels,
    "slam_map.png": png("iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAAAAAB+XZokAAAADklEQVR4nGP4z4AAYDYAFfwB/+1xorYAAAAASUVORK5CYII="),
    "contours_with_obstacle_large.png": png("iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAAAAAB+XZokAAAAGElEQVR4nGPY8v////+M/xkYGBiYtoJIAFRiBmhUVqiiAAAAAElFTkSuQmCC"),
    "segmented_map_color.png": png("iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAIAAADUVFKvAAAAIklEQVR4nGNkYGBI97/BwMAgxmvGwMDABOHAAdPMjRrIfACSxgTt2Yfr/wAAAABJRU5ErkJggg==")
};
const mapSize = {x: 6554, y: 6554};
const pixelSize = 5;
const strokes = (...runs) => Mask.editsFromRuns(files, mapSize, pixelSize, runs);
const change = (edits, source = files, restoring = false) => ({
    ...source, ...Mask.prepare({files: source, mapSize: mapSize, pixelSize: pixelSize, edits: edits, restoring: restoring})
});

describe("D103CN native room eraser", () => {
    it("clips a wide eraser to the selected room and preserves its neighboring room", () => {
        const edits = strokes([655, 655, 3, "erase:7"]);
        assert.deepEqual(edits.map(e => [e.x, e.y, e.from, e.to]), [[655, 655, 7, 0]]);
        const erased = change(edits);
        assert.ok(Mask.matches(erased, mapSize, pixelSize, edits));
        const targetLayer = Mask.editableLayers(erased, mapSize, pixelSize).find(l => l.metaData.segmentId === "1");
        assert.equal(targetLayer.metaData.area, 6 * pixelSize * pixelSize);
        assert.deepEqual(erased["room_neighbor_table_large.json"], rooms);
        assert.ok(Mask.matches(change(edits, erased, true), mapSize, pixelSize, edits, true));
    });

    it("refuses to split the room into islands by erasing its entire middle row", () => {
        assert.throws(() => change(strokes([653, 654, 3, "erase:7"])), /splits or removes room 7/);
    });

    it("restores the underlying draft when the eraser crosses a freshly painted neighboring room or unknown pixel", () => {
        const edits = strokes(
            [653, 655, 1, "room:7"], [656, 655, 1, "room:7"],
            [653, 655, 4, "erase:7"], [654, 655, 1, "room:7"]
        );
        assert.deepEqual(edits.map(e => [e.x, e.y, e.from, e.to]), [[655, 655, 7, 0]]);
    });

    it("clears observed 25 mm samples, restores their history exactly, and retains a later scan", () => {
        // Stock ProbabilityGrid 1.4 encoding. Each row has two target samples and one neighboring sample.
        const data = Buffer.from("aabb00000033010400192000200000040fff0fff10011000010000001c42438181819a0001137d102030408400257e81ba81c11357819b81dfeeff", "hex");
        const erased = Buffer.from("aabb00000025010400192000200000040fff0fff10011000010000000e88001020304088001357819b81dfeeff", "hex");
        const rescanned = Buffer.from("aabb00000027010400192000200000040fff0fff100110000100000010001086001020304088001357819b81dfeeff", "hex");
        const edits = strokes([655, 655, 1, "erase:7"]);
        Fine.capture(data, edits);
        assert.deepEqual(Fine.correct(data, edits), erased);
        assert.ok(Fine.matches(erased, edits, false));
        assert.deepEqual(Fine.correct(erased, edits, true), data);
        assert.equal(Fine.matches(rescanned, edits, false), false);
        assert.throws(() => Fine.correct(rescanned, edits, true), /changed/);
    });
});
