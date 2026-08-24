'use strict';
// SVG path data -> polylines, with curve flattening.
// Handles every command in the spec: M m L l H h V v C c S s Q q T t A a Z z.

const NUM = /[+-]?(\d*\.\d+|\d+\.?)([eE][+-]?\d+)?/g;

function tokenize(d) {
  const out = [];
  let i = 0;
  const n = d.length;
  while (i < n) {
    const c = d[i];
    if (c === ' ' || c === ',' || c === '\n' || c === '\r' || c === '\t') { i++; continue; }
    if (/[a-zA-Z]/.test(c)) { out.push(c); i++; continue; }
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m || m.index !== i) { i++; continue; } // skip anything unparseable
    out.push(parseFloat(m[0]));
    i = NUM.lastIndex;
  }
  return out;
}

// ------------------------------------------------------------ flattening
// Adaptive subdivision: stop when the control points are flat to `tol`.
function flatCubic(x0, y0, x1, y1, x2, y2, x3, y3, tol, out, depth) {
  if (depth > 24) { out.push([x3, y3]); return; }
  const dx = x3 - x0, dy = y3 - y0;
  const len2 = dx * dx + dy * dy;
  const t2 = tol * tol;
  let flat;
  if (len2 < 1e-18) {
    // The chord is degenerate - a loop that returns to its start. Judging it
    // by distance from the chord would call it flat and throw the loop away,
    // so measure the control points against the anchor instead.
    flat = (x1 - x0) ** 2 + (y1 - y0) ** 2 <= t2
        && (x2 - x0) ** 2 + (y2 - y0) ** 2 <= t2;
  } else {
    // Sum of control-point distances from the chord, kept under `tol`.
    // Both d values are cross products, so they carry a factor of |chord|;
    // comparing squares against t2 * len2 divides it back out.
    const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
    const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
    flat = (d1 + d2) ** 2 <= t2 * len2;
  }
  if (flat) { out.push([x3, y3]); return; }
  const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
  const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2;
  const xb = (x12 + x23) / 2, yb = (y12 + y23) / 2;
  const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
  flatCubic(x0, y0, x01, y01, xa, ya, xm, ym, tol, out, depth + 1);
  flatCubic(xm, ym, xb, yb, x23, y23, x3, y3, tol, out, depth + 1);
}

function flatQuad(x0, y0, x1, y1, x2, y2, tol, out) {
  // raise to cubic, reuse the same test
  flatCubic(
    x0, y0,
    x0 + (2 / 3) * (x1 - x0), y0 + (2 / 3) * (y1 - y0),
    x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2),
    x2, y2, tol, out, 0,
  );
}

// Endpoint -> centre parameterisation, per SVG 1.1 F.6.5.
function flatArc(x0, y0, rx, ry, phiDeg, fa, fs, x, y, tol, out) {
  if (x0 === x && y0 === y) return;
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) { out.push([x, y]); return; }
  const phi = (phiDeg * Math.PI) / 180;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const dx2 = (x0 - x) / 2, dy2 = (y0 - y) / 2;
  const x1p = cp * dx2 + sp * dy2;
  const y1p = -sp * dx2 + cp * dy2;
  let rx2 = rx * rx, ry2 = ry * ry;
  const lam = (x1p * x1p) / rx2 + (y1p * y1p) / ry2;
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s; ry *= s; rx2 = rx * rx; ry2 = ry * ry;
  }
  let num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  if (num < 0) num = 0;
  let co = Math.sqrt(num / den);
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x0 + x) / 2;
  const cy = sp * cxp + cp * cyp + (y0 + y) / 2;
  const ang = (ux, uy, vx, vy) => {
    const d = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let c = (ux * vx + uy * vy) / d;
    c = c < -1 ? -1 : c > 1 ? 1 : c;
    const s = ux * vy - uy * vx < 0 ? -1 : 1;
    return s * Math.acos(c);
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  if (fs && dt < 0) dt += 2 * Math.PI;
  // pick a step that keeps the sagitta under tol
  const r = Math.max(rx, ry);
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  const n = Math.max(2, Math.ceil(Math.abs(dt) / Math.max(step, 1e-3)));
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    const ct = Math.cos(t), st = Math.sin(t);
    out.push([
      cp * rx * ct - sp * ry * st + cx,
      sp * rx * ct + cp * ry * st + cy,
    ]);
  }
}

