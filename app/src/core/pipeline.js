'use strict';
// SVG -> plotted. Layout, optimise, order, emit gcode, estimate time.
// Everything the Pi's `plot` script + vpype did, in-process.

const { readSVG } = require('./svgdoc');
const G = require('./geom');

const DEFAULTS = {
  paperW: 150,
  paperH: 100,
  margin: 10,
  fit: 'fit',          // 'fit' scales to the margins, 'actual' keeps mm as authored
  autoRotate: true,    // rotate 90 deg when that fits the sheet better
  minLen: 0.5,         // drop paths shorter than this, in mm
  simplify: 0.05,      // Douglas-Peucker tolerance, mm
  mergeTol: 0.1,       // join path ends closer than this, mm
  keepLayers: true,    // order within a layer only, so layers stay in order
  tolerance: 0.05,     // curve flattening tolerance, mm
  drawFeed: 3000,      // mm/min
  travelFeed: 9000,    // mm/min
  lift: 10,            // mm, read off the machine when connected
  zUpFeed: 1800,       // mm/min
  zDownFeed: 900,      // mm/min
  dryRun: false,       // trace the plot in the air, drawing nothing
  dryZ: 20,            // height for a dry run: clear of the hold-down magnets
};

function rotate90(paths) {
  // (x, y) -> (y, -x); still SVG space, we re-normalise straight after
  for (const p of paths) for (const q of p) {
    const x = q[0];
    q[0] = q[1];
    q[1] = -x;
  }
}

function transformInPlace(paths, sx, sy, tx, ty) {
  for (const p of paths) for (const q of p) {
    q[0] = q[0] * sx + tx;
    q[1] = q[1] * sy + ty;
  }
}

