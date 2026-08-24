const F = require('./src/core/strokefont');
const G = require('./src/core/geom');
let fail = 0;
const ok = (name, cond, got, want) => { if (cond) console.log('  ok   ' + name); else { fail++; console.log('  FAIL ' + name + '  got ' + got + ' want ' + want); } };
const near = (a, b, t) => Math.abs(a - b) <= t;

console.log('\nthe catalogue');
{
  const list = F.listFonts();
  ok('every catalogued font is bundled', list.length === F.CATALOGUE.length, list.length, F.CATALOGUE.length);
  let bad = [];
  for (const f of list) {
    try {
      const font = F.loadFont(f.id);
      if (!font.glyphs.size || !(font.cap > 0)) bad.push(f.id);
    } catch (e) { bad.push(f.id + ':' + e.message); }
  }
  ok('all of them load and measure', bad.length === 0, bad.join(','), 'none bad');
}
{
  // A missing glyph silently plots nothing, which is worse than looking wrong
  const font = F.loadFont('EMSReadability');
  const missing = [];
  for (let c = 0x20; c < 0x7f; c++) {
    const ch = String.fromCharCode(c);
    if (!font.glyphs.has(ch)) missing.push(ch);
  }
  ok('covers printable ASCII', missing.length === 0, JSON.stringify(missing.join('')), 'none missing');
}

console.log('\nsingle stroke, not outline');
{
  // The whole point: an outline font draws o as two closed curves and the pen
  // leaves a hollow ring. A single-stroke o is one loop.
  for (const id of ['EMSReadability', 'HersheySans1', 'EMSNixish']) {
    const font = F.loadFont(id);
    const o = font.glyphs.get('o');
    ok(`${id}: o is one stroke`, o.lines.length === 1, o.lines.length, 1);
  }
  const font = F.loadFont('EMSReadability');
  ok('i is two strokes (stem + dot)', font.glyphs.get('i').lines.length === 2, font.glyphs.get('i').lines.length, 2);
  ok('space draws nothing', font.glyphs.get(' ').lines.length === 0, '', 0);
  ok('space still advances', font.advance(' ') > 0, font.advance(' '), '>0');
}

console.log('\nmetrics');
{
  const font = F.loadFont('EMSReadability');
  const p = font.line('H', 10, 0, 0);
  const bb = G.bbox(p);
  ok('cap height 10 gives a 10mm H', near(bb.h, 10, 0.05), bb.h.toFixed(3), 10);
  ok('H sits ON the baseline', near(bb.y1, 0, 0.05), bb.y1.toFixed(3), 0);
  // Y-down everywhere else in the app, so the top of a capital is negative
  ok('Y is down: cap top is above the baseline', bb.y0 < -9, bb.y0.toFixed(2), '<-9');
  const w5 = font.width('Hello', 5), w10 = font.width('Hello', 10);
  ok('width scales with size', near(w10 / w5, 2, 1e-9), (w10 / w5).toFixed(4), 2);
  ok('wider text is wider', font.width('mmmm', 5) > font.width('ii', 5), '', '');
  const t0 = font.width('abc', 5, 0), t1 = font.width('abc', 5, 1);
  ok('tracking adds between letters only', near(t1 - t0, 2, 1e-9), (t1 - t0).toFixed(3), 2);
}
{
  // p descends, so it must reach below the baseline
  const font = F.loadFont('EMSReadability');
  const bb = G.bbox(font.line('p', 10, 0, 0));
  ok('descenders go below the baseline', bb.y1 > 0.5, bb.y1.toFixed(2), '>0.5');
}

