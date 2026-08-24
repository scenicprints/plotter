# CR-6 SE → Pen Plotter: Full Build Guide

A step-by-step conversion of a Creality CR-6 SE into a dedicated pen plotter running
Klipper on a Raspberry Pi. This machine will never 3D print again — that assumption
drives many of the decisions below.

**This document is written for two readers:**

- **[HUMAN]** — physical work, judgement calls, anything involving a screwdriver or eyeballs.
- **[CC]** — Claude Code, working over SSH on the Pi. Software, config, scripts, debugging.

Each phase ends with a **Done when** line. Do not move to the next phase until it's true.

---

## A note on ordering

The usual version of this build has a hard constraint: print your plastic parts before you
remove the hotend, because afterwards the machine can't make its own parts.

**That constraint does not apply here.** There are other printers available, so the pen
holder is not a one-shot design you have to get right before committing. It's an iterative
fit-and-refine loop that can run *while the CR-6 is already stripped and on the bench* —
which is strictly better, because you can measure the real bracket, test the real flex, and
reprint the same afternoon.

Phase 0 is therefore just measuring and shopping. The holder design gets its own phase
(Phase 6), positioned after the strip where it belongs.

---

## Verification policy for [CC]

Some details in this guide are version-sensitive and may have drifted. Before acting on
anything marked **[VERIFY]**, fetch current upstream documentation and reconcile. If
upstream contradicts this document, upstream wins — say so out loud rather than silently
following either one.

Primary sources:
- Klipper install & config: https://www.klipper3d.org/
- Klipper example configs: `klipper/config/` in the cloned repo
- KIAUH: https://github.com/dw-0/kiauh
- vpype: https://vpype.readthedocs.io/

---

# PHASE 0 — Print parts and buy things

## 0.1 [HUMAN] Print the parts that aren't design-sensitive

These don't interact with the toolhead, so there's nothing to iterate on. Print whenever.

| Part | Notes |
|---|---|
| Paper registration corners | L-shaped blocks, print 2–4 |
| Pi case or bed-frame mount | Optional, keeps wiring tidy |
| Cable strain relief | For the slimmed-down toolhead loom |

The pen holder and servo mount are **not** on this list. They depend on measurements you
can't take until the toolhead is bare. See Phase 6.

## 0.2 [HUMAN] Set aside a design printer

Pick whichever of the other machines has the best small-part accuracy and keep it loaded
with a filament you like. Phase 6 will ask it for four or five iterations over a day or
two, and you don't want that competing with a long print.

PETG is the better choice over PLA here — the holder sits under constant light spring
load, and PLA creeps under sustained stress over months.

## 0.3 [HUMAN] Shopping list

**Electronics**
- Raspberry Pi (any Pi 3B+ or newer; Pi Zero 2 W works but is slow to build firmware on)
- Good 5V power supply for the Pi — undervoltage causes bizarre, hard-to-diagnose faults
- microSD card for the Pi, 16 GB+
- **A second microSD card, 8 GB or smaller, for flashing the mainboard** (see 3.3)
- SG90 or MG90S 9g servo (MG90S has metal gears and is worth the extra dollar)
- Dupont jumper wires, female-to-female
- USB-A to USB-B cable (Pi → printer mainboard) — probably already have one
- *Optional:* mechanical microswitch for a Z endstop (see 4.4)

**Pens — buy in this order**

| Priority | Pen | Why |
|---|---|---|
| **Buy first** | **BIC Cristal ballpoint, box of 10** | Your calibration pen. Nearly indestructible, tolerates crashes and bad Z, costs nothing. Do all setup and testing with these. Never risk a good pen on an untuned machine. |
| **Buy first** | **Sakura Pigma Micron 05 (0.45 mm)** | The default "good" plotter pen. Pigment ink, archival, consistent line, doesn't bleed. The 05 is the sweet spot — finer tips (01, 005) fray faster and need slower speeds. |
| Add soon | **Sharpie Fine Point** | Dark, bold, cheap, bulletproof. Bleeds on cheap paper. Great for large generative work. |
| Add soon | **Uni-ball Signo / Sakura Gelly Roll, white** | For plotting on black paper, which looks fantastic and is half the reason people build these. |
| Technical work | **Staedtler Pigment Liner 308** or **Rotring Tikky Graphic** | Consistent widths in a matched set (0.1 / 0.3 / 0.5), good for drawings where line weight is semantic. |
| Later, if you get serious | **Rotring Isograph** (refillable) | Best line consistency available. Expensive, clogs if left uncapped or unused, needs actual maintenance. Not a starter pen. |

