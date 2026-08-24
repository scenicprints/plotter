'use strict';
// SVG document -> layers of polylines in millimetres.
//
// Deliberate choices, taken from what actually bit this project:
//  * <polygon> is read AND kept closed. vpype writes closed paths as <polygon>
//    and cannot read them back, so any round trip through it silently loses
//    closed geometry. There is no round trip here, but the reader is correct
//    anyway.
//  * Layers are preserved in document order and sorted independently, because
//    SVG layers draw in order and the card art relies on text plotting last.

const { parseXML } = require('./xml');
const { parsePath } = require('./svgpath');

const PX_PER_MM = 96 / 25.4;

// ------------------------------------------------------------- transforms
// Matrix as [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
const ID = [1, 0, 0, 1, 0, 0];

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function parseTransform(str) {
  if (!str) return ID;
  let m = ID;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let g;
  while ((g = re.exec(str))) {
    const a = g[2].split(/[\s,]+/).map(parseFloat).filter((v) => !Number.isNaN(v));
    switch (g[1]) {
      case 'matrix':
        if (a.length >= 6) m = mul(m, a.slice(0, 6));
        break;
      case 'translate':
        m = mul(m, [1, 0, 0, 1, a[0] || 0, a[1] || 0]);
        break;
      case 'scale': {
        const sx = a[0] === undefined ? 1 : a[0];
        const sy = a[1] === undefined ? sx : a[1];
        m = mul(m, [sx, 0, 0, sy, 0, 0]);
        break;
      }
      case 'rotate': {
        const r = ((a[0] || 0) * Math.PI) / 180;
        const c = Math.cos(r), s = Math.sin(r);
        if (a.length >= 3) {
          m = mul(m, [1, 0, 0, 1, a[1], a[2]]);
          m = mul(m, [c, s, -s, c, 0, 0]);
          m = mul(m, [1, 0, 0, 1, -a[1], -a[2]]);
        } else {
          m = mul(m, [c, s, -s, c, 0, 0]);
        }
        break;
      }
      case 'skewX':
        m = mul(m, [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0]);
        break;
      case 'skewY':
        m = mul(m, [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]);
        break;
      default:
        break;
    }
  }
  return m;
}

// ------------------------------------------------------------- units
function toUserUnits(v, viewLen) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = /^([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|%)?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'mm': return n * PX_PER_MM;
    case 'cm': return n * 10 * PX_PER_MM;
    case 'in': return n * 96;
    case 'pt': return (n * 96) / 72;
    case 'pc': return (n * 96) / 6;
    case '%': return viewLen ? (n / 100) * viewLen : null;
    default: return n;
  }
}

// ------------------------------------------------------------- shapes
function shapeToSubs(el, tol) {
  const a = el.attrs;
  const num = (k, d = 0) => {
    const v = parseFloat(a[k]);
    return Number.isFinite(v) ? v : d;
  };
  const pts = (s) => {
    const out = [];
    const vals = String(s || '').trim().split(/[\s,]+/).map(parseFloat);
    for (let i = 0; i + 1 < vals.length; i += 2) {
      if (Number.isFinite(vals[i]) && Number.isFinite(vals[i + 1])) out.push([vals[i], vals[i + 1]]);
    }
    return out;
  };

  switch (el.name) {
    case 'path':
      return a.d ? parsePath(a.d, tol) : [];
    case 'line':
      return [{ pts: [[num('x1'), num('y1')], [num('x2'), num('y2')]], closed: false }];
    case 'polyline': {
      const p = pts(a.points);
      return p.length > 1 ? [{ pts: p, closed: false }] : [];
    }
    case 'polygon': {
      const p = pts(a.points);
      if (p.length < 2) return [];
      p.push([p[0][0], p[0][1]]);
      return [{ pts: p, closed: true }];
    }
    case 'rect': {
      const x = num('x'), y = num('y'), w = num('width'), h = num('height');
      if (w <= 0 || h <= 0) return [];
      let rx = a.rx != null ? num('rx') : (a.ry != null ? num('ry') : 0);
      let ry = a.ry != null ? num('ry') : (a.rx != null ? num('rx') : 0);
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (rx > 0 && ry > 0) {
        const d = `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}`
          + `V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}`
          + `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}`
          + `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
        return parsePath(d, tol);
      }
      return [{
        pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]],
        closed: true,
      }];
    }
    case 'circle':
    case 'ellipse': {
      const cx = num('cx'), cy = num('cy');
      const rx = el.name === 'circle' ? num('r') : num('rx');
      const ry = el.name === 'circle' ? num('r') : num('ry');
      if (rx <= 0 || ry <= 0) return [];
      const d = `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}`
        + `A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
      return parsePath(d, tol);
    }
    default:
      return [];
  }
}

