# D103CN doorway data and its limits

Factory firmware investigated: **4.5.6_1409**, Athena **r2405_release**.
This feature is an overlay of detected openings and **map clearance**. It does
not provide a live physical door sensor.

## What `door_status` means in the inspected producer

The stock `node_map_divide.so` SHA256 is
`0a0641e2fef9309955bcada3d2862a0a8b7cdd3556300e25de75c6b453004a91`.
Static analysis establishes the following:

- `SaveUnifiedDoorsInfo`, at `0x13b0d4`, writes the seven-integer `IndoorDoor`
  record: type, ID, status, start X/Y, end X/Y. Status is the field at offset 8.
- The three `DoorManager::AddDoor(int, ...)` overloads for `AvaDoor`,
  `SegmentLine`, and `_Door<int>` are at `0xc6f3c`, `0xc6fbc`, and `0xc703c`.
  **All three explicitly initialize both ID and status to zero.**
- `DoorManager::AddDoor(IndoorDoor const&)`, at `0xc6d58`, stores that record;
  it does not derive an open/closed state.
- The inspected saved files contain only status 0. This is the producer's
  default/unspecified value, not evidence that a door is open or closed.
  No trustworthy physical-state mapping for nonzero values was established.

The implementation therefore preserves any raw status in entity metadata and
reports `doorState: "unknown"`. It never guesses `0=open` or `1=closed`.

## Related structures

| Structure | Meaning established from native code/data | Used by the overlay |
| --- | --- | --- |
| `all_doors_info.json` | Automatically detected opening geometry, with endpoints and rasterized line points | Geometry authority; bounded lengths, deduplicated |
| `doors_info_large.json` | Segmentation lines, including `user_line_` and `new_line_`; a user-created room split is recorded here | Investigated; not treated as physical doors |
| `unified_doors_info.json` | Aggregates origins and reserves type/ID/status fields | Raw metadata only, matched by endpoints |
| `vision_doors_info.json` | Separate vision-derived geometry; empty in the inspected captures | No state inferred from its absence |
| `room_neighbor_table_large.json` | Room IDs and adjacency topology | Ensures the selected native floor matches the displayed rooms |
| `out_walls_large.json` | Structural walls and storey-level door arrays; captured type/status values were both zero | Investigated; no confirmed physical-state enum |
| SDK `walls_info.storeys[].doors` | Door records also parsed by the Dreame Home Assistant integration | Not observed as a trustworthy physical-state channel on this D103CN |
| SDK `area_clean_detail` | Native reports explaining unreachable rooms; the external integration distinguishes door, threshold, virtual wall and obstacle causes | Investigated; no such report was present in the inspected D103CN frames |

`door_type` is an origin/category, not the open/closed state. Call sites in
`AddAllInputDoors` show type 1 for the laser-opening path and type 3 for the
sliding-door path. `MapDivideProcess` also adds generated/segmentation paths,
including type 9. Treating every unified entry as a physical door would show
many false doors, including manual room boundaries.

Reference for the distinct blocked-room reason channel:
[Dreame integration types](https://github.com/Tasshack/dreame-vacuum/blob/master/custom_components/dreame_vacuum/dreame/types.py).
The integration's `ObstacleReason.BLOCKED_BY_DOOR` is reason 3; it is **not** a
definition of `door_status=3`.

## Display and freshness

The read-only reader follows `/data/ri/config.json2`'s selected native floor.
It rejects changing/oversized files, mismatched room IDs and unlocalized local
scans. It never combines openings from different coordinate systems.

Grid coordinates use the factory `CvtGrid2MM` at `0x12d6c8`:
`(cell - 1800 + 0.5) * 0.05 * 1000`, followed by the existing Dreame-to-Valetudo
coordinate conversion. The conversion was checked against actual native
segmentation and SDK map captures.

- **Green:** the middle of the opening is clear in the displayed occupancy map.
- **Red:** the opening is predominantly occupied in that map.
- **Amber/dashed:** there is insufficient or conflicting map evidence.

The ribbon sampling excludes door jambs. Green needs at least 80% known free
samples and at most 10% wall samples; red needs at least 65% wall samples.
Unknown pixels do not become free pixels. This estimates map traversability,
not the current position of a door leaf. A door can change after mapping.

Tapping an opening shows that distinction and the native geometry save time.
The map legend explicitly says "map clearance". Ordinary room geometry,
segmentation, profiles, timers and native navigation are not modified.

## Verification boundary

The parser was exercised on two real native captures with 3 and 5 detected
openings. Existing map layers and non-door entities were unchanged. All eight
were clear in their respective saved maps and retained unknown physical state.
No robot emulator or synthetic closed-door fixture was used. A real
closed/open transition and fresh physical-state reporting remain unverified.
