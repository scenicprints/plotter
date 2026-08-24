'use strict';
// Raster line art -> plotter paths.
//
// Two treatments, chosen per pixel by how thick the ink is there:
//
//   thin strokes  -> centreline. The skeleton of a 2px line IS the line, so
//                    the pen draws it once instead of once down each side.
//   solid fills   -> outline + hatch. Thinning a filled shape does not give
//                    you its middle, it gives you a ragged spine with spurs.
//                    Eyebrows, lashes, pupils and lips all fail that way.
//
// Everything downstream (simplify, merge, sort, gcode) already exists in
// geom.js / pipeline.js, so this module stops at "paths" and emits an SVG
// string that the normal SVG route can swallow unchanged.
//
// All tolerances are given in MILLIMETRES and converted here, so the result
// does not change when the source image resolution does.

// Douglas-Peucker, borrowed rather than re-implemented. It is unit-agnostic,
// so it happily works in pixels here and millimetres everywhere else.
const { simplify: simplifyPx } = require('./geom');

const DEFAULTS = {
  widthMm: 180,        // how wide the finished plot is
  threshold: 0,        // 0 = pick automatically
  penMm: 0.3,          // pen tip, sets hatch pitch
  simplifyMm: 0.09,    // Douglas-Peucker tolerance
  minStrokeMm: 0.35,   // drop specks shorter than this
  mergeMm: 0.24,       // join stroke ends closer than this
  fills: true,         // detect solid shapes at all
  hatch: true,         // fill them in, rather than leaving them hollow
  fillWidthMm: 0.9,    // ink thicker than this counts as a fill, not a line
  minFillAreaMm2: 0.1, // ignore fill "cores" smaller than this
  channelOrder: 'rgba',
  masks: null,          // [{x,y,w,h}] as fractions of the image, blanked first
  upscale: 1,          // factor already applied to the bitmap, for smoothing
  // A skeleton follows whole pixels, so a gently sloping line comes out as a
  // staircase. Left in, that is a third more path length than the line
  // actually has, tens of thousands of sub-pixel segments for Klipper to
  // grind through, and visible jitter. Smoothing has to happen against the
  // PIXEL grid, which only this module knows about; the caller's mm
  // tolerance is for real curves in real SVGs and is far too fine here.
  smoothSourcePx: 0.6,
};

// dy, dx  (8-connected)
const NB = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

// ---------------------------------------------------------------- greyscale
function toGray(img, order) {
  const { data, width: w, height: h } = img;
  const g = new Uint8Array(w * h);
  const bgr = order === 'bgra';
  const px = data.length / (w * h);       // 4 for RGBA/BGRA, 3 for RGB
  for (let i = 0, p = 0; i < w * h; i++, p += px) {
    const a = data[p], b = data[p + 1], c = data[p + 2];
    const r = bgr ? c : a, gg = b, bb = bgr ? a : c;
    g[i] = (r * 77 + gg * 150 + bb * 29) >> 8;
  }
  return g;
}

// Paper is whatever the border reads. Ink is the dark tail. Sit the cut
// between them, but never so high that paper texture becomes ink.
function autoThreshold(g, w, h) {
  const edge = [];
  for (let x = 0; x < w; x++) { edge.push(g[x], g[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { edge.push(g[y * w], g[y * w + w - 1]); }
  edge.sort((a, b) => a - b);
  const paper = edge[edge.length >> 1];
  const dark = [];
  for (let i = 0; i < g.length; i++) if (g[i] < paper - 25) dark.push(g[i]);
  if (!dark.length) return Math.max(1, paper - 25);
  dark.sort((a, b) => a - b);
  const p60 = dark[Math.floor(dark.length * 0.6)];
  return Math.max(60, Math.min((paper + p60) >> 1, paper - 8));
}

function binarise(g, T) {
  const m = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) m[i] = g[i] < T ? 1 : 0;
  return m;
}

// ---------------------------------------------------------------- morphology
function erode(a, w, h, k) {
  for (let it = 0; it < k; it++) {
    const b = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      const r = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = r + x;
        if (a[i] && a[i-w-1] && a[i-w] && a[i-w+1] && a[i-1] &&
            a[i+1] && a[i+w-1] && a[i+w] && a[i+w+1]) b[i] = 1;
      }
    }
    a = b;
  }
  return a;
}