// Time model. Matches the machine's observed behaviour: a plot is dominated
// by pen lifts, one per path, each costing lift/up + lift/down.
function estimate(drawLen, travelLen, lifts, o) {
  const draw = drawLen / (o.drawFeed / 60);
  const travel = travelLen / (o.travelFeed / 60);
  // A dry run never puts the pen down, so it costs no lifts at all. That is
  // why a dry run finishes in a fraction of the real time.
  const pen = o.dryRun ? 0 : lifts * (o.lift / (o.zUpFeed / 60) + o.lift / (o.zDownFeed / 60));
  return draw + travel + pen;
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------- build
// Returns geometry in PAPER space: origin at the sheet centre, X right,
// Y up. That is exactly what the machine expects once the gcode offset is
// set to the sheet centre.
function build(svgText, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const doc = readSVG(svgText, { tolerance: o.tolerance });
  if (!doc.layers.length) throw new Error('no drawable geometry in that SVG');
  return buildLayers(doc.layers, o);
}

// The same pipeline, entered from layers that are already polylines in mm.
// A traced raster arrives here directly: serialising 50,000 skeleton
// fragments to SVG only to parse them straight back would be pure cost, and
// simplify/merge/filterMin below are exactly the clean-up a trace needs.
function buildLayers(layers, options = {}) {
  const o = { ...DEFAULTS, ...options };
  if (!layers || !layers.length) throw new Error('no drawable geometry');

  // Work on a flat list but remember which layer each path came from, so
  // ordering can stay inside a layer.
  let groups = o.keepLayers
    ? layers.map((L) => ({ name: L.name, paths: L.paths }))
    : [{ name: 'all', paths: layers.flatMap((L) => L.paths) }];

  // ---- clean up
  for (const g of groups) {
    g.paths = g.paths.map((p) => G.simplify(p, o.simplify));
    g.paths = G.merge(g.paths, o.mergeTol);
    g.paths = G.filterMin(g.paths, o.minLen);
  }
  groups = groups.filter((g) => g.paths.length);
  if (!groups.length) throw new Error(`every path was shorter than the ${o.minLen} mm minimum`);

  const all = groups.flatMap((g) => g.paths);

  // ---- fit to the sheet
  const availW = Math.max(1, o.paperW - 2 * o.margin);
  const availH = Math.max(1, o.paperH - 2 * o.margin);
  let bb = G.bbox(all);

  let rotated = false;
  if (o.autoRotate && bb.w > 0 && bb.h > 0) {
    const straight = Math.min(availW / bb.w, availH / bb.h);
    const turned = Math.min(availW / bb.h, availH / bb.w);
    if (turned > straight * 1.001) {
      rotate90(all);
      rotated = true;
      bb = G.bbox(all);
    }
  }

  let scale = 1;
  if (o.fit === 'fit') {
    scale = Math.min(availW / (bb.w || 1), availH / (bb.h || 1));
  }
  // centre the artwork's bounding box on the origin, and flip Y so the
  // result is machine space (Y up) rather than SVG space (Y down)
  const cx = bb.x0 + bb.w / 2;
  const cy = bb.y0 + bb.h / 2;
  transformInPlace(all, scale, -scale, -cx * scale, cy * scale);

  const fitted = { w: bb.w * scale, h: bb.h * scale };
  const overflow = fitted.w > availW + 0.01 || fitted.h > availH + 0.01;

  // ---- order, per layer, carrying the pen position across layers
  let penX = 0, penY = 0, travelLen = 0;
  const ordered = [];
  for (const g of groups) {
    const r = G.sortPaths(g.paths, penX, penY, true);
    travelLen += r.travel;
    for (const p of r.paths) ordered.push(p);
    if (r.paths.length) {
      const tip = r.paths[r.paths.length - 1];
      penX = tip[tip.length - 1][0];
      penY = tip[tip.length - 1][1];
    }
  }

  let drawLen = 0;
  for (const p of ordered) drawLen += G.pathLength(p);

  const stats = {
    paths: ordered.length,
    lifts: o.dryRun ? 0 : ordered.length,
    dryRun: !!o.dryRun,
    drawLen,
    travelLen,
    seconds: estimate(drawLen, travelLen, ordered.length, o),
    width: fitted.w,
    height: fitted.h,
    scale,
    rotated,
    overflow,
    layers: groups.map((g) => g.name),
    // Enough to map a point from the artwork's own mm space into paper space
    // and back. The UI needs the inverse so a rectangle dragged on the preview
    // can be turned into a region of the source image.
    //   rotated: (x, y) -> (y, -x) first
    //   then     paper = ((x - cx) * scale, -(y - cy) * scale)
    map: { rotated, scale, cx, cy },
  };
  stats.time = fmtTime(stats.seconds);

  return { paths: ordered, stats, options: o };
}

// ---------------------------------------------------------------- text
// Add text to a built plot, or make a plot that is only text.
//
// Text is composed in PAPER space, after the artwork has been fitted. That is
// deliberate: "5 mm capitals" has to mean 5 mm on the card. Folding text in
// before the fit would let a scale of 0.87 silently turn it into 4.35 mm, and
// the whole point of the setting is that you can measure the result.
//
// textPaths arrive in mm, Y-down, origin at the sheet centre; paper space is
// Y-up, so they are flipped on the way in.
function composeText(built, textPaths, options = {}) {
  const o = { ...DEFAULTS, ...options };
  if (!textPaths || !textPaths.length) {
    if (built) return built;
    throw new Error('nothing to plot');
  }
  const flipped = textPaths.map((p) => p.map((q) => [q[0], -q[1]]));
  const all = built ? built.paths.concat(flipped) : flipped;
  const r = G.sortPaths(all, 0, 0, true);

  let drawLen = 0;
  for (const p of r.paths) drawLen += G.pathLength(p);
  const bb = G.bbox(r.paths) || { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 };
  const availW = Math.max(1, o.paperW - 2 * o.margin);
  const availH = Math.max(1, o.paperH - 2 * o.margin);
  // In paper space the origin IS the sheet centre, so the margin test is about
  // how far the drawing reaches from it, not about its width. Text placed off
  // to one side can overflow while being narrower than the card.
  const overflow = bb.x1 > availW / 2 + 0.01 || bb.x0 < -availW / 2 - 0.01
                || bb.y1 > availH / 2 + 0.01 || bb.y0 < -availH / 2 - 0.01;

  const stats = {
    ...(built ? built.stats : { rotated: false, scale: 1, layers: [] }),
    paths: r.paths.length,
    lifts: o.dryRun ? 0 : r.paths.length,
    dryRun: !!o.dryRun,
    drawLen,
    travelLen: r.travel,
    width: bb.w,
    height: bb.h,
    overflow,
    textPaths: flipped.length,
    seconds: estimate(drawLen, r.travel, r.paths.length, o),
  };
  stats.time = fmtTime(stats.seconds);
  return { paths: r.paths, stats, options: o };
}

// ---------------------------------------------------------------- gcode
// Uses the machine's own PEN_UP / PEN_DOWN macros rather than raw Z, so the
// lift height and feeds stay owned by Klipper.
//
// It deliberately does NOT call PLOT_END. The copy of that macro that has
// been loaded on this machine at times still ran M84, which drops the motors
// and erases the hand-set Z reference, and its park move overran the rail.
// Ending with PEN_UP and a plain lift is the known-good sequence.
function toGcode(paths, o, meta = {}) {
  const L = [];
  const f = (v) => v.toFixed(3);
  L.push('; CR-6 SE pen plotter');
  if (meta.name) L.push(`; source: ${meta.name}`);
  L.push(`; paper: ${o.paperW} x ${o.paperH} mm, margin ${o.margin} mm`);
  L.push(`; paths: ${paths.length}`);
  if (meta.time) L.push(`; estimate: ${meta.time}`);
  L.push('; origin is the sheet CENTRE');
  if (o.dryRun) L.push(`; DRY RUN at Z${o.dryZ} - nothing is drawn`);
  L.push('G21');
  L.push('G90');
  L.push('PLOT_START');
  if (o.dryRun) {
    // Fly the whole job well clear of the paper and the hold-down magnets.
    L.push(`G1 Z${o.dryZ} F${Math.round(o.zUpFeed)}`);
    for (const p of paths) {
      L.push(`G0 X${f(p[0][0])} Y${f(p[0][1])} F${Math.round(o.travelFeed)}`);
      for (let i = 1; i < p.length; i++) {
        L.push(`G1 X${f(p[i][0])} Y${f(p[i][1])} F${Math.round(o.drawFeed)}`);
      }
    }
  } else {
    for (const p of paths) {
      L.push(`G0 X${f(p[0][0])} Y${f(p[0][1])} F${Math.round(o.travelFeed)}`);
      L.push('PEN_DOWN');
      for (let i = 1; i < p.length; i++) {
        L.push(`G1 X${f(p[i][0])} Y${f(p[i][1])} F${Math.round(o.drawFeed)}`);
      }
      L.push('PEN_UP');
    }
    L.push('PEN_UP');
  }
  L.push(`G1 Z20 F${Math.round(o.zUpFeed)}`);
  L.push('; done');
  return L.join('\n') + '\n';
}

module.exports = { build, buildLayers, composeText, toGcode, estimate, fmtTime, DEFAULTS };
