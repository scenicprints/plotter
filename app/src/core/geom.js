'use strict';
// Geometry helpers. A "path" is an array of [x, y] points in mm, SVG space (Y down).

function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

function pathLength(p) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]);
  return L;
}

function isClosed(p, tol = 1e-6) {
  return p.length > 2 && dist(p[0], p[p.length - 1]) <= tol;
}

function bbox(paths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const q of p) {
    if (q[0] < x0) x0 = q[0];
    if (q[0] > x1) x1 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[1] > y1) y1 = q[1];
  }
  if (!isFinite(x0)) return null;
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- simplify
// Douglas-Peucker, iterative so deep paths cannot blow the stack.
function simplify(pts, tol) {
  if (tol <= 0 || pts.length < 3) return pts;
  const n = pts.length;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j - i < 2) continue;
    const ax = pts[i][0], ay = pts[i][1], bx = pts[j][0], by = pts[j][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD = -1;
    for (let k = i + 1; k < j; k++) {
      const px = pts[k][0] - ax, py = pts[k][1] - ay;
      let d2;
      if (len2 === 0) {
        d2 = px * px + py * py;
      } else {
        let t = (px * dx + py * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * dx, ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > bestD) { bestD = d2; best = k; }
    }
    if (bestD > t2) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// ---------------------------------------------------------------- grid index
// Uniform grid for nearest-endpoint queries. Cheap and good enough for the
// path counts a pen plotter sees (hundreds to low tens of thousands).
class Grid {
  constructor(pts, cell) {
    this.cell = cell > 0 ? cell : 1;
    this.map = new Map();
    this.pts = pts;
    this.count = 0;
    this.mincx = Infinity; this.maxcx = -Infinity;
    this.mincy = Infinity; this.maxcy = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (!pts[i]) continue;
      const gx = Math.floor(pts[i][0] / this.cell);
      const gy = Math.floor(pts[i][1] / this.cell);
      const k = gx + ':' + gy;
      let b = this.map.get(k);
      if (!b) this.map.set(k, b = []);
      b.push(i);
      this.count++;
      if (gx < this.mincx) this.mincx = gx;
      if (gx > this.maxcx) this.maxcx = gx;
      if (gy < this.mincy) this.mincy = gy;
      if (gy > this.maxcy) this.maxcy = gy;
    }
  }

  remove(i) {
    const p = this.pts[i];
    if (!p) return;
    const k = Math.floor(p[0] / this.cell) + ':' + Math.floor(p[1] / this.cell);
    const b = this.map.get(k);
    if (!b) return;
    const at = b.indexOf(i);
    if (at >= 0) { b.splice(at, 1); this.count--; }
  }

  // Nearest live index to (x, y), or -1. Rings outward from the home cell.
  // A point sitting in ring k is at least (k - 1) * cell away, so once the
  // best hit is within r * cell no later ring can beat it.
  nearest(x, y, maxDist) {
    if (this.count === 0) return -1;
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let maxR = Math.max(
      cx - this.mincx, this.maxcx - cx,
      cy - this.mincy, this.maxcy - cy,
    ) + 1;
    if (maxDist !== undefined) {
      maxR = Math.min(maxR, Math.ceil(maxDist / this.cell) + 1);
    }
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= maxR; r++) {
      const x0 = cx - r, x1 = cx + r, y0 = cy - r, y1 = cy + r;
      for (let gx = x0; gx <= x1; gx++) {
        const edgeX = gx === x0 || gx === x1;
        for (let gy = y0; gy <= y1; gy++) {
          if (r > 0 && !edgeX && gy !== y0 && gy !== y1) continue;
          const b = this.map.get(gx + ':' + gy);
          if (b === undefined || b.length === 0) continue;
          for (let n = 0; n < b.length; n++) {
            const p = this.pts[b[n]];
            const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
            if (d < bestD) { bestD = d; best = b[n]; }
          }
        }
      }
      if (best >= 0 && r * this.cell >= Math.sqrt(bestD)) break;
    }
    if (best >= 0 && maxDist !== undefined && bestD > maxDist * maxDist) return -1;
    return best;
  }
}

