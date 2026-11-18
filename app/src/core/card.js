'use strict';
// Envelopes and cards: the two layouts that are all text and have a fixed
// place for it. Both return paths in mm, Y-down, origin at the sheet centre,
// exactly what strokefont.layout gives and composeText expects.
//
// The plain "Add text" box anchors the FIRST baseline, so a message grows
// downward from wherever it is put. A card wants the opposite: the block is
// anchored at its middle and grows evenly up and down, so one line sits dead
// centre and five lines are still centred as a group.

const SF = require('./strokefont');

// Leading and trailing blank lines carry no ink but would still shift the
// centre, so they go. Blank lines in the middle are kept as spacing.
function trimRows(text) {
  const rows = String(text == null ? '' : text).split(/\r?\n/);
  let a = 0, b = rows.length;
  while (a < b && !rows[a].trim()) a++;
  while (b > a && !rows[b - 1].trim()) b--;
  return rows.slice(a, b);
}

function lineHeight(size, lineMm) {
  return lineMm > 0 ? lineMm : size * 1.9;
}

// Height of a block from the cap top of its first line to the baseline of
// its last. Descenders hang below and ascenders never rise above the caps,
// so this is what the eye reads as the block, and what gets centred.
function blockHeight(rows, size, lead) {
  return rows.length ? size + (rows.length - 1) * lead : 0;
}

// A block whose MIDDLE is at (x, y). Returns the first baseline it used, so
// a caller can tell where the lines actually sit.
function centredBlock(rows, opts) {
  const size = opts.sizeMm > 0 ? opts.sizeMm : 5;
  const lead = lineHeight(size, opts.lineMm);
  const h = blockHeight(rows, size, lead);
  const y = (opts.y || 0) - h / 2 + size;
  const paths = SF.layout(rows.join('\n'), { ...opts, sizeMm: size, lineMm: lead, y });
  return { paths, firstBaseline: y, height: h, lead, size, lines: rows.length };
}

// A block hanging from a corner: its INK starts at (x, top). Left-aligned,
// the way a return address is written. Placed by ink rather than by cap
// height and advance, because a K overshoots the cap line by a tenth of a
// millimetre and a side bearing holds the first letter off the x: either
// would put the ink a hair across the margin, which the fit check reads as
// an overflow.
function cornerBlock(rows, opts) {
  const size = opts.sizeMm > 0 ? opts.sizeMm : 5;
  const lead = lineHeight(size, opts.lineMm);
  const x = opts.x || 0, top = opts.top || 0;
  const paths = SF.layout(rows.join('\n'), { ...opts, sizeMm: size, lineMm: lead, x, y: top + size, align: 'left' });
  let x0 = Infinity, y0 = Infinity;
  for (const p of paths) for (const q of p) { if (q[0] < x0) x0 = q[0]; if (q[1] < y0) y0 = q[1]; }
  const dx = isFinite(x0) ? x - x0 : 0, dy = isFinite(y0) ? top - y0 : 0;
  for (const p of paths) for (const q of p) { q[0] += dx; q[1] += dy; }
  return { paths, firstBaseline: top + size + dy, height: blockHeight(rows, size, lead), lead, size, lines: rows.length };
}

function info(block, text, opts) {
  const m = SF.measure(text, opts);
  return {
    lines: block.lines,
    paths: block.paths.length,
    width: m.width,
    height: m.height,
    lineMm: block.lead,
    sizeMm: block.size,
  };
}

// ---------------------------------------------------------------- card
//   message   the text
//   font      catalogue id
//   sizeMm    cap height
//   lineMm    baseline pitch, 0 = auto
//   align     'left' | 'centre' | 'right', about x
//   x, y      mm from the sheet centre, Y down; the block's MIDDLE lands here
function card(o = {}) {
  const rows = trimRows(o.message);
  if (!rows.length) return { paths: [], info: null };
  const opts = {
    font: o.font || 'EMSReadability',
    sizeMm: Number(o.sizeMm) || 5,
    lineMm: Number(o.lineMm) || 0,
    align: o.align || 'centre',
    x: Number(o.x) || 0,
    y: Number(o.y) || 0,
  };
  const b = centredBlock(rows, opts);
  return { paths: b.paths, info: info(b, rows.join('\n'), { ...opts, y: b.firstBaseline, lineMm: b.lead }) };
}

// ---------------------------------------------------------------- envelope
//   sender, recipient   the two addresses; either may be blank
//   font                one font for both
//   senderMm            cap height of the return address
//   recipientMm         cap height of the delivery address
//   recipientY          mm below the centre for the recipient block's middle
//   paperW, paperH      the envelope, mm
//   margin              inset of the return address from the top-left corner
//
// Sender top-left, inset by the margin. Recipient centred, which is where
// the eye and the sorting machine both look first; the Y nudge drops it
// toward the lower half when a long return address wants the room.
function envelope(o = {}) {
  const W = Number(o.paperW) || 150, H = Number(o.paperH) || 100;
  const margin = Number(o.margin) || 0;
  const font = o.font || 'EMSReadability';
  const out = { paths: [], sender: null, recipient: null };

  const s = trimRows(o.sender);
  if (s.length) {
    const opts = { font, sizeMm: Number(o.senderMm) || 3.5, lineMm: 0, x: -W / 2 + margin, top: -H / 2 + margin };
    const b = cornerBlock(s, opts);
    out.paths.push(...b.paths);
    out.sender = info(b, s.join('\n'), { ...opts, y: b.firstBaseline, lineMm: b.lead, align: 'left' });
  }

  const r = trimRows(o.recipient);
  if (r.length) {
    const opts = { font, sizeMm: Number(o.recipientMm) || 5, lineMm: 0, align: 'centre', x: 0, y: Number(o.recipientY) || 0 };
    const b = centredBlock(r, opts);
    out.paths.push(...b.paths);
    out.recipient = info(b, r.join('\n'), { ...opts, y: b.firstBaseline, lineMm: b.lead });
  }
  return out;
}

module.exports = { card, envelope, trimRows, blockHeight };
