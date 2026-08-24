# Plotter

Windows control app for the CR-6 SE pen plotter. One portable `.exe`, no Python,
no vpype, no dependencies on the machine side. It talks to plain Klipper +
Moonraker, so it works against any Klipper plotter, not just this one.

    dist\Plotter.exe

## What it does

The three sends, in order, each as its own card carrying only its own controls:

1. **Writing height** — Z jog, pen up/down, then one click locks Z0.
2. **Card position** — XY jog pad, Z jog, card size, one click sets the origin.
3. **Plot** — pick an SVG or a line drawing, add a message, preview it, send it.

Plus jog, homing, pen test, live progress, pause, cancel, emergency stop, a
machine console, and a preview showing draw versus travel with a time estimate.

### Setting the origin

**Pen is at** takes any of the four corners or **the centre**. Corner mode adds
half the measured size to reach the sheet centre; centre mode reads the origin
straight off the pen and the measured size only records the sheet dimensions,
so it carries no sighting error at all.

Both modes need Z, because placing the pen accurately means lowering it until
it nearly touches. Step 2 therefore carries its own Z jog with its own step,
separate from step 1's fine steps.

Homing clears the gcode offset but leaves the paper size behind. The app treats
an origin of exactly 0,0 as "not set", because the sheet centre can never
legitimately be the machine origin. Without that, step 2 showed a green tick
over an origin that was gone.

## Drawings, not just SVGs

Drop a PNG or JPEG of line art and it is traced to paths on the spot. Electron
decodes the image itself, so this adds no dependency. The trace controls only
appear for a raster; an SVG never sees them.

Two treatments, picked per pixel by how thick the ink is:

- **Thin strokes get their centreline.** The skeleton of a 2px line is the
  line, so the pen draws it once instead of once down each side.
- **Solid shapes get an outline and a hatch.** Thinning a filled shape does
  not give you its middle, it gives you a ragged spine with spurs. Eyebrows,
  eyelashes, pupils and lips all fail that way, and a face traced without
  this has scribbles where its eyes should be.

**Fill over mm** is the line between the two, in millimetres of finished plot.
Anything inked thicker than that is a shape; anything thinner is a line. A blob
is only promoted if its *core* survives erosion, because a line that merely
thickens for a few pixels grows into a respectable-looking blob and would
otherwise plot as a stray black dash.

Three more things that matter:

- **Tolerances are in millimetres of paper**, converted against the image's own
  resolution, so re-exporting the same drawing at a different size does not
  change the result.
- **The image is upsampled 2x before thinning.** A 2px line has nowhere to put
  a middle; at 4px the skeleton lands where it should.
- **Smoothing happens against the pixel grid, inside the tracer.** A skeleton
  follows whole pixels, so a gently sloping line arrives as a staircase. The
  Simplify setting is in mm and is meant for real curves in real SVGs; at
  raster scale it is far too fine to flatten that, so the tracer does it.

**Save traced SVG** writes the drawing out as reusable artwork, cleaned with
the same tolerances the plot used.

**Blank an area** drags a rectangle over the preview and erases that part of
the image before tracing. It exists for artwork with lettering already rendered
into it: see below for why that has to go.

## Writing on it

Type a message and it is drawn in a **single-stroke font**, where each letter is
the path the pen travels rather than an outline to be filled. A normal font's
`o` is two closed curves, so a pen draws a hollow ring and at card sizes the
two sides of a stem smear together. These draw one line down the middle.

