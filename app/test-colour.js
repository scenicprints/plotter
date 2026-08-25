// Colour separation and the pen changes it produces.
const C = require('./src/core/colours');
const T = require('./src/core/trace');
const P = require('./src/core/pipeline');
let fail = 0;
const ok = (name, cond, got, want) => { if (cond) console.log('  ok   ' + name); else { fail++; console.log('  FAIL ' + name + '  got ' + got + ' want ' + want); } };

// A page with four distinct ink colours on white, RGBA.
function page(w, h, draw) {
  const data = new Uint8Array(w * h * 4).fill(255);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = (y * w + x) * 4;
    data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2];
  };
  draw(set);
  return { data, width: w, height: h };
}
const RED = [220, 30, 30], BLUE = [30, 60, 200], GREEN = [20, 140, 60], BLACK = [20, 20, 20];
const bar = (set, y, c, w) => { for (let x = 4; x < w - 4; x++) for (let d = 0; d < 5; d++) set(x, y + d, c); };

const img = page(120, 80, (s) => { bar(s, 6, RED, 120); bar(s, 24, BLUE, 120); bar(s, 42, GREEN, 120); bar(s, 60, BLACK, 120); });

console.log('separation');
{
  const r = C.separate(img, { colours: 4, channelOrder: 'rgba' });
  ok('finds four pens', r.layers.length === 4, r.layers.length, 4);
  ok('every pen has ink', r.layers.every((L) => L.pixels > 0), '', 'all > 0');
  const lum = r.layers.map((L) => L.luma);
  ok('ordered lightest first', lum.every((v, i) => i === 0 || lum[i - 1] >= v), lum.join(','), 'descending');
  ok('darkest pen is last', r.layers[r.layers.length - 1].name.includes('black'), r.layers[r.layers.length - 1].name, 'black');
  const masks = r.layers.map((L) => L.mask);
  let overlap = 0;
  for (let i = 0; i < masks[0].length; i++) {
    let hits = 0;
    for (const m of masks) if (m[i]) hits++;
    if (hits > 1) overlap++;
  }
  ok('masks never overlap', overlap === 0, overlap, 0);
  const paper = r.layers.reduce((a, L) => a + L.pixels, 0);
  ok('white paper is not inked', paper < 120 * 80, paper, '< all pixels');
}
{
  // Asking for fewer pens must merge, not crash.
  const r = C.separate(img, { colours: 2, channelOrder: 'rgba' });
  ok('two pens is allowed', r.layers.length === 2, r.layers.length, 2);
}
{
  let err = null;
  try { C.separate(page(20, 20, () => {}), { colours: 3, channelOrder: 'rgba' }); } catch (e) { err = e; }
  ok('a blank page is refused', !!err, err && err.message, 'throws');
}

console.log('pen changes in gcode');
{
  const sep = C.separate(img, { colours: 4, channelOrder: 'rgba' });
  const layers = sep.layers.map((c) => ({
    name: c.name, colour: c.hex, penName: c.name,
    paths: T.tracePathsFromMask(c.mask, img.width, img.height, { outline: true, upscale: 1, widthMm: img.width }),
  })).filter((L) => L.paths.length);
  const r = P.buildLayers(layers, { keepLayers: true, paperW: 150, paperH: 100, margin: 10 });
  ok('one run per pen', r.stats.runs.length === layers.length, r.stats.runs.length, layers.length);
  ok('runs carry the colour', r.stats.runs.every((x) => /^#[0-9a-f]{6}$/.test(x.colour || '')), '', 'hex');
  const starts = r.stats.runs.map((x) => x.start);
  ok('runs are in order', starts.every((v, i) => i === 0 || v > starts[i - 1]), starts.join(','), 'increasing');

  const g = P.toGcode(r.paths, r.options, { name: 't.png', runs: r.stats.runs });
  const lines = g.split('\n');
  const changes = lines.filter((l) => l.startsWith('PEN_CHANGE'));
  ok('n-1 pen changes for n pens', changes.length === layers.length - 1, changes.length, layers.length - 1);
  ok('changes name the pen', changes.every((l) => /PEN="[^"]+"/.test(l)), changes[0], 'PEN="..."');
  ok('changes are numbered', /INDEX=2 OF=/.test(changes[0]), changes[0], 'INDEX=2');
  // The lift and the unzero live in the macro, but the pen must be UP first.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('PEN_CHANGE')) {
      ok('pen is up before a change', lines[i - 1] === 'PEN_UP', lines[i - 1], 'PEN_UP');
      ok('a travel follows the change', lines[i + 1].startsWith('G0 '), lines[i + 1], 'G0 ...');
      ok('drawing resumes after the travel', lines[i + 2] === 'PEN_DOWN', lines[i + 2], 'PEN_DOWN');
      break;
    }
  }
  // A single-pen job must not gain a pen change.
  const one = P.buildLayers([layers[0]], { keepLayers: true, paperW: 150, paperH: 100, margin: 10 });
  const g1 = P.toGcode(one.paths, one.options, { name: 't.png', runs: one.stats.runs });
  ok('one pen means no pen change', !g1.includes('PEN_CHANGE'), 'found one', 'none');
}
{
  // Determinism: the same image must separate the same way every time, or the
  // trace cache would thrash and the pen order would move between rebuilds.
  const a = C.separate(img, { colours: 4, channelOrder: 'rgba' });
  const b = C.separate(img, { colours: 4, channelOrder: 'rgba' });
  ok('separation is deterministic',
    a.layers.map((L) => L.hex).join() === b.layers.map((L) => L.hex).join(),
    a.layers.map((L) => L.hex).join(), b.layers.map((L) => L.hex).join());
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
