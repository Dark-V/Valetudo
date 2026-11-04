# Xiaomi Mijia M30S / D103CN port

Tested factory firmware: **4.5.6_1409**, Athena **r2405_release**, ARMv7.
Original Valetudo baseline: **359a212e6897a31cea8df623b107fcb4a1373386**.
This experimental fork is independent of upstream Valetudo. Use at your own risk;
there is no promise against device damage, loss of configuration or bricking.
Keep the robot blocked from the Internet after granting root/SSH access.

## Source history

The `d103cn` branch contains the port. `master` retains upstream history.
PRs [1вЂ“18](https://github.com/Dark-V/Valetudo/pulls?q=is%3Apr+is%3Amerged)
reconstruct the **actual backend source** from the saved v1вЂ“v18 pkg artifacts.
Their original hashes and scope are in [history](../docs/d103cn/history/).
Intermediate frontend TypeScript snapshots were not preserved; the complete
current frontend is consolidated in v18. These PRs are a retrospective import,
not a claim that each intermediate source tree reproduces its original frontend.

## What works and what remains unverified

- Native live maps: rooms, robot position, station, travelled path; standard
  Dreame map coordinates and Valetudo entities.
- Native detected doorway overlay: clear/blocked/unknown **map clearance**,
  with tap details and native save time. Physical open/closed status is not
  reported reliably by this firmware; [analysis and limits](DOORWAYS.md).
- Open the editor from **Map Management**. When the floor has rooms, the brush
  is ready to edit their saved boundaries. Choose a room and paint adjacent
  cells, including previously occupied or unexplored ground inside the saved
  map frame. A stroke can also reopen a cell that already has the right room
  ID. Save while docked. After firmware confirmation, **Clean** starts that
  room. Use the mouse wheel to zoom.
  To trim a room, select its name, choose **Eraser** next to **Brush**, drag
  over its cells and select **Save room**. Erased cells become unknown on the
  robot's saved map. They are not no-go zones: a later scan can map them again.
  On the tested firmware, the route planner fills small enclosed holes (up to
  100 map cells) surrounded by the same room. An erased hole can therefore
  remain part of that room for routing. Use a restricted zone to exclude it.
  Erasing across a room boundary leaves the neighbouring room alone. Use
  **Undo** before saving, or **More → Undo saved room edit** after saving.
  The brush changes the saved room and its 25 mm probability samples. Only
  unknown or occupied samples under the stroke receive a weak free reading.
  The robot can revise those readings on later scans. Physical barriers and
  virtual restrictions still apply. A stroke must keep rooms connected.
  Undo checks the edited cells against their saved values and refuses to
  overwrite a newer observation. A single save may change up to 8,192 cells.
- Draw a manual door between the jambs, mark it open, closed or unknown, then
  save. These positions and labels belong to the owner and survive new scans of
  the same floor. The door state records the owner's last selection.
  Select a saved door and choose **Preview navigation wall here** to stage a
  separate firmware restriction. **Save** in the wall editor while docked to
  block that passage. Remove the restriction there to reopen the route.
- **Navigation walls** supports drawing, moving the line or either endpoint,
  and removing a barrier. Saving waits for the stock map to report the lines.
  Open **More** for display-only corrections and other editor settings. The
  stock split and merge tools are also available.
- The room editor captures the factory backup, edits the divider masks and
  room information in that archive, and supplies it to the stock restore
  service through loopback. Confirmation requires both native segmentation
  files and a fresh robot map to show the changed cells. Normal undo reverses
  those cells on a fresh backup. Keep `/data/.valetudo/room-recovery/` and
  `/data/.valetudo/map-editor/` in owner backups.
  Each floor can hold 65,536 painted cells and 128 manual doors.
- Verified on firmware 4.5.6_1409 with the robot docked. A 5 cm boundary cell
  changed rooms inside both the planner's active `segment_map` and its latest
  segmentation input. Undo returned the cell and the three stock segmentation
  images to their original values. Seventeen reference cells across seven
  rooms kept their assignments. A separate 5 cm virtual-wall endpoint edit
  was reported by the firmware and reverted. No cleaning run was started.
- An unlocalized isolated-room scan is displayed in its own local coordinates.
  It is never overlaid on the saved apartment map or offered for room profiles.
  The standard pending-map dialog saves a new floor (`cw=5`) only when native
  multi-floor maps are enabled; it does not use the overwrite choice (`cw=1`).
  Actual acceptance of a new isolated-room map remains hardware-unverified.
- Native room/zone commands, four cleaning modes, mop extension, careful
  navigation, carpet settings, maintenance and restrictions are exposed.
- Native spot cleaning was physically tested and confirmed by the owner.
- Manual carpet rectangles were written, independently read back, and removed
  successfully. Physical mop lift over a carpet remains unverified.
- Drying duration was changed and restored with native readback. MQTT's actual
  broker delivery and full robot reboot/autostart remain separate pending tests.
- Station operations are visible even without manual dock-action buttons: mop washing, drying and dust collection. Native drying countdown/progress, API/SSE delivery and browser display were verified on the robot; the existing drying job and stock AVA continued uninterrupted. Washing/emptying phases still need direct observation.
- Experimental leased **monochrome navigation camera**, not an RGB camera.
  Camera helpers restore the original exposure and do not open `/dev/video1`.
- Real Valetudo stop/restart restored the stock SDK/agent and resumed live maps.

## Build Valetudo

Use Node >=20, the committed lockfile and the repository's normal build tools:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/patch-package/index.js --error-on-fail
cd frontend
node scripts/build.js
cd ..
node util/build_openapi_schema.mjs
cd backend
node ../node_modules/pbjs/cli.js --es5 ./lib/robots/midea/generated/midea_protobufs.js ../assets/protobuf/midea.proto
node ../util/generate_build_metadata.js
PKG_CACHE_PATH=../build_dependencies/pkg node ../node_modules/@yao-pkg/pkg/lib-es5/bin.js --targets node22-linuxstatic-armv7 --compress GZip --no-bytecode --public-packages '*' --options 'expose-gc,max-heap-size=42' . --output ../build/d103cn/valetudo
```

The tested packaging runtime is `built-v22.17.1-linuxstatic-armv7`. Use the GZip
package option above for this port; the hardware has little spare CPU during
native navigation. Follow upstream build-dependency preparation; do not
substitute x86 or ARM64. Building does not
require executing the ARM program or emulating a robot. Do not run the Mock robot
or MQTT documentation generator as part of this workflow.

## Assemble the local SDK runtime

The camera and SDK wrapper source lives here. Factory firmware/scripts, private
maps, Wi-Fi credentials, tokens, SSH keys and captures are **not redistributed**.
The SDK binaries come from the pinned public
[dustbuilder features repository](https://github.com/dgiese/dustbuilder-features)
at `8f42a2e3c4e580691165cb26fa7ec64c3700cfb8`; origins/hashes are in
[sdk-sources.json](sdk-sources.json). The assembly script reads exact Git blobs,
verifies hashes and applies the saved small script deltas to your own stock files.

1. Clone that features repository with the pinned commit available.
2. Copy `/ava/script/msg_cvt.sh` and `/ava/script/fds_hook.sh` from **your own**
   matching firmware to a private `stock-scripts` directory on the PC, preserving
   bytes. A different firmware fails the hash check rather than receiving a guessed patch.
3. Cross-compile the camera helpers with a Linux ARMv7 hard-float toolchain, e.g. Zig:

```sh
mkdir -p build/d103-camera
zig cc -target arm-linux-musleabihf -mcpu=cortex_a7 -O2 -static d103cn/camera/camera-frames.c -lm -o build/d103-camera/camera-frames
zig cc -target arm-linux-musleabihf -mcpu=cortex_a7 -O2 -static d103cn/camera/camera-controls.c -o build/d103-camera/camera-controls
python d103cn/assemble_package.py --features-dir ../dustbuilder-features --stock-scripts ../stock-scripts --binary build/d103cn/valetudo --camera-binaries build/d103-camera --output build/d103cn-package
```

This **only assembles files on the PC**; it does not install, start, flash or
emulate anything. Existing output directories are never overwritten.

## Runtime and recovery

The tested package root is `/data/.valetudo`; `/data/valetudo` is a compatibility
symlink. Runtime configuration/logs and SDK namespace files are created privately
under `/tmp`. Port **18080** serves the UI; local FDS uses **8079**. The runtime
validates exact stock hashes, model, RAM/temperature, process identity and local
binding. It requires matching local UID `1337` in `device.uid` and
`/data/config/ava/clean_log.json`; do not replace the whole cleaning-history file.
The script refuses to start if this prior local-binding setup is absent.

The launcher disables `wlan0` power saving without reconnecting Wi-Fi or changing
credentials. On the tested board this reduced a gzip UI asset download from
14.6 seconds to 1.7 seconds. SDK IPC frames with no `method` are ignored without
dispatch; a named method outside the existing allowlist still stops the bridge.
The last ignored/rejected frame stays in the private RAM runtime directory.

For an already prepared installation:

```sh
sh /data/.valetudo/start.sh
sh /data/.valetudo/status.sh
sh /data/.valetudo/stop.sh
```

Starting uses a temporary SDK namespace and RAM binds; it does not rewrite
boot/rootfs. Stock services are restored on stop. Existing SSH/Wi-Fi/UART hooks
must be kept. The package does not enable autostart by itself. The optional
`autostart.sh` needs an explicitly installed boot/network hook and enable marker;
the presence of the file alone does not enable it. Full `/data` formatting can
remove all of these files. Keep backups **off the robot** and preserve a working
SSH/UART recovery route before changing an installation.

NTP defaults to disabled in the public template; configure your LAN NTP server.
The upstream updater remains disabled because an upstream release would replace
this unsupported model port. Never publish an assembled package containing your
device configuration or a raw NAND dump.

Valetudo retains its Apache-2.0 license. Tasshack protocol reference material is
credited under its [MIT license](LICENSE-Tasshack). External SDK/firmware blobs
retain their respective upstream rights and are not bundled in this fork.
