'use strict';
// Single-stroke text.
//
// A normal font describes each letter as an OUTLINE to be filled. A pen cannot
// fill, so plotting one draws a hollow shell of every letter, and at card sizes
// the two sides of a stem sit a few tenths of a millimetre apart and smear into
// a blob. These fonts describe the path the pen travels instead: one line down
// the middle, which is what handwriting is.
//
// The files are SVG Fonts: <font-face units-per-em> plus <glyph unicode
// horiz-adv-x d>. Glyph space is Y-UP, the rest of the app is Y-down, so
// everything is flipped on the way out.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'fonts');

// Shown in the picker, best-first rather than alphabetically. The name is what
// the font actually looks like, since "EMSReadability" tells you nothing.
const CATALOGUE = [
  { id: 'EMSReadability',       name: 'Readable sans' },
  { id: 'EMSReadabilityItalic', name: 'Readable sans italic' },
  { id: 'EMSNixish',            name: 'Nixish serif' },
  { id: 'EMSNixishItalic',      name: 'Nixish serif italic' },
  { id: 'HersheySans1',         name: 'Hershey sans' },
  { id: 'HersheySansMed',       name: 'Hershey sans bold' },
  { id: 'HersheySerifMed',      name: 'Hershey serif' },
  { id: 'HersheySerifMedItalic', name: 'Hershey serif italic' },
  { id: 'HersheySerifBold',     name: 'Hershey serif bold' },
  { id: 'EMSAllure',            name: 'Allure script' },
  { id: 'EMSFelix',             name: 'Felix calligraphic' },
  { id: 'HersheyScript1',       name: 'Hershey script' },
  { id: 'HersheyScriptMed',     name: 'Hershey script bold' },
  { id: 'EMSElfin',             name: 'Elfin small' },
  { id: 'EMSOsmotron',          name: 'Osmotron rounded' },
  { id: 'EMSTech',              name: 'Tech stencil' },
  { id: 'HersheyGothEnglish',   name: 'Gothic English' },
];

function listFonts() {
  return CATALOGUE.filter((f) => fs.existsSync(path.join(DIR, f.id + '.svg')));
}

// ---------------------------------------------------------------- path data
function flattenCubic(p0, p1, p2, p3, out, tol) {
  const chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const poly = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
             + Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
             + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = Math.max(2, Math.min(48, Math.ceil((chord + poly) / (tol * 2)) + 2));
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
              a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
}

const TOKEN = /([MmLlCcZzHhVv])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;

function parsePath(d, tol) {
  const toks = [];
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(d)) !== null) toks.push(m[1] !== undefined ? m[1] : parseFloat(m[2]));
  const lines = [];
  let cur = [], cmd = null, x = 0, y = 0, sx = 0, sy = 0, i = 0;
  const flush = () => { if (cur.length > 1) lines.push(cur); cur = []; };
  const num = () => toks[i++];
  while (i < toks.length) {
    if (typeof toks[i] === 'string') { cmd = toks[i++]; }
    if (cmd === 'Z' || cmd === 'z') {
      if (cur.length > 1) { cur.push([sx, sy]); lines.push(cur); }
      cur = []; x = sx; y = sy; cmd = null;
      continue;
    }
    if (typeof toks[i] !== 'number') { i++; continue; }
    switch (cmd) {
      case 'M': case 'm': {
        let nx = num(), ny = num();
        if (cmd === 'm') { nx += x; ny += y; }
        flush();
        x = nx; y = ny; sx = x; sy = y; cur = [[x, y]];
        cmd = cmd === 'M' ? 'L' : 'l';
        break;
      }
      case 'L': case 'l': {
        let nx = num(), ny = num();
        if (cmd === 'l') { nx += x; ny += y; }
        x = nx; y = ny; cur.push([x, y]);
        break;
      }
      case 'H': case 'h': { let nx = num(); if (cmd === 'h') nx += x; x = nx; cur.push([x, y]); break; }
      case 'V': case 'v': { let ny = num(); if (cmd === 'v') ny += y; y = ny; cur.push([x, y]); break; }
      case 'C': case 'c': {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), nx = num(), ny = num();
        if (cmd === 'c') { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y; }
        if (!cur.length) cur = [[x, y]];
        flattenCubic([x, y], [x1, y1], [x2, y2], [nx, ny], cur, tol);
        x = nx; y = ny;
        break;
      }
      default: i++;
    }
  }
  flush();
  return lines;
}

// ---------------------------------------------------------------- the font
const cache = new Map();

