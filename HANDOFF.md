# CR-6 SE Pen Plotter — Handoff

**The plotter works.** Read this before touching anything.

Original build guide: `docs/cr6se-plotter-build-guide.md`
(phases 0–12). Phases 1–4 and 9 are done. Owner does physical work; you do
software over SSH.

---

## Connecting

- Pi: `plotter.local` or `192.168.1.239`, user `jkevin`, SSH by key from the
  owner's laptop. Passwordless sudo.
- Mainsail: `http://plotter.local` · Moonraker API: port 7125
- Config in git at `~/plotter/` (printer.cfg, macros.cfg, tools/, art/)
- mDNS drops out occasionally — fall back to the IP.

## Hardware

- Creality **v4.5.2** board flashed with Klipper (`~/plotter/firmware/plot001.bin`,
  STM32F103, 28 KiB bootloader, USART1). Stock touchscreen is dead by design.
- Toolhead is **owner-built**: LM8UU bearings on 8 mm smooth rods,
  **gravity loaded — no spring, no rubber band** (both were tried, abandoned).
  Pen force = carriage mass. To change line weight, add or remove mass.
  Never try to increase pressure by driving Z lower — it cannot go lower.
- Carriage float: **15.9 mm** (owner measured 0.6278 in).

---

## THE Z RULE — non-negotiable

**Z0 IS the writing height AND the absolute floor.** `stepper_z position_min: 0`,
so Klipper itself rejects any move below it (verified: `G1 Z-1` returns
"Move out of range"). `PEN_DOWN` goes to Z0 and no further.

There is no Z endstop. The reference is set **by hand** every time and lives
only in motion state.

---

## The workflow — THREE SENDS

The owner confirmed this model and wants it preserved:

1. **Z height** — jog down until the pen writes with the carriage floating,
   then `PLOT_ZERO_HERE`
2. **Corner** — put the pen on the **bottom-left** corner of the card, then set
   the origin from that corner plus the card's measured dimensions
3. **Plot** — generate, upload, start

Steps 1 and 2 need the pen physically positioned, so they cannot be batched.
Step 3 is one action. Once set, further plots are a single action.

### Setting the origin from ONE corner (USE THIS)

Two-corner sighting (`PLOT_P1`/`PLOT_P2`) is still available but **one corner
plus the owner's measured dimensions is better and is what finally worked**:
it removes a whole sighting error and takes the size from a ruler rather than
from two eyeballed points.

With the pen on the bottom-left corner at machine (x, y) and card W x H:

    centre = (x + W/2, y + H/2)
    SET_GCODE_OFFSET X=<cx> Y=<cy>
    SET_GCODE_VARIABLE MACRO=_PLOT_VARS VARIABLE=paper_w VALUE=<W>
    SET_GCODE_VARIABLE MACRO=_PLOT_VARS VARIABLE=paper_h VALUE=<H>

Worked example: corner X23 Y59, card 150x100 -> centre X98 Y109. Perfect plot.

---

## Gotchas that cost real time today

- **Lift must exceed the carriage compression.** At the writing height the
  carriage is pushed up off its stop. If `lift` is smaller than that
  compression the pen never leaves the paper and every travel move draws —
  the output is scribbles. 2 mm was not enough; **10 mm works**. Default is
  now 10 in macros.cfg.
- **A restart wipes homing AND the Z reference AND the origin AND paper size.**
  Everything except what is in the config files. After any restart: re-home,
  re-set the corner, re-set Z.
- **Never restart Klipper while the machine is in a hand-set state.** Prefer
  `SET_GCODE_VARIABLE` over config edits mid-session. This ruined the owner's
  setup more than once.
- **`idle_timeout` used to run M84 after 10 min**, silently destroying the Z
  reference. Fixed: `timeout: 86400` and a gcode that does NOT drop motors.
- **`PLOT_END` used to call M84** — same problem after every finished plot.
  Removed. Its park move also overran the rail because it ignored the active
  gcode offset; now offset-aware.
- **Pen macros must check `"z" in printer.toolhead.homed_axes`**, not just an
  internal flag. A flag alone once said "zeroed" while Klipper had unhomed,
  and a job started and slammed the carriage into the bed.
- **Don't read a position immediately after `G28`.** The second homing pass is
  still running and you will read a wrong number. Cost two false alarms.
- **After homing, X/Y park at -5,-2 which is OFF the plate.** Move back over
  the bed before doing anything.