function dilate(a, w, h, k) {
  for (let it = 0; it < k; it++) {
    const b = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      const r = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = r + x;
        if (a[i] || a[i-w-1] || a[i-w] || a[i-w+1] || a[i-1] ||
            a[i+1] || a[i+w-1] || a[i+w] || a[i+w+1]) b[i] = 1;
      }
    }
    a = b;
  }
  return a;
}

// Union-find over set pixels; clears any component smaller than minArea.
// Used on the eroded CORE, not on the grown fill: a line that merely thickens
// for a few pixels has a tiny core but grows into a respectable blob, and
// filtering the blob lets those through as stray dashes.
function dropSmall(m, w, h, minArea) {
  const idx = new Int32Array(w * h).fill(-1);
  const cells = [];
  for (let i = 0; i < m.length; i++) if (m[i]) { idx[i] = cells.length; cells.push(i); }
  if (!cells.length) return { mask: m, dropped: 0 };
  const par = new Int32Array(cells.length);
  for (let i = 0; i < par.length; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const uni = (x, y) => { const a = find(x), b = find(y); if (a !== b) par[b] = a; };
  for (let n = 0; n < cells.length; n++) {
    const i = cells[n], x = i % w;
    // forward half of the 8-neighbourhood is enough
    if (x + 1 < w && idx[i + 1] >= 0) uni(n, idx[i + 1]);
    if (i + w < m.length) {
      if (idx[i + w] >= 0) uni(n, idx[i + w]);
      if (x > 0 && idx[i + w - 1] >= 0) uni(n, idx[i + w - 1]);
      if (x + 1 < w && idx[i + w + 1] >= 0) uni(n, idx[i + w + 1]);
    }
  }
  const size = new Int32Array(cells.length);
  for (let n = 0; n < cells.length; n++) size[find(n)]++;
  const out = new Uint8Array(m.length);
  let dropped = 0;
  for (let n = 0; n < cells.length; n++) {
    if (size[find(n)] >= minArea) out[cells[n]] = 1; else dropped++;
  }
  return { mask: out, dropped };
}

// ---------------------------------------------------------------- thinning
// Zhang-Suen. Both sub-iterations run to fixpoint; deletions are collected
// per sub-iteration and applied together, which is what makes it correct.
function thin(mask, w, h) {
  const cur = Uint8Array.from(mask);
  const del = new Int32Array(w * h);
  for (;;) {
    let total = 0;
    for (let step = 0; step < 2; step++) {
      let n = 0;
      for (let y = 1; y < h - 1; y++) {
        const r = y * w;
        for (let x = 1; x < w - 1; x++) {
          const i = r + x;
          if (!cur[i]) continue;
          const p2 = cur[i-w],   p3 = cur[i-w+1], p4 = cur[i+1],   p5 = cur[i+w+1],
                p6 = cur[i+w],   p7 = cur[i+w-1], p8 = cur[i-1],   p9 = cur[i-w-1];
          const B = p2+p3+p4+p5+p6+p7+p8+p9;
          if (B < 2 || B > 6) continue;
          let A = 0;
          if (!p2 && p3) A++;  if (!p3 && p4) A++;  if (!p4 && p5) A++;
          if (!p5 && p6) A++;  if (!p6 && p7) A++;  if (!p7 && p8) A++;
          if (!p8 && p9) A++;  if (!p9 && p2) A++;
          if (A !== 1) continue;
          if (step === 0) { if ((p2 && p4 && p6) || (p4 && p6 && p8)) continue; }
          else            { if ((p2 && p4 && p8) || (p2 && p6 && p8)) continue; }
          del[n++] = i;
        }
      }
      for (let j = 0; j < n; j++) cur[del[j]] = 0;
      total += n;
    }
    if (!total) return cur;
  }
}

// ---------------------------------------------------------------- vectorise
// Walk the 1px skeleton into polylines. Breaks at endpoints and junctions,
// so a cross yields four arms rather than one scribble; merge() upstream
// stitches back anything that should be continuous.
function skeletonToPaths(m, w, h) {
  const N = w * h;
  const deg = new Uint8Array(N);
  const on = [];
  for (let y = 1; y < h - 1; y++) {
    const r = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = r + x;
      if (!m[i]) continue;
      let d = 0;
      for (let n = 0; n < 8; n++) if (m[i + NB[n][0] * w + NB[n][1]]) d++;
      deg[i] = d; on.push(i);
    }
  }
  const used = new Set();
  const key = (a, b) => (a < b ? a * N + b : b * N + a);   // < 2^53 for any real image
  const out = [];

  function walk(start, next) {
    const pts = [start, next];
    used.add(key(start, next));
    let prev = start, cur = next;
    while (deg[cur] === 2) {
      let nx = -1;
      for (let n = 0; n < 8; n++) {
        const j = cur + NB[n][0] * w + NB[n][1];
        if (m[j] && j !== prev) { nx = j; break; }
      }
      if (nx < 0) break;
      const k = key(cur, nx);
      if (used.has(k)) break;
      used.add(k);
      pts.push(nx); prev = cur; cur = nx;
    }
    return pts;
  }

  for (const i of on) {
    if (deg[i] === 2) continue;
    for (let n = 0; n < 8; n++) {
      const j = i + NB[n][0] * w + NB[n][1];
      if (m[j] && !used.has(key(i, j))) out.push(walk(i, j));
    }
  }
  for (const i of on) {                       // closed loops have no endpoint
    if (deg[i] !== 2) continue;
    for (let n = 0; n < 8; n++) {
      const j = i + NB[n][0] * w + NB[n][1];
      if (m[j] && !used.has(key(i, j))) out.push(walk(i, j));
    }
  }
  return out.map((p) => p.map((i) => [(i % w) + 0.5, Math.floor(i / w) + 0.5]));
}