class StrokeFont {
  constructor(id) {
    const file = path.join(DIR, id + '.svg');
    const s = fs.readFileSync(file, 'utf8');
    this.id = id;
    this.upem = parseFloat((/units-per-em="([\d.]+)"/.exec(s) || [, 1000])[1]);
    this.defaultAdv = parseFloat((/<font[ >][^>]*horiz-adv-x="([\d.]+)"/.exec(s) || [, 500])[1]);
    // Flatten in glyph units; 1/1000 em is far finer than any pen.
    const tol = this.upem / 900;
    this.glyphs = new Map();
    const re = /<glyph\b([^>]*?)\/?>/g;
    let g;
    while ((g = re.exec(s)) !== null) {
      const at = g[1];
      const u = /unicode="([^"]*)"/.exec(at);
      if (!u) continue;
      let ch = u[1];
      if (ch.startsWith('&#x')) ch = String.fromCodePoint(parseInt(ch.slice(3).replace(';', ''), 16));
      else if (ch === '&amp;') ch = '&';
      else if (ch === '&lt;') ch = '<';
      else if (ch === '&gt;') ch = '>';
      else if (ch === '&quot;') ch = '"';
      else if (ch === '&apos;') ch = "'";
      if ([...ch].length !== 1) continue;
      const adv = /horiz-adv-x="([-\d.]+)"/.exec(at);
      const d = /\bd="([^"]*)"/.exec(at);
      this.glyphs.set(ch, {
        adv: adv ? parseFloat(adv[1]) : this.defaultAdv,
        lines: d ? parsePath(d[1], tol) : [],
      });
    }
    // Measure the real cap height off H rather than trusting the metadata,
    // which is wrong in several of these files. Sizing by it means the same
    // size setting looks the same across fonts.
    const H = this.glyphs.get('H');
    let lo = 0, hi = this.upem / 2;
    if (H && H.lines.length) {
      lo = Infinity; hi = -Infinity;
      for (const l of H.lines) for (const p of l) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
    }
    this.baseline = lo;
    this.cap = hi - lo || this.upem / 2;
  }

  advance(ch) {
    const g = this.glyphs.get(ch);
    return g ? g.adv : this.defaultAdv;
  }

  // Width of a single line at the given cap height, in the same units.
  width(text, size, tracking = 0) {
    const s = size / this.cap;
    let w = 0;
    for (const ch of text) w += this.advance(ch) * s + tracking;
    return text.length ? w - tracking : 0;
  }

  // Polylines for one line of text. size is CAP HEIGHT; y is the baseline.
  // Output is Y-down, matching the rest of the app.
  line(text, size, x = 0, y = 0, tracking = 0) {
    const s = size / this.cap;
    const out = [];
    let pen = x;
    for (const ch of text) {
      const g = this.glyphs.get(ch);
      if (g) {
        for (const l of g.lines) {
          const p = new Array(l.length);
          for (let i = 0; i < l.length; i++) {
            p[i] = [pen + l[i][0] * s, y - (l[i][1] - this.baseline) * s];
          }
          out.push(p);
        }
      }
      pen += this.advance(ch) * s + tracking;
    }
    return out;
  }
}

function loadFont(id) {
  if (!cache.has(id)) cache.set(id, new StrokeFont(id));
  return cache.get(id);
}

// ---------------------------------------------------------------- layout
// A block of text as plotter paths, in mm, Y-down.
//
//   text     the message; blank lines are kept as blank lines
//   font     catalogue id
//   sizeMm   CAP height, so 5 means capitals are 5 mm tall
//   lineMm   baseline-to-baseline; defaults to 1.9x the cap height
//   align    'left' | 'centre' | 'right', about x
//   x, y     x is the anchor per align, y is the FIRST baseline
function layout(text, opts = {}) {
  const font = loadFont(opts.font || 'EMSReadability');
  const size = opts.sizeMm > 0 ? opts.sizeMm : 5;
  const lead = opts.lineMm > 0 ? opts.lineMm : size * 1.9;
  const tracking = opts.trackingMm || 0;
  const align = opts.align || 'centre';
  const x = opts.x || 0;
  const rows = String(text == null ? '' : text).split(/\r?\n/);
  const paths = [];
  let y = opts.y || 0;
  for (const row of rows) {
    const t = row.trim();
    if (t) {
      const w = font.width(t, size, tracking);
      const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
      for (const p of font.line(t, size, x0, y, tracking)) paths.push(p);
    }
    y += lead;
  }
  return paths;
}

// What a block actually occupies. This reports the INKED extent, not the
// advance box: the question it answers is "does this fit on the card", and a
// glyph's advance includes side bearings while its descenders hang outside the
// cap height. Both would be wrong at the edges. Laying the block out to find
// out is cheap at the size a card's message ever reaches.
function measure(text, opts = {}) {
  const size = opts.sizeMm > 0 ? opts.sizeMm : 5;
  const lead = opts.lineMm > 0 ? opts.lineMm : size * 1.9;
  const rows = String(text == null ? '' : text).split(/\r?\n/);
  const paths = layout(text, opts);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const q of p) {
    if (q[0] < x0) x0 = q[0];
    if (q[0] > x1) x1 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[1] > y1) y1 = q[1];
  }
  if (!isFinite(x0)) return { width: 0, height: 0, x0: 0, y0: 0, x1: 0, y1: 0, lines: rows.length, lead, size, paths: 0 };
  return { width: x1 - x0, height: y1 - y0, x0, y0, x1, y1, lines: rows.length, lead, size, paths: paths.length };
}

module.exports = { listFonts, loadFont, layout, measure, StrokeFont, CATALOGUE };