// ---------------------------------------------------------------- merge
// Join paths whose ends coincide within tol, reversing where that helps.
// This is what turns a traced drawing's thousands of fragments into far
// fewer strokes, and every stroke removed is a pen lift saved.
function merge(paths, tol) {
  if (tol <= 0 || paths.length < 2) return paths.slice();
  const live = paths.map((p) => p.slice());
  const used = new Uint8Array(live.length);
  // endpoint list: 2i = start of i, 2i+1 = end of i
  const ends = [];
  for (let i = 0; i < live.length; i++) {
    ends.push(live[i][0], live[i][live[i].length - 1]);
  }
  const grid = new Grid(ends, Math.max(tol * 2, 0.5));
  const out = [];
  for (let i = 0; i < live.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    grid.remove(2 * i); grid.remove(2 * i + 1);
    let cur = live[i];
    // extend forward from the end, then backward from the start
    for (let dir = 0; dir < 2; dir++) {
      if (dir === 1) cur = cur.slice().reverse();
      for (;;) {
        const tip = cur[cur.length - 1];
        const j = grid.nearest(tip[0], tip[1], tol);
        if (j < 0) break;
        const pi = j >> 1;
        if (used[pi]) { grid.remove(j); continue; }
        if (dist(ends[j], tip) > tol) break;
        let add = live[pi];
        if (j & 1) add = add.slice().reverse(); // matched its end, so flip
        used[pi] = 1;
        grid.remove(2 * pi); grid.remove(2 * pi + 1);
        cur = cur.concat(add.slice(1));
      }
    }
    out.push(cur);
  }
  return out;
}

// ---------------------------------------------------------------- reloop
// Rotate a closed path so it starts at the vertex nearest the pen.
function reloop(p, x, y) {
  if (!isClosed(p, 1e-6)) return p;
  const body = p.slice(0, -1);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < body.length; i++) {
    const d = (body[i][0] - x) ** 2 + (body[i][1] - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best === 0) return p;
  const rot = body.slice(best).concat(body.slice(0, best));
  rot.push(rot[0].slice());
  return rot;
}

// ---------------------------------------------------------------- sort
// Greedy nearest-neighbour over both endpoints, reversing open paths freely
// and re-seaming closed ones. Returns { paths, travel } with travel in mm.
function sortPaths(paths, startX = 0, startY = 0, doReloop = true) {
  if (!paths.length) return { paths: [], travel: 0 };
  const ends = [];
  for (const p of paths) ends.push(p[0], p[p.length - 1]);
  const bb = bbox(paths);
  const cell = bb ? Math.max((bb.w + bb.h) / Math.max(8, Math.sqrt(paths.length)), 0.5) : 1;
  const grid = new Grid(ends, cell);
  const used = new Uint8Array(paths.length);
  const out = [];
  let x = startX, y = startY, travel = 0;
  for (let n = 0; n < paths.length; n++) {
    const j = grid.nearest(x, y);
    if (j < 0) break;
    const pi = j >> 1;
    if (used[pi]) { grid.remove(j); n--; continue; }
    used[pi] = 1;
    grid.remove(2 * pi); grid.remove(2 * pi + 1);
    let p = paths[pi];
    if (isClosed(p, 1e-6)) {
      if (doReloop) p = reloop(p, x, y);
    } else if (j & 1) {
      p = p.slice().reverse();
    }
    travel += dist([x, y], p[0]);
    out.push(p);
    const tip = p[p.length - 1];
    x = tip[0]; y = tip[1];
  }
  // anything the grid missed (degenerate coords) goes on the end
  for (let i = 0; i < paths.length; i++) if (!used[i]) out.push(paths[i]);
  return { paths: out, travel };
}

function filterMin(paths, minLen) {
  if (minLen <= 0) return paths;
  return paths.filter((p) => pathLength(p) >= minLen);
}

module.exports = {
  dist, pathLength, isClosed, bbox, simplify, merge, reloop, sortPaths, filterMin, Grid,
};
