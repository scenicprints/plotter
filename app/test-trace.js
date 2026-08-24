const T = require('./src/core/trace');
const G = require('./src/core/geom');
let fail = 0;
const ok = (name, cond, got, want) => { if (cond) console.log('  ok   ' + name); else { fail++; console.log('  FAIL ' + name + '  got ' + got + ' want ' + want); } };
const near = (a, b, t) => Math.abs(a - b) <= t;

// A synthetic page: white paper, black ink, RGBA. draw(cb) gets a setter.
function page(w, h, draw) {
  const data = new Uint8Array(w * h * 4).fill(255);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = (y * w + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = 0;
  };
  draw(set);
  return { data, width: w, height: h };
}
const hline = (set, x0, x1, y, t) => { for (let x = x0; x <= x1; x++) for (let d = 0; d < t; d++) set(x, y + d); };
const vline = (set, y0, y1, x, t) => { for (let y = y0; y <= y1; y++) for (let d = 0; d < t; d++) set(x + d, y); };
const box = (set, x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y); };
// 1 mm per px keeps the mm-based options readable in these tests
const opts = (o = {}) => ({ widthMm: 200, fills: false, ...o });

console.log('\ngreyscale and threshold');
{
  const img = page(20, 10, (s) => hline(s, 2, 17, 5, 1));
  const g = T.toGray(img, 'rgba');
  ok('white paper reads 255', g[0] === 255, g[0], 255);
  ok('black ink reads 0', g[5 * 20 + 3] === 0, g[5 * 20 + 3], 0);
  const th = T.autoThreshold(g, 20, 10);
  ok('auto threshold between ink and paper', th > 0 && th < 255, th, '0<t<255');
  ok('binarise marks only ink', T.binarise(g, th).reduce((a, b) => a + b, 0) === 16, '', 16);
}
{
  // BGRA must not change the answer for grey artwork, and must for colour
  const img = page(8, 8, (s) => box(s, 1, 1, 3, 3));
  const a = T.toGray(img, 'rgba'), b = T.toGray(img, 'bgra');
  ok('channel order irrelevant for grey', a.every((v, i) => v === b[i]), '', '');
}

console.log('\nmorphology');
{
  const w = 12, h = 12;
  const m = new Uint8Array(w * h);
  for (let y = 3; y <= 8; y++) for (let x = 3; x <= 8; x++) m[y * w + x] = 1;   // 6x6
  const e = T.erode(m, w, h, 1);
  ok('erode 6x6 -> 4x4', e.reduce((a, b) => a + b, 0) === 16, e.reduce((a, b) => a + b, 0), 16);
  const d = T.dilate(e, w, h, 1);
  ok('dilate restores 6x6', d.reduce((a, b) => a + b, 0) === 36, d.reduce((a, b) => a + b, 0), 36);
  const thinLine = new Uint8Array(w * h);
  for (let x = 1; x < 11; x++) thinLine[5 * w + x] = 1;
  ok('erode removes a 1px line', T.erode(thinLine, w, h, 1).reduce((a, b) => a + b, 0) === 0, '', 0);
}
{
  const w = 20, h = 20;
  const m = new Uint8Array(w * h);
  for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) m[y * w + x] = 1;   // 25 px
  m[15 * w + 15] = 1; m[15 * w + 16] = 1;                                       // 2 px speck
  const r = T.dropSmall(m, w, h, 10);
  ok('dropSmall keeps the big blob', r.mask.reduce((a, b) => a + b, 0) === 25, r.mask.reduce((a, b) => a + b, 0), 25);
  ok('dropSmall reports what went', r.dropped === 2, r.dropped, 2);
  ok('dropSmall clears the speck', r.mask[15 * w + 15] === 0, '', 0);
}