**Do not start with fineliners finer than 0.3 mm.** They fray on any paper that isn't
very smooth, and they punish Z errors that a ballpoint would shrug off.

**Paper**
- **Bristol board, smooth (not vellum) surface** — the plotter standard. Rough paper
  destroys fineliner tips.
- HP Premium32 or similar heavy smooth laser paper for cheap testing
- Black cardstock if you bought white gel pens

**Hold-down**
- Low-tack masking tape or small bulldog clips
- The printed registration corners from 0.1

**Done when:** registration corners printed, pens and paper ordered, Pi in hand, a design
printer standing by.

---

# PHASE 1 — Identify your mainboard

**Do this before downloading anything.** The CR-6 SE shipped with several different
boards across production runs, and flashing the wrong firmware is the one genuinely
risky step in this build.

## 1.1 [HUMAN] Open the base and read the silkscreen

Power off, unplug from mains, remove the bottom cover. Photograph the board. Look for:

- A version string silkscreened on the PCB (e.g. `CR-6 SE v4.5.2`, `v4.5.3`, `ERA`)
- The main MCU chip marking — read the text on the largest square chip. You're looking
  for something like `STM32F103RET6` or `GD32F303RET6`.
- Whether there are any **unused 3-pin headers** (5V / GND / signal). Photograph these
  and any labels near them. You may want one for the servo and one for a Z endstop.

Write down exactly what you see. Guessing here is how boards get bricked.

## 1.2 [CC] Determine the correct Klipper build target

**[VERIFY]** Given the board revision and MCU marking from 1.1, determine:
- Klipper `menuconfig` MCU family
- Correct **bootloader offset** (Creality 32-bit boards commonly use 28 KiB, but confirm
  for this specific revision)
- Communication interface (USB vs serial, and which pins)

Note for [CC]: some CR-6 SE boards use a **GD32F303**, which is a clone of the STM32F103.
Klipper handles this, but the correct target selection is a known gotcha. Check the
Klipper docs and the `klipper/config/` directory for a shipped CR-6 SE example config
before deciding. If you cannot establish this with confidence, **stop and say so** rather
than producing a firmware binary on a guess.

**Done when:** board revision, MCU part number, and Klipper build target are all written
down and agreed on.

---

# PHASE 2 — Raspberry Pi setup

## 2.1 [HUMAN] Flash and boot the Pi

- Raspberry Pi Imager → Raspberry Pi OS **Lite** (64-bit). No desktop needed.
- In the Imager's settings gear: set hostname (`plotter` is a good choice), enable SSH,
  set username/password, configure WiFi.
- Boot the Pi, confirm you can `ssh` in.

## 2.2 [HUMAN] Hand the Pi to Claude Code

Give [CC] SSH access. From here [CC] does the software work.

## 2.3 [CC] Install the Klipper stack

Use **KIAUH** (Klipper Installation And Update Helper) — it handles the whole stack and
its service wiring correctly.

Install, in order:
1. **Klipper**
2. **Moonraker** (the API layer — this is what lets you drive the machine programmatically)
3. **Mainsail** (web UI — the human will want this for jogging and emergency stop)

**[VERIFY]** KIAUH's repo URL and install procedure.

Set up a git repo at `~/plotter/` to version-control `printer.cfg`, macros, vpype configs,
and scripts. Commit after every working change. You will break things and want to walk back.