// ------------------------------------------------------------ main parse
// Returns an array of { pts, closed }.
function parsePath(d, tol = 0.05) {
  const t = tokenize(d);
  const subs = [];
  let pts = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  let px = 0, py = 0;    // last cubic control reflection point
  let qx = 0, qy = 0;    // last quadratic control
  let prev = '';
  let i = 0;

  const start = () => { pts = [[x, y]]; subs.push({ pts, closed: false }); };
  const need = (k) => i + k <= t.length && t.slice(i, i + k).every((v) => typeof v === 'number');

  while (i < t.length) {
    let cmd = t[i];
    if (typeof cmd === 'string') { i++; } else {
      // implicit repeat: M->L, m->l, everything else repeats itself
      cmd = prev === 'M' ? 'L' : prev === 'm' ? 'l' : prev;
      if (!cmd) break;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M') {
      if (!need(2)) break;
      const nx = t[i++], ny = t[i++];
      x = rel ? x + nx : nx; y = rel ? y + ny : ny;
      sx = x; sy = y;
      start();
    } else if (C === 'L') {
      if (!need(2)) break;
      const nx = t[i++], ny = t[i++];
      x = rel ? x + nx : nx; y = rel ? y + ny : ny;
      if (!pts) start(); else pts.push([x, y]);
    } else if (C === 'H') {
      if (!need(1)) break;
      const nx = t[i++];
      x = rel ? x + nx : nx;
      if (!pts) start(); else pts.push([x, y]);
    } else if (C === 'V') {
      if (!need(1)) break;
      const ny = t[i++];
      y = rel ? y + ny : ny;
      if (!pts) start(); else pts.push([x, y]);
    } else if (C === 'C' || C === 'S') {
      const k = C === 'C' ? 6 : 4;
      if (!need(k)) break;
      let c1x, c1y;
      if (C === 'C') {
        c1x = rel ? x + t[i++] : t[i++];
        c1y = rel ? y + t[i++] : t[i++];
      } else {
        const sm = 'CS'.includes(prev.toUpperCase());
        c1x = sm ? 2 * x - px : x;
        c1y = sm ? 2 * y - py : y;
      }
      const c2x = rel ? x + t[i++] : t[i++];
      const c2y = rel ? y + t[i++] : t[i++];
      const nx = rel ? x + t[i++] : t[i++];
      const ny = rel ? y + t[i++] : t[i++];
      if (!pts) start();
      flatCubic(x, y, c1x, c1y, c2x, c2y, nx, ny, tol, pts, 0);
      px = c2x; py = c2y;
      x = nx; y = ny;
    } else if (C === 'Q' || C === 'T') {
      const k = C === 'Q' ? 4 : 2;
      if (!need(k)) break;
      let cx1, cy1;
      if (C === 'Q') {
        cx1 = rel ? x + t[i++] : t[i++];
        cy1 = rel ? y + t[i++] : t[i++];
      } else {
        const sm = 'QT'.includes(prev.toUpperCase());
        cx1 = sm ? 2 * x - qx : x;
        cy1 = sm ? 2 * y - qy : y;
      }
      const nx = rel ? x + t[i++] : t[i++];
      const ny = rel ? y + t[i++] : t[i++];
      if (!pts) start();
      flatQuad(x, y, cx1, cy1, nx, ny, tol, pts);
      qx = cx1; qy = cy1;
      x = nx; y = ny;
    } else if (C === 'A') {
      if (!need(7)) break;
      const rx = t[i++], ry = t[i++], rot = t[i++];
      const fa = t[i++] ? 1 : 0, fs = t[i++] ? 1 : 0;
      const nx = rel ? x + t[i++] : t[i++];
      const ny = rel ? y + t[i++] : t[i++];
      if (!pts) start();
      flatArc(x, y, rx, ry, rot, fa, fs, nx, ny, tol, pts);
      x = nx; y = ny;
    } else if (C === 'Z') {
      if (pts && pts.length) {
        // close it literally, so a closed shape stays closed
        if (pts[0][0] !== x || pts[0][1] !== y) pts.push([pts[0][0], pts[0][1]]);
        subs[subs.length - 1].closed = true;
      }
      x = sx; y = sy;
      pts = null;
    } else {
      break; // unknown command, stop rather than emit nonsense
    }
    if (C !== 'C' && C !== 'S') { px = x; py = y; }
    if (C !== 'Q' && C !== 'T') { qx = x; qy = y; }
    prev = cmd;
  }
  return subs.filter((s) => s.pts.length > 1);
}

module.exports = { parsePath, flatCubic, flatQuad, flatArc };