// dst.push(...src) passes every element as a separate ARGUMENT, and a traced
// portrait produces tens of thousands of fragments. That sits right on V8's
// argument limit, so it throws "Maximum call stack size exceeded" depending on
// how much stack happens to be left. Append in a loop instead.
function appendAll(dst, src) {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
  return dst;
}

// Horizontal hatch clipped to a mask, one line every `pitch` rows.
function hatch(m, w, h, pitch) {
  const out = [];
  for (let y = 0; y < h; y += pitch) {
    const r = y * w;
    let s = -1;
    for (let x = 0; x < w; x++) {
      const on = m[r + x];
      if (on && s < 0) s = x;
      else if (!on && s >= 0) { if (x - s >= 2) out.push([[s + 0.5, y + 0.5], [x - 0.5, y + 0.5]]); s = -1; }
    }
    if (s >= 0 && w - s >= 2) out.push([[s + 0.5, y + 0.5], [w - 0.5, y + 0.5]]);
  }
  return out;
}

// ---------------------------------------------------------------- main entry
// img: { data: Uint8Array|Buffer, width, height }. Returns paths in PIXEL
// space plus the stats the UI shows.
function traceImage(img, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const w = img.width, h = img.height;
  const mmPerPx = o.widthMm / w;
  const px = (mm) => mm / mmPerPx;

  const gray = toGray(img, o.channelOrder);
  const T = o.threshold > 0 ? o.threshold : autoThreshold(gray, w, h);
  const ink = binarise(gray, T);

  // Blanked regions, as fractions of the image so they survive any resolution
  // change. This is how baked-in lettering gets removed before tracing: the
  // artwork's own rendered type traces into broken letters, and the fix is to
  // erase it and set the words again in a stroke font.
  let maskedPx = 0;
  for (const m of o.masks || []) {
    const x0 = Math.max(0, Math.round(m.x * w));
    const y0 = Math.max(0, Math.round(m.y * h));
    const x1 = Math.min(w, Math.round((m.x + m.w) * w));
    const y1 = Math.min(h, Math.round((m.y + m.h) * h));
    for (let y = y0; y < y1; y++) {
      const r = y * w;
      for (let x = x0; x < x1; x++) { maskedPx += ink[r + x]; ink[r + x] = 0; }
    }
  }

  let inkCount = 0;
  for (let i = 0; i < ink.length; i++) inkCount += ink[i];

  let thinMask = ink, filled = null, coreDropped = 0;
  if (o.fills) {
    const k = Math.max(1, Math.round(px(o.fillWidthMm) / 2));
    let core = erode(ink, w, h, k);
    const minCorePx = Math.max(1, Math.round(o.minFillAreaMm2 / (mmPerPx * mmPerPx)));
    const r = dropSmall(core, w, h, minCorePx);
    core = r.mask; coreDropped = r.dropped;
    let any = false;
    for (let i = 0; i < core.length; i++) if (core[i]) { any = true; break; }
    if (any) {
      const grown = dilate(core, w, h, k + 1);
      filled = new Uint8Array(w * h);
      for (let i = 0; i < filled.length; i++) filled[i] = grown[i] & ink[i];
      thinMask = new Uint8Array(w * h);
      for (let i = 0; i < thinMask.length; i++) thinMask[i] = ink[i] & (filled[i] ^ 1);
    }
  }

  const paths = [];
  const centre = skeletonToPaths(thin(thinMask, w, h), w, h);
  appendAll(paths, centre);

  let outlineCount = 0, hatchCount = 0, filledPx = 0;
  if (filled) {
    for (let i = 0; i < filled.length; i++) filledPx += filled[i];
    const inner = erode(filled, w, h, 1);
    const bnd = new Uint8Array(w * h);
    for (let i = 0; i < bnd.length; i++) bnd[i] = filled[i] & (inner[i] ^ 1);
    const ol = skeletonToPaths(bnd, w, h);
    outlineCount = ol.length;
    appendAll(paths, ol);
    if (o.hatch) {
      const pitch = Math.max(2, Math.round(px(o.penMm)));
      const hl = hatch(inner, w, h, pitch);
      hatchCount = hl.length;
      appendAll(paths, hl);
    }
  }

  // Flatten the pixel staircase before anything downstream measures or plots
  // these. Done here because the tolerance is a property of the raster, not
  // of the plot.
  const smooth = Math.max(0, o.smoothSourcePx) * Math.max(1, o.upscale || 1);
  const nodesRaw = paths.reduce((a, p) => a + p.length, 0);
  const out = smooth > 0 ? paths.map((p) => simplifyPx(p, smooth)) : paths;

  return {
    paths: out,
    width: w,
    height: h,
    stats: {
      threshold: T,
      maskedPx,
      masks: (o.masks || []).length,
      nodesRaw,
      nodes: out.reduce((a, p) => a + p.length, 0),
      inkPercent: (100 * inkCount) / (w * h),
      filledPercent: inkCount ? (100 * filledPx) / inkCount : 0,
      centreline: centre.length,
      outline: outlineCount,
      hatch: hatchCount,
      coreDropped,
      // in pixels, for the caller to hand to geom.simplify / merge / filterMin
      simplifyPx: px(o.simplifyMm),
      minStrokePx: px(o.minStrokeMm),
      mergePx: px(o.mergeMm),
    },
  };
}

// ---------------------------------------------------------------- svg out
// One layer. Deliberately: layers are for pen changes and a traced photo is
// a single-pen job, so splitting it just makes something to flatten by hand.
function pathsToSVG(paths, w, h, widthMm, penMm = 0.3) {
  const s = widthMm / w;
  const W = widthMm, H = h * s;
  const f = (n) => (Math.round(n * 1000) / 1000).toString();
  const d = paths
    .map((p) => 'M ' + p.map(([x, y]) => `${f(x * s)},${f(y * s)}`).join(' L '))
    .map((dd) => `<path d="${dd}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">
<g fill="none" stroke="#000000" stroke-width="${penMm}" stroke-linecap="round" stroke-linejoin="round">
${d}
</g>
</svg>
`;
}

module.exports = {
  DEFAULTS, traceImage, pathsToSVG,
  // exported for tests
  toGray, autoThreshold, binarise, erode, dilate, dropSmall, thin,
  skeletonToPaths, hatch,
  appendAll,
};