**Expect Mainsail to look half-broken** once you're running — empty temperature graphs, no
extruder panel. Nothing is wrong; you deleted those sections from `printer.cfg` on purpose
in Phase 4. The jog controls, console, and file manager are all you need from it. A
plotter-shaped replacement is Phase 12, deferred until you've actually used the machine.

**Done when:** Mainsail loads in a browser, `systemctl status klipper` is running (it will
report an MCU connection error — that's expected, nothing is flashed yet).

---

# PHASE 3 — Build and flash the mainboard firmware

## 3.1 [CC] Build the firmware

In `~/klipper`: run `make menuconfig` with the settings established in 1.2, then `make`.

Output lands at `~/klipper/out/klipper.bin`.

## 3.2 [CC] Prepare the binary

Copy `klipper.bin` to a **uniquely named** file — e.g. `plot001.bin`. Increment this
number on every reflash, forever.

**Why:** Creality bootloaders track the last-flashed filename and will silently skip a
file with a name it has already seen. A "failed flash" that is actually just a skipped
flash has eaten many hours.

## 3.3 [HUMAN] Flash it

- Use the **small (8 GB or under) SD card**, formatted **FAT32, 4096-byte allocation unit
  size**. Large cards and wrong cluster sizes are the #1 cause of Creality boards refusing
  to flash.
- The card should contain **only** the `plot001.bin` file. Nothing else.
- Printer **off**. Insert card. Power **on**. Wait 15–30 seconds. The screen may stay
  blank or show garbage — this is expected and fine.
- Power off, remove the SD card.

## 3.4 [HUMAN] Connect the Pi

USB cable from Pi to the printer mainboard. Power the printer on.

## 3.5 [CC] Find the MCU

Run Klipper's serial ID helper to get the `/dev/serial/by-id/...` path. Record it — it
goes in `printer.cfg`.

If nothing appears: the flash didn't take. Return to 3.2, increment the filename, and
re-check the SD card format before assuming a firmware problem.

**Expect the stock touchscreen to be dead from now on.** It's a separate MCU that doesn't
speak Klipper. This is normal and doesn't matter — you'll drive everything from Mainsail.

**Done when:** `ls /dev/serial/by-id/` shows the board.

---

# PHASE 4 — Minimal motion config

**Goal: get X, Y, and Z moving. Nothing else. Do not attach a pen yet.**

## 4.1 [CC] Write a stripped `printer.cfg`

Start from the CR-6 SE example config if Klipper ships one, then **delete**:
- `[extruder]` — entirely
- `[heater_bed]` — entirely
- `[heater_fan]`, `[fan]` — entirely
- Any `[verify_heater]`, thermistor, or thermal protection sections
- Any probe / bed mesh sections **for now** (added in Phase 7)

This deletion is the whole point of the Klipper path: MINTEMP faults, cold-extrusion
guards, and thermal runaway protection stop being things you work around because they
stop existing.

Keep and configure:

```
[mcu]                 # serial path from 3.5
[printer]             # kinematics: cartesian
[stepper_x]           # rotation_distance: 40, position_max: 235
[stepper_y]           # rotation_distance: 40, position_max: 235
[stepper_z]           # rotation_distance: 8, position_max: 250
[virtual_sdcard]
[pause_resume]
[display_status]
```

**[VERIFY]** rotation_distance values against the actual machine — CR-6 SE uses 20-tooth
GT2 pulleys (40 mm/rev) and a T8 lead screw (8 mm/rev), but confirm empirically in 4.3.

Start with **conservative** `max_velocity` / `max_accel`. Tuning comes in Phase 11.

## 4.2 [HUMAN] Test with your hand on the power switch

First `G28 X` and `G28 Y`, one axis at a time, ready to cut power if anything drives into
a hard stop.

## 4.3 [CC + HUMAN] Verify dimensional accuracy

Command a 100 mm X move. **[HUMAN]** measures actual travel with calipers or a steel rule.
Repeat for Y. Adjust `rotation_distance` proportionally if off. Get this right now — every
drawing you ever make inherits this error.

## 4.4 The Z homing problem

**The CR-6 SE has no mechanical Z endstop.** Stock, it homes Z using the strain gauge in
the toolhead bracket. We are not using the strain gauge, so Z needs a plan. Pick one:

**Option A — Mechanical switch (recommended, most bulletproof).**
Mount a microswitch to the frame so the X gantry trips it near the bottom of travel. Wire
to a free input identified in 1.1. Set as a normal `endstop_pin` in `[stepper_z]`. Set
once, correct forever, zero per-session ritual.

**Option B — Software Z reference (zero hardware, recommended if no free input).**
Skip Z homing entirely. At the start of each session:
1. Jog Z by eye until the pen is just clear of the paper
2. `SET_KINEMATIC_POSITION Z=5`
3. `G28 X Y`

Wrap this in a `PLOT_HOME` macro so it's one click. Costs you a 20-second ritual per
session. Because Z travel on a plotter is only a few millimetres, the loss of absolute Z
reference genuinely doesn't matter.

**Option C — Re-enable the strain gauge as a Z endstop only.**
The wiring already exists and the bracket is still the load cell. This is available if A
and B both annoy you, but it's the least-documented path and it's why we routed around it
in the first place.

**Done when:** all three axes move accurately and repeatably, and Z has a homing story.

---

# PHASE 5 — Strip the toolhead

Now, and not before now.

## 5.1 [HUMAN] Before you unplug anything

**Photograph every connector from multiple angles.** You will not remember which
2-pin plug went where.

**Trace the X endstop wiring first.** On some CR-6 SE units, toolhead-adjacent wiring runs
through the same loom. If you pull the loom and lose X homing, you've created a new problem.
Confirm X and Y endstops still work (`G28 X`, `G28 Y`) after every removal step.

## 5.2 [HUMAN] Remove

Power off and unplug from mains first. Remove:

- Hotend heater cartridge
- Thermistor
- Heatsink and heatbreak
- Hotend cooling fan
- Part cooling fan and duct
- Nozzle and heater block
- Extruder motor and Bowden/direct assembly
- Any plastic shroud that doesn't hold the bracket together

**Keep:**
- The **toolhead mounting bracket** — this is your pen mounting surface and it's also the
  strain-gauge load cell if you ever want Option C
- X carriage, wheels, belt, and belt tensioners
- X and Y endstops and their wiring
- All motion hardware

**Tidy the loom.** You've removed most of the wires in it. Cut it down, re-sleeve, and
strain-relieve it. Slack cable that snags mid-plot ruins the drawing.

## 5.3 [CC] Confirm nothing broke

`FIRMWARE_RESTART`, then re-run the Phase 4 tests. All three axes should behave identically
to before the strip. If Klipper now complains about a missing component, something is still
referenced in `printer.cfg` that shouldn't be.

**Done when:** the toolhead is bare, and X/Y/Z motion and homing are unchanged.

---

# PHASE 6 — Mount pen and servo

## 6.1 The pen holder design loop

Don't download someone else's holder. The CR-6 toolhead bracket isn't an Ender 3 bracket,
you have printers available, and a parametric design lets you tune the two things that
actually determine plot quality — rigidity and spring rate — instead of accepting a
stranger's guesses.

### 6.1a [HUMAN] Measure the bare bracket

With the toolhead stripped (Phase 5 complete), measure and record:

- Mounting hole spacing, X and Y, centre to centre
- Hole diameter
- Bracket face dimensions and any obstructions (screw heads, standoffs, belt clamp)
- **Distance from the bracket face to where the nozzle tip used to be**, in X, Y and Z
- Clearance behind the bracket for a servo body
- Belt path and X-carriage wheels — the holder must not foul either at full travel

Photograph with a rule in frame. Hand measurements and photos to [CC].

### 6.1b [CC] Generate a parametric OpenSCAD holder

Build `holder.scad` with everything above as named variables at the top of the file, plus:

```
pen_diameter        // barrel OD at the grip point
collet_wall         // sleeve thickness
spring_travel       // 3–5 mm
spring_od, spring_free_length
servo_arm_height    // where the lifter finger engages
tip_offset_x, tip_offset_y   // relative to old nozzle position
```

Emit both the holder body and a **collet** — a printed sleeve that adapts one pen barrel to
the holder's fixed bore.

**Design the collets so every pen's *tip* lands at the same Z when seated**, not so every
barrel seats at the same depth. Pens vary in tip-to-shoulder distance, so referencing off
the barrel means re-measuring `PEN_Z` on every swap. Referencing off the tip makes `PEN_Z`
a function of paper stock only — which is the whole point of section 7.4.

Print a collet per pen you own. This is the payoff for having spare printers: a $0 sleeve
per pen instead of a compromise clamp that half-fits everything.

### 6.1c [HUMAN + CC] Iterate

Four passes, roughly:

| Rev | Goal | What to check |
|---|---|---|
| v1 | Mount fit only — no pen bore, no spring | Bolts up flush, no rocking, clears belt and wheels at full X travel |
| v2 | Add pen bore and collet | Pen vertical in both axes (small square), no rotation, tip lands near old nozzle position |
| v3 | Add sprung travel | 3–5 mm, smooth, returns freely under its own spring, no binding |
| v4 | Add servo interface | Lifter finger engages cleanly, no side load on the carriage |

**The rigidity test that matters:** push sideways on the seated pen tip with a finger.
Any perceptible flex in the *mount* will show up as wandering lines. Compliance belongs
in the sprung travel and nowhere else. If v1 flexes, thicken it and reprint — this is a
20-minute fix now and an unfixable annoyance later.

Spring rate: a ballpoint pen's own spring is roughly right as a starting point. Too stiff
tears paper and fights the servo; too soft won't hold the pen down through direction
changes.

### 6.1d [HUMAN] Final mount

Bolt on the winning revision. Record the final `tip_offset_x` / `tip_offset_y` — these go
into the vpype profile in 9.2.

**Install a BIC Cristal.** Not a Micron. Not yet.

## 6.2 [HUMAN] Mount the servo

Mount the SG90 so its arm lifts the sprung pen carriage. Aim for roughly 4–5 mm of lift —
enough to clear the paper and any ink already laid down, not so much that lifts get slow.

Wire: signal to the free header pin from 1.1, plus 5V and GND.

**If the servo browns out or the board resets when it moves**, its stall current is too
much for the board's 5V rail. Power the servo from the Pi's 5V or a separate BEC instead,
**keeping ground common with the mainboard.** A servo on a separate supply with a floating
ground will behave erratically in ways that look like a software bug.

## 6.3 [CC] Add the servo to Klipper

```
[servo pen]
pin: <pin from 1.1>
minimum_pulse_width: 0.0005      # tune
maximum_pulse_width: 0.0025      # tune
initial_angle: <pen up angle>
```

**Use a mainboard pin, not a Pi GPIO.** Klipper schedules mainboard servo commands on the
same timeline as motion, so pen-up lands exactly where the toolpath says. A Pi GPIO servo
is outside the motion queue and will lag unpredictably — you'll get little ink tails on
every lift.

## 6.4 [CC] Find the angles, [HUMAN] eyeballs it

Iteratively `SET_SERVO SERVO=pen ANGLE=...` until you find clean up and down positions.
Record both. **Down should let the spring do the work** — the servo arm should release the
carriage, not press it into the paper.

**Done when:** `SET_SERVO` reliably lifts and drops the pen, with no board resets.

---

# PHASE 7 — Z reference and the one-time bed mesh

The bed on this machine is never coming off and never getting heated. Measure it once,
save it, never think about it again.

## 7.1 [CC] Add manual bed mesh

```
[bed_mesh]
speed: 60
horizontal_move_z: 5
mesh_min: 20, 20
mesh_max: 215, 215
probe_count: 5, 5
```

With no probe defined, Klipper uses the manual method.

## 7.2 [HUMAN] Run the mesh

`BED_MESH_CALIBRATE METHOD=manual`

At each of the 25 points, jog Z until a sheet of paper under the pen has slight drag, then
`ACCEPT`. Klipper walks you through the grid.

This takes 15 minutes and it is the last time you will do it.

## 7.3 [CC] Save it

`SAVE_CONFIG`. Commit the resulting `printer.cfg` to git immediately.

## 7.4 [CC] Establish the pen-down Z offset

Define a `PEN_Z` variable — the Z height at which the pen contacts paper with the spring
lightly compressed. One number per paper stock. Bristol and copy paper differ by a few
tenths; you'll adjust this occasionally and nothing else.

**Done when:** the mesh is saved, and a pen dragged across the full bed at `PEN_Z` makes
consistent contact everywhere.

---

# PHASE 8 — Macros

## 8.1 [CC] Write the core macros

In a separate `macros.cfg`, included from `printer.cfg`:

| Macro | Does |
|---|---|
| `PEN_UP` | Servo to up angle, short dwell so the move completes before travel |
| `PEN_DOWN` | Servo to down angle, short dwell |
| `PLOT_START` | Pen up, home, move to origin, enable mesh |
| `PLOT_END` | Pen up, Z clear, move head to front-left so paper is reachable, motors off |
| `PLOT_PAUSE` | Pen up, park, hold — for pen swaps mid-plot |
| `PLOT_RESUME` | Pen down at the exact previous position, continue |

Dwell times matter. A servo takes ~100–300 ms to travel. Too short and you draw during the
lift; too long and it's added to every single line segment in the drawing.

## 8.2 [CC] Multi-colour support

`PLOT_PAUSE` / `PLOT_RESUME` is what makes multi-pen work possible: plot layer 1, pause,
human swaps the pen, resume. vpype separates layers by SVG colour, so this maps cleanly.

**Done when:** macros work individually and `PLOT_START` → draw a square → `PLOT_END`
completes without intervention.

---

# PHASE 9 — The software pipeline

## 9.1 [CC] Install vpype

Install with `pipx` to keep it isolated. Add plugins:
- `vpype-gcode` — G-code output (required)
- `hatched` — image → hatched line art
- `vpype-flow-imager` — image → flow-field art
- `vpype-vectrace` — raster tracing

**[VERIFY]** current plugin names and whether text/Hershey font support is built into
vpype core or requires a plugin.

## 9.2 [CC] Write the vpype-gcode profile

A TOML profile that emits:
- `PEN_UP` before every travel move
- `PEN_DOWN` before every draw move
- `PLOT_START` at the top, `PLOT_END` at the bottom
- Correct units and the XY offset measured in 6.1

## 9.3 [CC] Build a `plot` CLI wrapper

One command from SVG to plotted. It should:

1. **Read** the SVG
2. **Scale and layout** to a named paper size, with margin
3. **Optimise** — this is where the time savings live:
   - `linemerge` — join paths whose endpoints nearly touch
   - `linesort` — reorder to minimise pen-up travel (frequently halves plot time)
   - `reloop` — randomise closed-path start points so loop seams aren't all aligned
   - `linesimplify` — drop redundant points
4. **Write** G-code via the profile
5. **Preview** — render the G-code to PNG, draw moves in one colour and travel moves in
   another. *Always look at this before plotting.*
6. **Estimate** plot time
7. **Upload** to Moonraker and optionally start

## 9.4 [CC] Build a dry-run mode

A flag that runs the full job with the pen forced up and Z raised 20 mm. Catches
out-of-bounds moves, mirrored output, and wrong scaling without wasting paper or a pen tip.

**Make this the default for any new file.** The cost is a few minutes; the alternative is
discovering the problem via a pen dragged off the edge of the bed.

## 9.5 [CC] Source-specific front ends

Each of these just needs to produce SVG, after which the pipeline above is identical:

- **Generative art** — Python (`vsketch`, `shapely`, `numpy`) → SVG
- **Handwriting / cards** — Hershey stroke fonts. These are *single-stroke* fonts designed
  for plotters; regular TTF outlines will plot as hollow outlined letters, which is almost
  never what you want.
- **Technical drawings** — DXF imports directly into vpype
- **Photos** — `hatched` or `vpype-flow-imager`

**Done when:** `plot drawing.svg --dry-run` completes a full pen-up pass with a correct
preview image.

---

# PHASE 10 — First real plot

## 10.1 [HUMAN] Set up paper registration

Glue or tape the printed corner blocks to the bed so paper lands in the same place every
time. On a dedicated machine this is worth doing permanently — it turns paper alignment
from a per-plot fiddle into dropping a sheet into a corner.

Record the paper origin in the vpype profile.

## 10.2 [HUMAN] Tape down a sheet of cheap paper. Install a BIC.

## 10.3 [CC] Plot a calibration sheet

Generate and plot a test page containing:
- A 100 × 100 mm square (dimensional check)
- Concentric circles (backlash and belt tension check)
- Parallel lines at 1 / 2 / 5 mm spacing (registration check)
- A diagonal grid (skew check)
- A short text string (font pipeline check)

## 10.4 [HUMAN + CC] Read the results

| Symptom | Cause | Fix |
|---|---|---|
| Square isn't square | Skew — frame not trammed | Square the gantry mechanically |
| Dimensions off | `rotation_distance` | Back to 4.3 |
| Circles have flat spots / corners overshoot | Acceleration too high | Reduce `max_accel` |
| Lines don't close — small gap at the end | Backlash | Tighten belts, check eccentric nuts |
| Ink tails at the start of lines | Pen-down dwell too short | Increase dwell in `PEN_DOWN` |
| Faint or skipping lines | Pen pressure / `PEN_Z` too high | Lower `PEN_Z` in small steps |
| Torn paper, pen digging | `PEN_Z` too low or spring too stiff | Raise `PEN_Z`, lighter spring |
| Wobbly lines at speed | Resonance | Reduce accel; consider input shaper |

Iterate here until the calibration sheet is clean. **Only then install a Micron.**

**Done when:** the calibration sheet is dimensionally accurate and visually clean.

---

# PHASE 11 — Tune for speed

You removed most of the toolhead mass. The stock motion limits are now absurdly
conservative — they were sized for a heavy hotend flinging molten plastic.

## 11.1 [CC] Raise limits incrementally

Increase `max_accel` in steps, re-plotting the calibration sheet each time, until line
quality degrades. Then back off 30%.

Expect to land somewhere well above print settings. Print acceleration was likely ~500
mm/s²; a bare pen carriage should tolerate several times that. Let the calibration sheet
tell you where the wall is rather than trusting any specific number.

## 11.2 Per-pen speed profiles

**Different pens have different maximum speeds, limited by ink flow, not motion.**

- Ballpoints tolerate high speed but may skip on fast direction changes
- Fineliners starve above a certain feedrate and produce faint lines
- Gel pens are the slowest and smear if you travel over wet ink

Store a speed profile per pen type in the `plot` tool and select it with a flag.

## 11.3 [CC] Input shaper (optional)

Klipper's input shaper meaningfully improves line quality at speed. It's normally tuned
with an accelerometer, but `SHAPER_CALIBRATE` with a plotted ringing-test pattern works
visually and costs nothing but paper.

## 11.4 Ink-drying awareness

For dense drawings, `linesort` may route the pen back over wet ink. If you get smearing,
constrain sort order or split into layers with a pause between.

**Done when:** plots are fast enough that you don't avoid starting them.

---

# PHASE 12 — Custom plotter UI *(defer this)*

**Do not start this until Phase 11 is done and you have plotted for a week or two.**

If you build a UI before you've used the machine, you will build the wrong one — you'll
guess at requirements and end up with the plotter equivalent of a temperature graph. Plot
first, notice what you keep doing by hand, then build *that*.

## 12.1 Scope

Mainsail is a general-purpose 3D printer UI, which is why it shows you empty temperature
panels and a missing extruder. A purpose-built plotter frontend would show:

- SVG in, with the G-code preview from 9.3 overlaid — draw moves vs travel moves
- Live progress drawn *onto* that preview as the plot runs
- `PEN_UP` / `PEN_DOWN` test buttons
- `PEN_Z` nudge, ±0.05 mm, live while the pen is down
- Pen profile picker that applies the speed limits from 11.2
- Layer list with pause-for-pen-swap
- Paper size and registration origin selector
- Job history with a thumbnail of each drawing

## 12.2 [CC] Build it

A Vue or React SPA talking to Moonraker's websocket, served by the nginx that KIAUH already
installed. The preview renderer from 9.3 is most of the hard part, already done.

**Build it responsive.** It then works on a phone at the machine, which is the only
"machine-side screen" this build needs.

## 12.3 Keep Mainsail installed

Two frontends against one Moonraker is fine and costs nothing. Mainsail becomes your
"is this my UI or is this Klipper?" oracle when something misbehaves. Do not remove it.

## 12.4 What *not* to build

**Do not reimplement Moonraker.** The API surface is the easy part; the job queue, print
state machine, file management, websocket subscription model, and job history underneath
it are not. You would spend real effort to arrive at an API that isn't better, only yours.
Claude Code doesn't need a nicer API than Moonraker — it needs *an* API, and that already
exists.

**Do not add a GPIO touchscreen.** A 3.5" SPI panel costs an evening of driver work
minimum, occupies the GPIO header, risks a proprietary-controller dead end, and leaves you
maintaining a second UI codebase at 480×320. Your phone running the responsive UI from 12.2
is strictly better in every dimension — resolution, framerate, and effort. The usual
argument for a machine-mounted screen assumes unattended eight-hour jobs; plots run twenty
minutes and you'll be standing there anyway.

*(Revisit only if, months in, reaching for your phone is a genuine annoyance. At that point
the UI already exists and the job shrinks to "make it work at 480×320.")*

---



**[CC] can own:** Klipper/Moonraker/Mainsail install, firmware build, all config and
macros, the vpype pipeline, the `plot` CLI, preview rendering, G-code inspection, log
reading, git hygiene, generative SVG scripts.

**[CC] cannot do, and should say so rather than guess:** identify the board revision from
memory, judge pen contact pressure, tram the gantry, decide when a line "looks right",
confirm a servo physically moved. Anything in this category, ask [HUMAN] to look.

**[HUMAN] should escalate to [CC]:** any error text (paste it verbatim, in full), any
"it moved wrong" (describe *what* it did, not what you think caused it), any config change
you're tempted to make by hand — let [CC] make it so it's in git.

---

# Appendix B — Failure modes ranked by likelihood

*(The usual #1 — "didn't print the parts before removing the hotend" — doesn't apply to
this build. Other printers are available.)*

1. **Pen mount flexes.** Every line is slightly wrong in a way that's maddening to
   diagnose, because nothing in software is causing it. Rigidity in the *mount*,
   compliance only in the sprung *travel*. Catch it at v1 in 6.1c.
2. **SD card won't flash.** Wrong format, wrong size, or a reused filename. See 3.2/3.3.
3. **Collets referenced off the barrel instead of the tip.** Every pen swap becomes a
   re-measurement. See 6.1b.
4. **Servo browns out the board.** Looks exactly like random firmware crashes. See 6.2.
5. **Gave up after the third smeared line.** The tuning table in 10.4 exists so you don't
   have to guess. Every one of these is a known, solved problem.

---

# Appendix C — First session checklist

Once built, a normal plotting session is:

1. Power on printer and Pi
2. `PLOT_HOME` (or `G28` if you fitted a Z switch)
3. Drop paper into the registration corners, tape
4. Install pen, confirm `PEN_Z` matches paper stock
5. `plot artwork.svg --dry-run`
6. Look at the preview image
7. `plot artwork.svg`
8. `PLOT_END`, remove paper, let ink dry before stacking
