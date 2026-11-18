const C = require('./src/core/card');
const F = require('./src/core/strokefont');
const G = require('./src/core/geom');
let fail = 0;
const ok = (name, cond, got, want) => { if (cond) console.log('  ok   ' + name); else { fail++; console.log('  FAIL ' + name + '  got ' + got + ' want ' + want); } };
const near = (a, b, t) => Math.abs(a - b) <= t;
const font = F.loadFont('EMSReadability');

// Cap top and last baseline of a block, ignoring descenders: the H and the
// capital at the end of every line are what the eye reads as the block.
function capBox(paths) { return G.bbox(paths); }

console.log('\ncard: the block is centred, not hung from its first line');
{
  const one = C.card({ message: 'HIH', sizeMm: 10 });
  const bb = capBox(one.paths);
  ok('one line: cap top at -5', near(bb.y0, -5, 0.05), bb.y0.toFixed(2), -5);
  ok('one line: baseline at +5', near(bb.y1, 5, 0.2), bb.y1.toFixed(2), 5);
  ok('one line: straddles x', near(bb.x0 + bb.x1, 0, 0.8), (bb.x0 + bb.x1).toFixed(2), 0);
  ok('reports one line', one.info.lines === 1, one.info.lines, 1);
}
{
  // Three lines at cap 10, auto pitch 19: block is 10 + 2*19 = 48 tall and
  // runs from -24 to +24. Straight capitals only: round letters overshoot the cap line by a hair.
  const three = C.card({ message: 'HELLO\nTHERE\nWORLD', sizeMm: 10 });
  const bb = capBox(three.paths);
  ok('three lines: top at -24', near(bb.y0, -24, 0.2), bb.y0.toFixed(2), -24);
  ok('three lines: bottom at +24', near(bb.y1, 24, 0.2), bb.y1.toFixed(2), 24);
  ok('pitch reported', near(three.info.lineMm, 19, 1e-9), three.info.lineMm, 19);
  ok('block height is 48', near(C.blockHeight(['a', 'b', 'c'], 10, 19), 48, 1e-9), '', 48);
}
{
  // Adding a line grows the block both ways, by half a pitch each.
  const a = capBox(C.card({ message: 'HI\nHI', sizeMm: 10 }).paths);
  const b = capBox(C.card({ message: 'HI\nHI\nHI', sizeMm: 10 }).paths);
  ok('grows upward', near(a.y0 - b.y0, 9.5, 0.05), (a.y0 - b.y0).toFixed(2), 9.5);
  ok('grows downward', near(b.y1 - a.y1, 9.5, 0.05), (b.y1 - a.y1).toFixed(2), 9.5);
}
{
  const nudged = capBox(C.card({ message: 'HIH', sizeMm: 10, x: 7, y: -12 }).paths);
  ok('x nudge moves the block', near(nudged.x0 + nudged.x1, 14, 0.8), (nudged.x0 + nudged.x1).toFixed(2), 14);
  ok('y nudge moves the middle', near((nudged.y0 + nudged.y1) / 2, -12, 0.05), ((nudged.y0 + nudged.y1) / 2).toFixed(2), -12);
}
{
  const custom = C.card({ message: 'HI\nHI', sizeMm: 10, lineMm: 12 });
  const bb = capBox(custom.paths);
  ok('line mm overrides the pitch', near(bb.y1 - bb.y0, 22, 0.2), (bb.y1 - bb.y0).toFixed(2), 22);
}
{
  // Blank lines around the message carry no ink and must not shift it.
  const plain = capBox(C.card({ message: 'HIH', sizeMm: 10 }).paths);
  const padded = capBox(C.card({ message: '\n\nHIH\n\n', sizeMm: 10 }).paths);
  ok('surrounding blank lines ignored', near(plain.y0, padded.y0, 1e-9) && near(plain.y1, padded.y1, 1e-9), padded.y0.toFixed(2), plain.y0.toFixed(2));
  // ...but one in the middle is spacing and stays
  const gap = capBox(C.card({ message: 'HI\n\nHI', sizeMm: 10 }).paths);
  ok('a blank line in the middle is kept', near(gap.y1 - gap.y0, 48, 0.2), (gap.y1 - gap.y0).toFixed(2), 48);
  ok('empty message gives nothing', C.card({ message: '  \n ' }).paths.length === 0 && C.card({}).info === null, '', 'nothing');
}
{
  const l = capBox(C.card({ message: 'HI\nHELLO', sizeMm: 5, align: 'left' }).paths);
  const r = capBox(C.card({ message: 'HI\nHELLO', sizeMm: 5, align: 'right' }).paths);
  ok('left align starts near x', l.x0 >= 0 && l.x0 < 1.5, l.x0.toFixed(2), '0..1.5');
  ok('right align ends near x', r.x1 <= 0 && r.x1 > -1.5, r.x1.toFixed(2), '-1.5..0');
}