console.log('\nlayout');
{
  const opt = { font: 'EMSReadability', sizeMm: 5, x: 0, y: 0 };
  const c = G.bbox(F.layout('Hello', { ...opt, align: 'centre' }));
  ok('centre straddles x', near(c.x0 + c.x1, 0, 0.4), (c.x0 + c.x1).toFixed(3), 0);
  // Ink starts a little inside the advance box. That side bearing is the
  // font's own letter spacing and is correct, so allow it rather than
  // demanding the ink touch x exactly.
  const l = G.bbox(F.layout('Hello', { ...opt, align: 'left' }));
  ok('left starts at x, within a bearing', l.x0 >= 0 && l.x0 < 1.5, l.x0.toFixed(3), '0..1.5');
  const r = G.bbox(F.layout('Hello', { ...opt, align: 'right' }));
  ok('right ends at x, within a bearing', r.x1 <= 0 && r.x1 > -1.5, r.x1.toFixed(3), '-1.5..0');
}
{
  // Capitals on both lines, so the span really is cap height plus pitch.
  // Lowercase measures x-height and would say nothing about the pitch.
  const two = F.layout('HI\nHI', { font: 'EMSReadability', sizeMm: 5, lineMm: 9, x: 0, y: 0 });
  const bb = G.bbox(two);
  ok('line pitch is honoured', near(bb.h, 14, 0.3), bb.h.toFixed(2), 14);
  const one = F.layout('HI', { font: 'EMSReadability', sizeMm: 5, lineMm: 9, x: 0, y: 0 });
  ok('two lines draw more than one', two.length > one.length, two.length, '>' + one.length);
}
{
  // Blank lines are spacing, not something to collapse away
  const gap = F.layout('a\n\nb', { font: 'EMSReadability', sizeMm: 5, lineMm: 8, x: 0, y: 0 });
  ok('blank line leaves a gap', near(G.bbox(gap).h, 21, 1.5), G.bbox(gap).h.toFixed(1), 21);
  ok('empty text draws nothing', F.layout('', {}).length === 0, F.layout('', {}).length, 0);
  ok('whitespace-only draws nothing', F.layout('   \n  ', {}).length === 0, '', 0);
}

console.log('\nmeasure agrees with layout');
{
  const o = { font: 'EMSNixish', sizeMm: 6, lineMm: 11, align: 'centre', x: 0, y: 0 };
  const txt = 'Happy 6th Birthday!\nLove, Kevin';
  const m = F.measure(txt, o);
  const bb = G.bbox(F.layout(txt, o));
  // measure reports the INKED box, so it must agree exactly, descenders included
  ok('measured width matches', near(m.width, bb.w, 1e-9), `${m.width.toFixed(3)} vs ${bb.w.toFixed(3)}`, 'equal');
  ok('measured height matches', near(m.height, bb.h, 1e-9), `${m.height.toFixed(3)} vs ${bb.h.toFixed(3)}`, 'equal');
  ok('and says where it sits', near(m.x0, bb.x0, 1e-9) && near(m.y0, bb.y0, 1e-9), '', '');
  ok('descenders count toward the height', m.height > o.sizeMm + o.lineMm, m.height.toFixed(2), '>' + (o.sizeMm + o.lineMm));
  ok('empty measures zero', F.measure('', o).width === 0, '', 0);
}

console.log('\nplotter sanity');
{
  // Text must be open strokes the pen can follow, not a pile of tiny fragments
  const p = F.layout('Happy 6th Birthday!', { font: 'EMSReadability', sizeMm: 5, x: 0, y: 0 });
  const total = p.reduce((a, q) => a + G.pathLength(q), 0);
  ok('draws a sensible amount', total > 50 && total < 600, total.toFixed(0), '50..600');
  ok('no degenerate single-point paths', p.every((q) => q.length >= 2), '', '');
  const merged = G.merge(p, 0.05);
  ok('strokes survive a merge pass', merged.length > 0 && merged.length <= p.length, merged.length, '<=' + p.length);
}

console.log('\ncomposed onto a plot');
{
  const P = require('./src/core/pipeline');
  const o = { paperW: 100, paperH: 100, margin: 5, drawFeed: 3000, travelFeed: 9000,
              lift: 2, zUpFeed: 900, zDownFeed: 600 };
  const txt = F.layout('HI', { font: 'EMSReadability', sizeMm: 10, x: 0, y: 0 });
  const only = P.composeText(null, txt, o);
  ok('text alone is a valid plot', only.paths.length > 0, only.paths.length, '>0');
  ok('and it is counted as text', only.stats.textPaths === txt.length, only.stats.textPaths, txt.length);
  // paper space is Y UP, so a cap above its baseline must land at positive y
  const top = Math.max(...only.paths.flat().map((q) => q[1]));
  ok('Y is flipped into paper space', top > 5, top.toFixed(2), '>5');
  const art = P.buildLayers([{ name: 'a', paths: [[[0, 0], [50, 0], [50, 50], [0, 0]]] }], o);
  const both = P.composeText(art, txt, o);
  ok('text adds to the artwork', both.stats.paths === art.stats.paths + txt.length,
     both.stats.paths, art.stats.paths + txt.length);
  ok('and the estimate grows', both.stats.seconds > art.stats.seconds, '', '');
  // far off the sheet: must be reported, not silently plotted into the clamp
  const off = P.composeText(null, F.layout('HI', { font: 'EMSReadability', sizeMm: 10, x: 200, y: 0 }), o);
  ok('off-sheet text overflows', off.stats.overflow === true, off.stats.overflow, true);
  ok('centred text does not', only.stats.overflow === false, only.stats.overflow, false);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