console.log('\nthinning');
{
  const w = 40, h = 20;
  const m = new Uint8Array(w * h);
  for (let x = 4; x < 36; x++) for (let d = 0; d < 5; d++) m[(8 + d) * w + x] = 1;  // 5px thick bar
  const t = T.thin(m, w, h);
  let rows = new Set();
  for (let i = 0; i < t.length; i++) if (t[i]) rows.add(Math.floor(i / w));
  ok('5px bar thins to a single row', rows.size === 1, rows.size, 1);
  // Zhang-Suen erodes line ENDS as well as sides, so a 32px bar skeletonises
  // to ~27. That is inherent to the algorithm, not a defect.
  ok('thinned bar keeps most of its length', t.reduce((a, b) => a + b, 0) >= 26, t.reduce((a, b) => a + b, 0), '>=26');
}

console.log('\nvectorising');
{
  const img = page(60, 20, (s) => hline(s, 5, 54, 9, 2));
  const r = T.traceImage(img, opts({ widthMm: 60 }));
  ok('one line -> one path', r.paths.length === 1, r.paths.length, 1);
  const len = G.pathLength(r.paths[0]);
  ok('traced length ~= drawn length', near(len, 49, 2), len.toFixed(2), 49);
  ok('no fills when fills:false', r.stats.outline === 0 && r.stats.hatch === 0, '', 0);
}
{
  // a cross breaks into arms at the junction; merge should not rejoin across it
  const img = page(41, 41, (s) => { hline(s, 4, 36, 20, 1); vline(s, 4, 36, 20, 1); });
  const r = T.traceImage(img, opts({ widthMm: 41 }));
  // A pixel beside the junction is diagonally adjacent to the perpendicular
  // arm, so it reads as degree 4 and the walk breaks there. The junction
  // therefore fragments, and merge() is what puts the arms back together.
  // ~66 for the two strokes, plus a little: the fragments around the junction
  // overlap, so the pen redraws a few pixels there.
  ok('cross covers both strokes', near(r.paths.reduce((a, p) => a + G.pathLength(p), 0), 68, 6),
     r.paths.reduce((a, p) => a + G.pathLength(p), 0).toFixed(1), 68);
  const arms = G.merge(r.paths, 1.5);
  ok('merge collapses the junction fragments', arms.length <= 4, arms.length, '<=4');
}
{
  // two collinear segments with a 1px gap must merge into one stroke
  const img = page(60, 20, (s) => { hline(s, 5, 25, 9, 2); hline(s, 27, 50, 9, 2); });
  // ends retract ~1px each in thinning, so the 1px drawn gap is ~4px by now
  const r = T.traceImage(img, opts({ widthMm: 60, mergeMm: 8 }));
  const merged = G.merge(r.paths, r.stats.mergePx);
  ok('merge closes a small gap', merged.length === 1, merged.length, 1);
}

console.log('\nfill detection');
{
  // a thin line and a solid 15px disc on the same page
  const img = page(80, 40, (s) => {
    hline(s, 4, 74, 6, 1);
    for (let y = -7; y <= 7; y++) for (let x = -7; x <= 7; x++) if (x * x + y * y <= 49) s(40 + x, 24 + y);
  });
  const off = T.traceImage(img, { widthMm: 80, fills: false });
  const on = T.traceImage(img, { widthMm: 80, fills: true, hatch: true, fillWidthMm: 4, minFillAreaMm2: 2 });
  ok('fill is detected', on.stats.filledPercent > 0, on.stats.filledPercent.toFixed(1) + '%', '>0');
  ok('disc becomes outline not centreline', on.stats.outline > 0, on.stats.outline, '>0');
  ok('disc gets hatched', on.stats.hatch > 0, on.stats.hatch, '>0');
  ok('the thin line survives as centreline', on.stats.centreline >= 1, on.stats.centreline, '>=1');
  ok('fills:false leaves it all centreline', off.stats.outline === 0, off.stats.outline, 0);
  const noHatch = T.traceImage(img, { widthMm: 80, fills: true, hatch: false, fillWidthMm: 4, minFillAreaMm2: 2 });
  ok('hatch:false outlines only', noHatch.stats.hatch === 0 && noHatch.stats.outline > 0, noHatch.stats.hatch, 0);
}
{
  // a line that merely thickens must NOT be promoted to a fill
  const img = page(80, 22, (s) => { hline(s, 4, 74, 10, 1); box(s, 40, 7, 45, 14); });
  const r = T.traceImage(img, { widthMm: 80, fills: true, fillWidthMm: 4, minFillAreaMm2: 20 });
  ok('tiny core is rejected as a fill', r.stats.outline === 0 && r.stats.hatch === 0, r.stats.outline + '/' + r.stats.hatch, '0/0');
  ok('and it is reported', r.stats.coreDropped > 0, r.stats.coreDropped, '>0');
}