console.log('\nenvelope: sender top-left, recipient centred');
{
  const W = 160, H = 110, margin = 12;
  const e = C.envelope({
    sender: 'KEVIN\nSTREET\nTOWN', recipient: 'ELLA\nHOUSE\nCITY',
    senderMm: 4, recipientMm: 6, paperW: W, paperH: H, margin,
  });
  ok('both blocks reported', !!e.sender && !!e.recipient, '', '');
  // Pull the sender's own strokes back out by position: everything above the
  // centre line and left of it is the return address.
  const sp = e.paths.filter((p) => p.every((q) => q[1] < -10));
  const sb = capBox(sp);
  ok('sender ink top sits exactly at the inset', near(sb.y0, -H / 2 + margin, 1e-6), sb.y0.toFixed(3), (-H / 2 + margin));
  ok('sender ink left edge exactly at the inset', near(sb.x0, -W / 2 + margin, 1e-6), sb.x0.toFixed(3), (-W / 2 + margin));
  ok('sender is 4 + 2*7.6 tall', near(sb.y1 - sb.y0, 4 + 2 * 7.6, 0.05), (sb.y1 - sb.y0).toFixed(2), 4 + 2 * 7.6);
  const rp = e.paths.filter((p) => p.every((q) => q[1] >= -20));
  const rb = capBox(rp);
  ok('recipient straddles x', near(rb.x0 + rb.x1, 0, 0.8), (rb.x0 + rb.x1).toFixed(2), 0);
  ok('recipient middle at the centre', near((rb.y0 + rb.y1) / 2, 0, 0.05), ((rb.y0 + rb.y1) / 2).toFixed(2), 0);
  ok('recipient is 6 + 2*11.4 tall', near(rb.y1 - rb.y0, 6 + 2 * 11.4, 0.2), (rb.y1 - rb.y0).toFixed(2), 6 + 2 * 11.4);
  ok('path count is the sum', e.paths.length === e.sender.paths + e.recipient.paths, e.paths.length, e.sender.paths + e.recipient.paths);
}
{
  const e = C.envelope({ recipient: 'TILL', recipientMm: 6, recipientY: 15, paperW: 160, paperH: 110 });
  const rb = capBox(e.paths);
  ok('recipient Y nudge drops the block', near((rb.y0 + rb.y1) / 2, 15, 0.05), ((rb.y0 + rb.y1) / 2).toFixed(2), 15);
  ok('no sender when blank', e.sender === null, '', null);
}
{
  const e = C.envelope({ sender: 'ME', senderMm: 4, paperW: 160, paperH: 110, margin: 10 });
  ok('no recipient when blank', e.recipient === null && e.paths.length > 0, '', null);
  const none = C.envelope({ paperW: 160, paperH: 110 });
  ok('nothing at all when both blank', none.paths.length === 0, none.paths.length, 0);
}
{
  // The sender must not be wider than the font says: it is left-aligned so
  // its ink starts at the inset and runs right.
  const e = C.envelope({ sender: 'WWWW', senderMm: 4, paperW: 160, paperH: 110, margin: 10 });
  const bb = capBox(e.paths);
  const w = font.width('WWWW', 4);
  ok('sender runs right from the inset', bb.x1 <= -80 + 10 + w + 0.01, bb.x1.toFixed(2), '<= ' + (-70 + w).toFixed(2));
}
{
  // The case that tripped the fit check: a K overshoots the cap line, and
  // the sender sits ON the margin, so by cap height it crossed it by 0.1 mm.
  const P = require('./src/core/pipeline');
  const e = C.envelope({
    sender: 'Kevin Wagner\n123 Example Street\nTown, ST 00000',
    recipient: 'Ella Wagner\n456 Example Avenue\nCity, ST 00000',
    senderMm: 3.5, recipientMm: 5, paperW: 160, paperH: 110, margin: 10,
  });
  const r = P.composeText(null, e.paths, { paperW: 160, paperH: 110, margin: 10 });
  ok('an envelope laid out at the margin fits', r.stats.overflow === false, r.stats.overflow, false);
  const r2 = P.composeText(null, e.paths, { paperW: 160, paperH: 110, margin: 11 });
  ok('...and a tighter margin catches it', r2.stats.overflow === true, r2.stats.overflow, true);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