- **vpype writes closed paths as `<polygon>` and cannot read `<polygon>` back.**
  Any round-trip through an intermediate SVG silently loses closed geometry.
  Do all processing in ONE pipeline.
- **vpype `layout` enforces portrait** unless `--landscape` is passed. Without
  it a landscape sheet is laid out portrait and the centring is off by half
  the difference.
- **Writing tool files from Windows introduces CRLF** and breaks the shebang.
  Always normalise to LF before scp.
- **SVG layers are drawn in order** (layer 1, then layer 2). The owner's card
  art has `art` and `text` layers, so the text plots last. A late position
  error therefore looks like "only the text moved".

## UNRESOLVED

One card was ruined: the text landed on top of the cake. Suspected skipped
steps from `max_accel` 500 -> 2500, and the acceleration was reverted — **but
the final perfect card also ran at 2500**, so acceleration is probably NOT the
cause. The more likely explanation is an origin/corner error, since that
attempt used two-corner sighting and the successful one used the single-corner
method. Treat as unexplained. If it recurs, drop `max_accel` to 500 first.

**Z at 30 mm/s is proven, not open.** The perfect card ran 529 pen lifts, every
one at `z_up_feed` 1800 = 30 mm/s. Skipped steps would have drifted the writing
height over 529 cycles and the line would have faded out or dug in partway
through. It did not. That is a far more demanding test than a 25-cycle macro.

`ZSPEEDTEST N=25` is loaded and has never been run. It is now only worth
running if the speed is pushed **above** 30.

---

## Current tuned values

| Setting | Value | Notes |
|---|---|---|
| `max_accel` | 2500 | raised from 500; produced a perfect plot |
| `square_corner_velocity` | 8 | |
| `max_z_velocity` | 30 | raised from 15; proven over 529 lifts on the good card |
| `lift` | 10 mm | must exceed carriage compression |
| | | **`macros.cfg` in this repo says 2.0 and is STALE** — the machine reports 10 |
| `z_up_feed` / `z_down_feed` | 1800 / 900 | down is slower on purpose: no spring to absorb landing |
| `idle_timeout` | 86400 | must never drop motors |

**Plot time is dominated by pen lifts, not drawing.** At lift 10 mm each path
costs ~1.0 s. A 527-path drawing is ~8m47s of lifting and under a minute of
drawing. To speed up: fewer paths (`--filter-min`), or a smaller lift.

---

## Tools on the Pi (`machine/tools/` here, `~/plotter/tools/` on the Pi, all on PATH)

- **`plot`** — SVG to plotted. Layout, optimise, filter, gcode, preview,
  time estimate, upload. Origin is the paper CENTRE. Dry run is the default
  and flies at Z20 to clear magnets. Key flags: `--size WxH`, `-m` margin,
  `--pen`, `--filter-min`, `--dry-z`, `--keep-layers`, `--go`.
- **`genart`** — flow / spiral / moire / lissajous generative art.
- **`mkpulsar`** — ridgeline plot with hidden-line removal.
- **`mkcard`** — greeting card, auto-sized Hershey text plus a cake.
- **`mkcalib`** — Phase 10 calibration sheet.

vpype 1.15 with gwrite, hatched, vectrace, flow_img. Hershey `text` is built
into vpype core — no plugin needed.

**SVG artwork must be line art**: stroked paths, `fill="none"`. A filled SVG
plots as the OUTLINE of the filled regions (coloring-book look) and produces
hundreds of tiny contours, each costing a pen lift.

Raster artwork is a different matter: since 2026-08-23 the app traces PNG/JPG
itself and handles solid shapes deliberately, so this restriction does not
apply to images. See below.

---

## The Windows app is BUILT

`app/dist/Plotter.exe` - one portable file, 89 MB,
no install, no Python. Source and full notes in `app/README.md`.
Electron, matching MZ Forge and Anvil.

It replaces `plot` + vpype entirely for day to day use. The Pi stays plain
Klipper + Moonraker; the app does SVG parsing, curve flattening, transforms,
linemerge, linesort, reloop, simplify, filter, layout and gcode in-process.
The Pi tools still work and are untouched.

The three sends are the UI: three cards, each carrying only its own controls
(Z jog inside step 1, the XY pad inside step 2). Dry run is ON by default.

### It traces drawings too (2026-08-23)

Drop a PNG or JPG of line art in step 3 and it becomes paths in-process. No
Inkscape, no potrace, no autotrace: Electron decodes the image itself.

