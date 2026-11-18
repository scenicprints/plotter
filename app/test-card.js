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

console.log('\nshrink to fit');
{
  const P = require('./src/core/pipeline');
  const long = 'Somebody With A Really Long Name\n12345 Very Long Street Name Boulevard\nSacramento, CA 95814';
  const e = C.envelope({ recipient: long, recipientMm: 5, paperW: 150, paperH: 100, margin: 10, fitW: 130, fitH: 80 });
  ok('a long address shrinks', e.recipient.fitted === true && e.recipient.sizeMm < 5, e.recipient.sizeMm.toFixed(2), '<5');
  ok('...and reports what was asked', e.recipient.askedMm === 5, e.recipient.askedMm, 5);
  ok('...to just inside the box', e.recipient.width <= 130 && e.recipient.width > 128, e.recipient.width.toFixed(1), '128..130');
  const r = P.composeText(null, e.paths, { paperW: 150, paperH: 100, margin: 10 });
  ok('...so the fit check passes', r.stats.overflow === false, r.stats.overflow, false);
  const eb = G.bbox(e.paths);
  ok('...and it is still centred', near(eb.x0 + eb.x1, 0, 1), (eb.x0 + eb.x1).toFixed(2), 0);
  const short = C.envelope({ recipient: 'ELLA', recipientMm: 5, paperW: 150, paperH: 100, margin: 10, fitW: 130, fitH: 80 });
  ok('a short one is left alone', short.recipient.fitted === false && short.recipient.sizeMm === 5, short.recipient.sizeMm, 5);
  const none = C.envelope({ recipient: long, recipientMm: 5, paperW: 150, paperH: 100, margin: 10 });
  ok('no box, no shrink', none.recipient.fitted === false && none.recipient.width > 130, none.recipient.width.toFixed(1), '>130');
  // Tall: twelve lines at 10 mm caps on an 80 mm box shrinks by height.
  const tall = C.card({ message: Array(12).fill('HI').join('\n'), sizeMm: 10, fitW: 130, fitH: 80 });
  ok('a tall message shrinks by height', tall.info.fitted && tall.info.height <= 80 && tall.info.height > 78, tall.info.height.toFixed(1), '78..80');
  const bb = capBox(tall.paths);
  ok('...and stays centred', near((bb.y0 + bb.y1) / 2, 0, 0.2), ((bb.y0 + bb.y1) / 2).toFixed(2), 0);
  // The sender hangs from the corner, so after a shrink its ink is still there.
  const s = C.envelope({ sender: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', senderMm: 6, paperW: 150, paperH: 100, margin: 10, fitW: 130, fitH: 80 });
  const sb = capBox(s.paths);
  ok('a shrunk sender still starts at the inset', near(sb.x0, -65, 1e-6) && near(sb.y0, -40, 1e-6), `${sb.x0.toFixed(2)},${sb.y0.toFixed(2)}`, '-65,-40');
  ok('...and fits', s.sender.width <= 130, s.sender.width.toFixed(1), '<=130');
}

console.log('\npasted punctuation');
{
  // The font has its own “ ” and –, which are kept; ’ and … it lacks, so
  // those fall back to the straight apostrophe and three dots.
  const e = C.card({ message: 'Kevin’s yes…', sizeMm: 5 });
  const plain = C.card({ message: 'Kevin\'s yes...', sizeMm: 5 });
  ok('a curly apostrophe and an ellipsis draw as their plain forms', e.paths.length === plain.paths.length && near(e.info.width, plain.info.width, 1e-6), e.info.width.toFixed(4), plain.info.width.toFixed(4));
  ok('nothing reported missing', e.info.missing.length === 0, JSON.stringify(e.info.missing), '[]');
  const own = C.card({ message: '“card” – yes', sizeMm: 5 });
  ok('glyphs the font does have are kept', own.info.missing.length === 0 && own.paths.length > 0, JSON.stringify(own.info.missing), '[]');
  const odd = C.card({ message: 'Ella ☺', sizeMm: 5 });
  ok('a glyph the font lacks is reported', odd.info.missing.length === 1 && odd.info.missing[0] === '☺', JSON.stringify(odd.info.missing), '["☺"]');
  const acc = C.card({ message: 'José Müller', sizeMm: 5 });
  ok('accents fall back to the base letter when the font lacks them', acc.info.missing.length === 0, JSON.stringify(acc.info.missing), '[]');
}

{
  // A dropped glyph must not leave a hole or shift a centred line.
  const withOdd = C.card({ message: 'HI ☺ HI', sizeMm: 10 });
  const plain = C.card({ message: 'HI  HI', sizeMm: 10 });
  const a = capBox(withOdd.paths), b = capBox(plain.paths);
  ok('a dropped glyph takes no space', near(a.x0, b.x0, 1e-6) && near(a.x1, b.x1, 1e-6), `${a.x0.toFixed(2)}..${a.x1.toFixed(2)}`, `${b.x0.toFixed(2)}..${b.x1.toFixed(2)}`);
  ok('...and is still reported', withOdd.info.missing.join('') === '☺', JSON.stringify(withOdd.info.missing), '["☺"]');
}

{
  // Centred lines are centred by advance, so a line that starts with a wide
  // bearing ("1") reaches a bearing further on one side than its ink width
  // says. The fit has to measure reach, or a block that "fits" still trips
  // the sheet check by a quarter millimetre.
  const P = require('./src/core/pipeline');
  const e = C.envelope({
    sender: 'Kevin’s Place\n123 Example Street\nTown, ST 00000',
    recipient: 'Somebody With A Really Long Name\n12345 Very Long Street Name Boulevard ☺\nSacramento, CA 95814',
    senderMm: 3.5, recipientMm: 5, paperW: 120, paperH: 90, margin: 8, fitW: 104, fitH: 74,
  });
  const r = P.composeText(null, e.paths, { paperW: 120, paperH: 90, margin: 8 });
  ok('a shrunk, centred block passes the sheet check on both sides', r.stats.overflow === false, r.stats.overflow, false);
  const bb = G.bbox(r.paths);
  ok('...reaching no further than the margin', bb.x0 >= -52 - 1e-6 && bb.x1 <= 52 + 1e-6, `${bb.x0.toFixed(2)}..${bb.x1.toFixed(2)}`, '-52..52');
}

console.log('\nspacing, nudges, stacks');
{
  const a = C.card({ message: 'HIHIHI', sizeMm: 5 });
  const b = C.card({ message: 'HIHIHI', sizeMm: 5, spacingMm: 1 });
  ok('letter spacing widens the line by (n-1) mm', near(b.info.width - a.info.width, 5, 1e-6), (b.info.width - a.info.width).toFixed(3), 5);
  const bb = capBox(b.paths);
  ok('...and it stays centred', near(bb.x0 + bb.x1, 0, 0.8), (bb.x0 + bb.x1).toFixed(2), 0);
}
{
  const plain = C.envelope({ sender: 'ME', recipient: 'YOU', senderMm: 4, recipientMm: 5, paperW: 160, paperH: 110, margin: 10 });
  const moved = C.envelope({ sender: 'ME', recipient: 'YOU', senderMm: 4, recipientMm: 5, paperW: 160, paperH: 110, margin: 10,
    senderX: 3, senderY: -2, recipientX: -7, recipientY: 11 });
  ok('sender nudge moves the sender', near(moved.sender.box.x0 - plain.sender.box.x0, 3, 1e-6) && near(moved.sender.box.y0 - plain.sender.box.y0, -2, 1e-6),
    `${(moved.sender.box.x0 - plain.sender.box.x0).toFixed(2)},${(moved.sender.box.y0 - plain.sender.box.y0).toFixed(2)}`, '3,-2');
  ok('recipient nudge moves the recipient', near(moved.recipient.box.x0 - plain.recipient.box.x0, -7, 1e-6) && near(moved.recipient.box.y0 - plain.recipient.box.y0, 11, 1e-6),
    `${(moved.recipient.box.x0 - plain.recipient.box.x0).toFixed(2)},${(moved.recipient.box.y0 - plain.recipient.box.y0).toFixed(2)}`, '-7,11');
  ok('boxes are reported for dragging', plain.sender.box && plain.recipient.box && plain.recipient.box.x1 > plain.recipient.box.x0, '', '');
}
{
  const one = C.splitRecipients('Ella\n1 Street\nTown');
  const three = C.splitRecipients('Ella\n1 Street\nTown\n\nSam\n2 Road\n\n\n  \nKim\n3 Lane\n\n');
  ok('one address is one envelope', one.length === 1, one.length, 1);
  ok('blank lines split a stack', three.length === 3 && three[1] === 'Sam\n2 Road', JSON.stringify(three), '3 addresses');
  ok('CRLF splits too', C.splitRecipients('A\r\n\r\nB').length === 2, '', 2);
  ok('nothing gives nothing', C.splitRecipients('  \n ').length === 0, '', 0);
}
{
  const P = require('./src/core/pipeline');
  const o = { ...P.DEFAULTS, paperW: 160, paperH: 110, margin: 10, dryRun: false };
  const j = (txt) => ({ paths: C.envelope({ recipient: txt, recipientMm: 5, paperW: 160, paperH: 110 }).paths, label: txt.split('\n')[0] });
  const jobs = [j('Ella\n1 Street'), j('Sam "the man"\n2 Road'), j('Kim\n3 Lane')];
  const g = P.toGcodeStack(jobs, o, { name: 'test', time: '1m 00s' });
  const pauses = (g.match(/^PAUSE$/gm) || []).length;
  ok('a stack of 3 pauses twice', pauses === 2, pauses, 2);
  const msgs = g.match(/^RESPOND MSG="NEXT ENVELOPE \d+ of 3: .*"$/gm) || [];
  ok('...each pause names the next envelope', msgs.length === 2 && /2 of 3: Sam the man\./.test(msgs[0]) && /3 of 3: Kim\./.test(msgs[1]), JSON.stringify(msgs), 'two messages');
  ok('...with quotes stripped from the label', !/Sam "the/.test(g), '', '');
  ok('the pen lifts clear before each pause', (g.match(/^G91\nG1 Z20 F\d+\nG90\nM400\n/gm) || []).length === 2, '', 2);
  ok('one header, one footer', (g.match(/^PLOT_START$/gm) || []).length === 1 && (g.match(/^; done$/gm) || []).length === 1, '', '');
  const total = jobs.reduce((a, x) => a + x.paths.length, 0);
  ok('every path of every envelope is in the file', (g.match(/^PEN_DOWN$/gm) || []).length === total, (g.match(/^PEN_DOWN$/gm) || []).length, total);
  const dry = P.toGcodeStack(jobs, { ...o, dryRun: true }, {});
  ok('a dry run flies the stack without pausing', !/^PAUSE$/m.test(dry) && !/PEN_DOWN/.test(dry), '', '');
  // the plain emitter is untouched by the refactor
  const single = P.toGcode(jobs[0].paths, o, { name: 'one', time: '0m 10s' });
  ok('a single job starts and ends as before', /^G21\nG90\nPLOT_START\n/m.test(single) && /PEN_UP\nG1 Z20 F\d+\n; done\n$/.test(single), '', '');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
