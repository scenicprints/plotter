# Plotter

A Creality CR-6 SE converted into a pen plotter, plus the Windows app that
drives it. Both halves of the project live here.

Read **[HANDOFF.md](HANDOFF.md)** first. It carries the machine's hard rules
(the Z rule, the three sends, the gotchas that cost real time) and the current
tuned values.

## Layout

| Path | What |
|---|---|
| `app/` | **Plotter** — the Windows control app. Electron, one portable `.exe`, no Python, no vpype. Talks to plain Klipper + Moonraker, so it works against any Klipper plotter. See [app/README.md](app/README.md). |
| `machine/` | The machine side. `printer.cfg`, `macros.cfg`, the toolhead holder, firmware, the Pi-side tool scripts, and plotted art. |
| `docs/` | The original phase-by-phase build guide, and the early UI concept the app grew out of. |

### `machine/`

| Path | What |
|---|---|
| `printer.cfg`, `macros.cfg` | Klipper config. `macros.cfg` holds `_PLOT_VARS`, `PEN_UP` / `PEN_DOWN`, `PLOT_ZERO_HERE`, `PLOT_END`. |
| `holder.scad`, `stl/` | The owner-built pen toolhead. LM8UU bearings on 8 mm rods, gravity loaded, no spring. Pen force is carriage mass. |
| `firmware/plot001.bin` | Klipper build for the Creality v4.5.2 board. STM32F103, 28 KiB bootloader, USART1. |
| `tools/` | The earlier Pi-side pipeline: `plot`, `genart`, `mkpulsar`, `mkcard`, `mkcalib`, built on vpype. The app replaced these for day to day use. They still work and are untouched. |
| `art/`, `renders/` | Plotted SVGs and their previews. |
| `NOTES.md` | Build-time hardware notes, pin map, Klipper build target. |

## The machine

- Creality CR-6 SE, v4.5.2 board flashed with Klipper. Stock touchscreen is dead
  by design.
- Pi 4 at `plotter.local` runs Klipper, Moonraker on 7125, Mainsail on 80.
- Toolhead is owner-built and gravity loaded. To change line weight, add or
  remove mass. Never drive Z lower.
- **Z0 is the writing height and the absolute floor.** `position_min: 0`, and
  there is no Z endstop. The reference is set by hand every session and lives
  only in motion state, so a restart wipes it.

## The app

Three sends, in order, each its own card carrying only its own controls:

1. **Writing height** — Z jog, pen up/down, one click locks Z0.
2. **Card position** — XY jog pad, Z jog, card size, one click sets the origin.
3. **Plot** — pick an SVG or a line drawing, add a message, preview, send.

Everything runs in-process: SVG parsing, curve flattening, transforms,
linemerge, linesort, reloop, simplify, filter, layout, gcode. It also traces
PNG and JPG line art itself, splitting ink by thickness so thin strokes get
their centreline and solid shapes get an outline plus a hatch.

### Building it

    cd app
    npm install
    npm test
    npm run dist        # -> app/dist/Plotter.exe

`app/dist/` and `app/node_modules/` are not tracked.