Ink is split by thickness and the two halves are treated differently:

- **Thin strokes get their centreline**, so the pen draws each line once
  instead of once down each side.
- **Solid shapes get an outline plus a hatch.** Thinning a filled shape does
  not give its middle, it gives a spiky spine. Eyebrows, eyelashes, pupils and
  lips all fail that way, and a face traced without this has scribbles for
  eyes. "Fill over mm" is the dividing line.

Everything lands on **one layer** — layers are for pen changes and a traced
drawing is one pen's work. "Save traced SVG" writes it out as reusable artwork.

### And it writes (2026-08-23)

Type a message and it is drawn in a **single-stroke font**: each letter is the
path the pen travels, not an outline. Plotting a normal font draws hollow
balloon letters. Eighteen fonts ship inside the app, nothing to install.

Size is cap height in mm, and text is composed AFTER the artwork is fitted, so
5 mm means 5 mm on the card whatever the art was scaled by. Works with artwork
or alone.

**If the artwork already has type rendered into it, blank that area first**
("Blank an area", drag on the preview). Rendered type traces into broken
letters and no setting fixes it.

### Going faster

Pen lifts dominate, ~1.0 s each at the live lift 10 / feeds 1800/900.
**Merge mm is the lever.** Measured on a traced portrait: 0.1 mm gives 1977
paths / 36m 26s, 0.5 gives 1034 / 20m 56s, 1.0 gives 548 / 12m 58s, 2.0 gives
248 / 8m 11s.

**0.5 is free** — indistinguishable from 0.1 by eye, and 43% quicker. Beyond
that merging draws THROUGH gaps: at 1.0 a stippled beard joins into zigzags, at
2.0 the teeth are gone. Fine detail breaks first, so a portrait wants 0.5 and a
bold line drawing will take 2. Travel ordering is not worth touching; it is
~20 s of a twenty-minute plot.

Verified against the live machine on 2026-08-23: read-only status parse,
35 geometry, 40 tracer and 39 text tests, the cake card end to end (747 paths,
14m 24s real / 1m 57s dry), a 1228x1281 wedding portrait traced to 1995 strokes
and 10.29 m of draw in about a second, and the packaged .exe booting,
connecting and tracing.

### What it refuses to do, and why

- Send when the sheet the gcode was laid out for does not match the sheet the
  machine is set to. **This is the error that ruined the card.**
- Send at all unless preflight passes: Klipper ready, X/Y homed, Z referenced,
  Z0 set, paper size set, nothing already printing.
- Drop the motors on cancel. It lifts the pen and leaves them on, so the Z
  reference survives.
- Call `PLOT_END`. Loaded copies of that macro have run `M84`. It emits
  `PEN_UP` + a plain lift instead, the same known-good ending `plotter.toml`
  uses.

### Still by hand

The writing height. It is a physical position with no endstop, so after a
restart the app can restore the corner and the card size from memory but the
Z reference has to be re-set by jogging. The app says so in the banner.

### Note on the local config copies

`macros.cfg` in this folder is STALE against the Pi: it still says lift 2.0,
feeds 900/600, and a `PLOT_END` that calls `M84`. The live machine has lift 10
and feeds 1800/900. The app reads `_PLOT_VARS` off the machine at connect
rather than trusting any local file. Worth pulling the Pi's copy back down
into this repo.

## ALSO PLANNED: hotspot fallback

The owner wants to take the Pi and plotter to places where devices cannot see
each other and IPs change (e.g. work). Plan: NetworkManager AP profile with
lower autoconnect priority than the home network, so it joins `coronawireless`
at home and otherwise broadcasts its own network at a fixed address.

**This is the change most likely to lose SSH access to the Pi.** Do it with a
revert timer, and not while a plot is running.

Also worth doing: a DHCP reservation for the Pi on the owner's UDM Pro.

---

## Working with this owner

- He is hands-on and fast. Give the value, not the reasoning.
- **Never start a plot unless he has clearly asked for it in that moment.**
  Starting one on an assumption wasted a real card and his time.
- Ask before physical actions that could damage something, but do not stack up
  questions — he gets frustrated with repeated confirmation.
- When he corrects you, fix it and move on. Do not explain at length, and do
  not shift blame onto him — his corners were right when I suggested otherwise.
- Verify with a command rather than assuming; several bugs today were only
  caught by actually running the thing.