Eighteen fonts ship with the app in `src/fonts` (Hershey and the EMS set, taken
from Inkscape's Hershey Text extension), so nothing needs installing.

Text works **with artwork or on its own** — a card that is only a message is a
perfectly good plot.

Size is **cap height in millimetres**, measured off the font's own `H` rather
than its metadata, which several of these files get wrong. That means 5 mm
looks the same whichever font you pick.

Text is composed in paper space **after** the artwork is fitted, so 5 mm means
5 mm on the card. Folding it in before the fit would let a scale of 0.87
silently turn it into 4.35 mm, and the point of the setting is that you can
measure the result. Position is in millimetres from the sheet centre.

**If the artwork already has type in it, blank it out first.** Rendered type
traces into broken letters: thinning a filled letterform eats the dots on the
i's and the descenders on the y's, and you get "Happ, 6th Birthda,!". There is
no fixing that in the trace, because the input is an outline and the tracer is
looking for a skeleton. Erase it and set the words again.

Tracing a big drawing takes a second or two, so the result is cached against
everything that actually changes it. Feeds and dry run do not re-trace.

## The SVG pipeline is in-process

`src/core/` reimplements what `plot` + vpype did on the Pi:

| File | Does |
|---|---|
| `xml.js` | minimal XML reader |
| `svgpath.js` | path `d` parser, all commands, adaptive curve flattening, arcs |
| `svgdoc.js` | shapes, transforms, units, viewBox, layers -> polylines in mm |
| `trace.js` | raster -> paths: threshold, fill split, thinning, hatch |
| `strokefont.js` | SVG stroke fonts -> typeset paths in mm |
| `geom.js` | simplify, merge, spatial-grid nearest neighbour, sort, reloop |
| `pipeline.js` | fit, auto-rotate, order, gcode, time estimate |

A trace enters `pipeline.buildLayers` as one layer of polylines rather than
being serialised to SVG and parsed straight back. It arrives as raw skeleton
fragments — fifty thousand of them for a portrait — because `simplify`,
`merge` and `filterMin` are already exactly the clean-up a trace needs. That
is also why a trace is a single layer: layers exist for pen changes, and a
traced drawing is one pen's work.

`node test-geom.js` runs 35 correctness tests (circle perimeter, arc flags,
S/T continuation, transform composition, unit conversion, layer order).
`node test-trace.js` runs 40 over the tracer on synthetic rasters (thinning,
erosion, fill detection, scale independence, SVG round trip, huge-input safety).
`node test-text.js` runs 39 over the fonts and typesetting (every glyph present,
o really is one stroke, cap-height sizing, alignment, composition onto a plot).
`node test-core.js` runs the real artwork through end to end.
`node test-live.js` reads the actual machine, read-only.
`node_modules\.bin\electron test-trace-live.js <image>` traces a real file and
prints what the Plot card would show. It needs Electron for image decoding.

Two things that had to be right and are easy to get wrong:

- **Curve tolerance is transformed into each element's own coordinate system.**
  Flattening happens in local user units, so a viewBox scale would otherwise
  multiply the real-world error silently.
- **`<polygon>` is read and kept closed.** vpype writes closed paths as
  `<polygon>` and cannot read them back, which loses closed geometry on any
  round trip. There is no round trip here, and the reader handles it anyway.

## Machine rules it enforces

All of these came from something that actually went wrong:

- Z0 is the writing height **and** the floor. Setting a *new*, lower height
  means releasing the old reference first, so "Unlock Z0 to go lower" does the
  clear and the re-declare in one press rather than leaving a dead button and
  an error that names neither step. Nothing commands Z below it, and
  Klipper's own `position_min: 0` is the backstop. A refused move is explained
  rather than shown as a raw error.
- Positions are read only after `M400`. Straight after `G28` the second homing
  pass is still running and the number is wrong.
- After homing, X/Y park off the plate, so it moves back over the bed itself.
- Preflight before every send: Klipper ready, X/Y homed, Z referenced, Z0 set,
  paper size set, not already printing.
- **The sheet the gcode was laid out for must match the sheet the machine is
  set to**, or the send is refused. This is the error that ruined a card.
- Cancel lifts the pen but never drops the motors, so the Z reference survives.
- The generated gcode does **not** call `PLOT_END`. Loaded copies of that macro
  have run `M84`, which erases the hand-set Z reference, and its park move
  overran the rail. It ends with `PEN_UP` and a plain lift instead.
- Lift and feeds are read live off `_PLOT_VARS` at connect, never hardcoded, so
  the estimate matches the machine rather than a stale config on the laptop.

## Restart recovery

A Klipper restart wipes the origin, the paper size and the Z reference. The app
remembers the last corner and offers it back in a banner. Restoring the corner
is safe on its own: it only sets numbers, and the machine re-homes to the same
physical place. **The writing height still has to be set by hand**, because it
is a physical position with no endstop behind it.

## Dry run

On by default. Traces the whole plot in the air at Z20, clear of the hold-down
magnets, drawing nothing, so placement can be checked before committing ink.
It emits no `PEN_DOWN` at all, which is why it finishes in a fraction of the
time: the cake card is 1m 57s dry against 14m 24s real.

## Time model, and how to actually go faster

Plot time is dominated by pen lifts, not drawing. Each path costs
`lift/z_up_feed + lift/z_down_feed`: almost exactly 1.0 s at the machine's lift
of 10 mm with feeds 1800/900, read live off `_PLOT_VARS` at connect. Note that
the `macros.cfg` checked into `~/plotter` currently says lift 2.0 and 900/600,
which the machine does **not** agree with; the live values are the ones above,
and lift has to clear the carriage compression or the pen never leaves the paper.

**Merge is the lever, and it is a big one.** It joins paths whose ends nearly
touch, and every join removed is a lift saved. Measured on a 1228x1281 traced
portrait:

| Merge mm | Paths | Extra ink | Estimate | vs 0.1 |
|---|---|---|---|---|
| 0.1 | 1977 | +2% | 36m 26s | -- |
| 0.25 | 1332 | +8% | 25m 50s | -29% |
| **0.5** | **1034** | **+10%** | **20m 56s** | **-43%** |
| 1.0 | 548 | +17% | 12m 58s | -64% |
| 2.0 | 248 | +25% | 8m 11s | -78% |

**0.5 is free**: side by side with 0.1 the drawing is indistinguishable, and it
is 43% quicker. Past that you are paying in ink, because merging draws
*through* the gap rather than lifting over it. At 1.0 a stippled beard starts
joining into zigzags; at 2.0 it is a mesh and the teeth are gone. Fine detail
is what breaks first, so a portrait wants 0.5 where a bold line drawing will
happily take 2.

Raising **Min path** helps far less: it only removes ink you wanted.

Ordering is not worth optimising. Travel is around 3 m at 9000 mm/min, some
20 seconds of a twenty-minute plot, so a better tour than greedy
nearest-neighbour would win seconds.

A direction-aware merge, which only joins when the stroke genuinely carries on,
was built and measured and then removed: at matched ink it produced *more*
paths than the plain nearest-first merge, because the free zero-length joins at
skeleton junctions have mismatched directions and the angle test refused them,
reaching for distant collinear ends instead. Plain merge at a lower tolerance
beats it on both axes.

## Development

    npm start          # run from source
    npm test           # geometry + pipeline tests
    npm run dist       # build dist\Plotter.exe

`PLOTTER_SMOKE=1 PLOTTER_SMOKE_OUT=x.png npm start` boots, screenshots and
quits, for checking the UI without leaving a window open.
`PLOTTER_USERDATA=<dir>` points the saved state somewhere disposable.