// ------------------------------------------------------------- style
function hidden(el) {
  const a = el.attrs;
  const style = String(a.style || '');
  if (a.display === 'none' || /(^|;)\s*display\s*:\s*none/.test(style)) return true;
  if (a.visibility === 'hidden' || /(^|;)\s*visibility\s*:\s*hidden/.test(style)) return true;
  return false;
}

function isLayer(el) {
  if (el.name !== 'g') return false;
  for (const k of Object.keys(el.attrs)) {
    if (k.endsWith('groupmode') && el.attrs[k] === 'layer') return true;
  }
  return false;
}

function layerName(el, i) {
  for (const k of Object.keys(el.attrs)) {
    if (k.endsWith('label') && el.attrs[k]) return el.attrs[k];
  }
  return el.attrs.id || `layer ${i}`;
}

// ------------------------------------------------------------- main
// Returns { layers: [{ name, paths }], width, height, unitScale }
// Geometry is in millimetres, Y still pointing down as in SVG.
function readSVG(src, opts = {}) {
  const tolPx = (opts.tolerance || 0.05) * PX_PER_MM;
  const root = parseXML(src);
  let svg = null;
  const findSvg = (n) => {
    if (n.name === 'svg') return n;
    for (const c of n.children) {
      const r = findSvg(c);
      if (r) return r;
    }
    return null;
  };
  svg = findSvg(root);
  if (!svg) throw new Error('no <svg> element found');

  // viewBox and the user-unit -> mm scale
  let vb = null;
  if (svg.attrs.viewBox) {
    const v = svg.attrs.viewBox.trim().split(/[\s,]+/).map(parseFloat);
    if (v.length === 4 && v.every(Number.isFinite)) vb = v;
  }
  const wAttr = toUserUnits(svg.attrs.width, vb ? vb[2] : null);
  const hAttr = toUserUnits(svg.attrs.height, vb ? vb[3] : null);

  // Root transform maps user units to px, then px to mm at the end.
  let rootM = ID;
  if (vb) {
    const sx = wAttr ? wAttr / vb[2] : 1;
    const sy = hAttr ? hAttr / vb[3] : 1;
    const s = wAttr && hAttr ? Math.min(sx, sy) : (wAttr ? sx : (hAttr ? sy : 1));
    rootM = mul([s, 0, 0, s, 0, 0], [1, 0, 0, 1, -vb[0], -vb[1]]);
  }

  const layers = [];
  let cur = { name: 'default', paths: [] };
  layers.push(cur);

  const walk = (el, m, layer) => {
    if (hidden(el)) return;
    const m2 = el.attrs.transform ? mul(m, parseTransform(el.attrs.transform)) : m;
    let target = layer;
    if (isLayer(el)) {
      target = { name: layerName(el, layers.length), paths: [] };
      layers.push(target);
    }
    // Flattening happens in this element's own coordinate system, so the
    // tolerance has to be carried down through the accumulated transform.
    // Without this a viewBox scale silently multiplies the real-world error.
    const det = Math.abs(m2[0] * m2[3] - m2[1] * m2[2]);
    const localScale = det > 1e-18 ? Math.sqrt(det) : 1;
    const subs = shapeToSubs(el, tolPx / localScale);
    for (const s of subs) {
      const p = s.pts.map((q) => apply(m2, q[0], q[1]));
      if (p.length > 1) target.paths.push(p);
    }
    for (const c of el.children) walk(c, m2, target);
  };

  for (const c of svg.children) walk(c, rootM, cur);

  // px -> mm
  const k = 1 / PX_PER_MM;
  for (const L of layers) {
    for (const p of L.paths) {
      for (const q of p) { q[0] *= k; q[1] *= k; }
    }
  }

  return {
    layers: layers.filter((L) => L.paths.length),
    width: wAttr ? wAttr * k : (vb ? vb[2] * k : null),
    height: hAttr ? hAttr * k : (vb ? vb[3] * k : null),
  };
}

module.exports = { readSVG, parseTransform, mul, apply, toUserUnits, PX_PER_MM };