console.log('\nscale independence');
{
  // same drawing at 1x and 3x must give the same mm geometry
  const mk = (k) => page(60 * k, 20 * k, (s) => hline(s, 5 * k, 54 * k, 9 * k, 2 * k));
  const a = T.traceImage(mk(1), opts({ widthMm: 60 }));
  const b = T.traceImage(mk(3), opts({ widthMm: 60 }));
  const la = G.pathLength(a.paths[0]) * (60 / a.width);
  const lb = G.pathLength(b.paths[0]) * (60 / b.width);
  ok('length in mm matches across resolution', near(la, lb, 1.5), `${la.toFixed(2)} vs ${lb.toFixed(2)}`, 'equal');
  ok('simplify tolerance scales with resolution', near(b.stats.simplifyPx / a.stats.simplifyPx, 3, 0.01), (b.stats.simplifyPx / a.stats.simplifyPx).toFixed(3), 3);
}

console.log('\nsvg output');
{
  const img = page(60, 30, (s) => hline(s, 5, 54, 9, 2));
  const r = T.traceImage(img, opts({ widthMm: 120 }));
  const svg = T.pathsToSVG(r.paths, r.width, r.height, 120, 0.3);
  ok('declares mm size', svg.includes('width="120mm"'), '', 'width="120mm"');
  ok('height follows aspect', svg.includes('height="60mm"'), '', 'height="60mm"');
  ok('single layer', (svg.match(/<g /g) || []).length === 1, (svg.match(/<g /g) || []).length, 1);
  ok('stroked not filled', svg.includes('fill="none"') && svg.includes('stroke="#000000"'), '', '');
  // and it must survive the app's own reader
  const { readSVG } = require('./src/core/svgdoc');
  const back = readSVG(svg, { tolerance: 0.01 }).layers.flatMap((l) => l.paths);
  ok('round-trips through readSVG', back.length === r.paths.length, back.length, r.paths.length);
  const bb = G.bbox(back);
  ok('geometry lands in mm space', near(bb.w, 94, 3), bb.w.toFixed(2), 94);
}

console.log('\nbig drawings');
{
  // dst.push(...src) passes every element as an ARGUMENT. Past roughly 100k
  // V8 throws "Maximum call stack size exceeded", and the limit falls the
  // deeper the stack already is. A traced portrait reaches that range, which
  // is exactly how this shipped and then fell over on a settings change.
  const big = new Array(200000);
  for (let i = 0; i < big.length; i++) big[i] = [[i, 0], [i, 1]];
  let threw = null;
  try { const d = []; d.push(...big); } catch (e) { threw = e; }
  ok('spread really does throw at this size', !!threw, threw ? 'threw' : 'no throw', 'threw');
  let err = null; const dst = [];
  try { T.appendAll(dst, big); } catch (e) { err = e; }
  ok('appendAll survives it', !err, err && err.message, 'no throw');
  ok('and appends every one', dst.length === big.length, dst.length, big.length);
}
{
  // The same hazard end to end: a grid of crosses fragments hard at junctions.
  const N = 600, step = 7;
  const img = page(N, N, (s) => {
    for (let y = 5; y < N - 5; y += step)
      for (let x = 5; x < N - 5; x += step)
        for (let d = -2; d <= 2; d++) { s(x + d, y); s(x, y + d); }
  });
  let r = null, err = null;
  try { r = T.traceImage(img, opts({ widthMm: 200 })); } catch (e) { err = e; }
  ok('a heavily fragmented trace completes', !err, err && err.message, 'no throw');
  ok('and it is genuinely large', r && r.paths.length > 20000, r ? r.paths.length : 0, '>20000');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
