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

## Which edits affect native navigation?

- **Room boundaries.** The stock map action (MIOT service 6, action 2, property 4)
  accepts `dsr`/`dsrid` for a straight split and `msr` for a merge. A native split
  on this firmware changed the room IDs and areas while leaving the SLAM grid
  byte-for-byte intact. An arbitrary room polygon or pixel-writing action has
  not been identified. The room brush uses the separate factory backup/restore
  service to update the saved segmentation and, for reopened cells, the occupancy grid.
- **Barriers and thresholds.** The stock `vw` command sets navigation restrictions,
  including virtual walls. `vws` is a separate threshold-setting command. Neither
  edits the physical walls in the SLAM grid.
- **Structural doors.** `AvaNodeRoute::AppEditMap` in `node_limos.so` references
  `wallInfoV2`, `wallInfoV3`, and `doorInfoV3`. `OnRequestEditWalls` in
  `node_map_divide.so` (0xf2354) checks the selected floor before storing the
  structural description. The [Dreame integration's editor](https://github.com/Tasshack/dreame-vacuum/blob/f5b8472b8e2e4bb3dff7bc2a81a5fd594eca9585/custom_components/dreame_vacuum/dreame/map.py#L3261-L3345)
  moves the endpoints of existing walls/doors and preserves their counts. A
  newly drawn door or an open/closed label in Valetudo therefore cannot establish
  that a physical opening exists or that the robot will cross it.
- **Raster storage.** A stock backup from this D103CN contains the version 1.4
  ProbabilityGrid (`fine_large.bin`, 25 mm cells), five derived PNGs, room
  adjacency, door geometry and the floor's `.dat2` state. Replacing a PNG does
  not update that grid or keep the other files in sync. For a reopened cell the room brush also edits
  the corresponding four 25 mm samples in the ProbabilityGrid, the divider
  rasters and the SDK room frame. New lidar observations can replace the
  correction. Virtual walls and no-go zones remain separate.

The editor validates the displayed floor against the selected floor's saved
room raster (`last_app_map` в†’ `rism` in its `.dat2`). A captured SDK frame
retained the previous floor's ID after a switch. Comparing room geometry in
three recorded frames accepted all three matching references and rejected the
other floor each time. This check does not measure the live position of a door.
