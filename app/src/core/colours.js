'use strict';
// Colour separation: one pen's worth of ink per layer.
//
// A multicolour plot is not a colour print. The plotter draws each colour with
// a different pen, one after another, so the job here is to decide which of a
// small number of pens each inked pixel belongs to, and to hand back one mask
// per pen for the tracer to outline.
//
// k-means in RGB, seeded deterministically (k-means++ with a fixed LCG rather
// than Math.random) so the same image always separates the same way. That
// matters: the trace is cached on its options, and a wobbling palette would
// invalidate the cache and re-order the pen changes on every rebuild.

const DEFAULTS = {
  colours: 4,          // how many pens
  paperLevel: 236,     // lighter than this is paper, never ink
  sampleMax: 40000,    // pixels used to fit the palette
  iterations: 14,
  minShare: 0.004,     // drop a pen that claims under 0.4% of the ink
};

// Deterministic 32-bit LCG. Seeded from the image so it is stable per image.
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function luma(r, g, b) { return (r * 77 + g * 150 + b * 29) >> 8; }

function hex(r, g, b) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Rough, friendly name for a swatch, so the pen-change prompt can say
// "load the red pen" instead of reciting a hex code.
function nameOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = luma(r, g, b);
  if (mx - mn < 28) {
    if (l < 60) return 'black';
    if (l < 140) return 'dark grey';
    return 'grey';
  }
  let h = 0;
  const d = mx - mn;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const base = h < 15 ? 'red' : h < 45 ? 'orange' : h < 70 ? 'yellow'
    : h < 160 ? 'green' : h < 200 ? 'cyan' : h < 255 ? 'blue'
      : h < 290 ? 'purple' : h < 335 ? 'magenta' : 'red';
  return l < 70 ? `dark ${base}` : base;
}

// img: { data, width, height } as handed over by raster.loadBitmap.
// order: 'rgba' | 'bgra' (Electron gives BGRA on Windows).
// Returns { layers: [{ hex, name, rgb, pixels, share, mask }], inkPixels, k }
// ordered lightest first, so dark ink lands on top of light ink.
function separate(img, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { data, width: w, height: h } = img;
  const n = w * h;
  const px = data.length / n;                 // 4 for RGBA/BGRA, 3 for RGB
  const bgr = o.channelOrder === 'bgra';

  const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n);
  const ink = new Uint8Array(n);
  let inkPixels = 0;
  for (let i = 0, p = 0; i < n; i++, p += px) {
    const c0 = data[p], c1 = data[p + 1], c2 = data[p + 2];
    const r = bgr ? c2 : c0, g = c1, b = bgr ? c0 : c2;
    R[i] = r; G[i] = g; B[i] = b;
    if (luma(r, g, b) < o.paperLevel) { ink[i] = 1; inkPixels++; }
  }
  if (!inkPixels) throw new Error('that image is blank - nothing to plot');

  const k = Math.max(1, Math.min(12, Math.round(o.colours)));

  // ---- sample the ink for fitting
  const stride = Math.max(1, Math.floor(inkPixels / o.sampleMax));
  const sample = [];
  for (let i = 0, seen = 0; i < n; i++) {
    if (!ink[i]) continue;
    if (seen++ % stride === 0) sample.push(i);
  }

  // ---- k-means++ seeding, deterministic
  const rnd = lcg(inkPixels * 2654435761 + w * 40503 + h);
  const cr = new Float64Array(k), cg = new Float64Array(k), cb = new Float64Array(k);
  const first = sample[Math.floor(rnd() * sample.length)];
  cr[0] = R[first]; cg[0] = G[first]; cb[0] = B[first];
  const d2 = new Float64Array(sample.length).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let s = 0; s < sample.length; s++) {
      const i = sample[s];
      const dr = R[i] - cr[c - 1], dg = G[i] - cg[c - 1], db = B[i] - cb[c - 1];
      const d = dr * dr + dg * dg + db * db;
      if (d < d2[s]) d2[s] = d;
      total += d2[s];
    }
    let pick = total * rnd(), s = 0;
    while (s < sample.length - 1 && (pick -= d2[s]) > 0) s++;
    const i = sample[s];
    cr[c] = R[i]; cg[c] = G[i]; cb[c] = B[i];
  }

  // ---- Lloyd iterations on the sample
  const sr = new Float64Array(k), sg = new Float64Array(k), sb = new Float64Array(k);
  const cnt = new Float64Array(k);
  for (let it = 0; it < o.iterations; it++) {
    sr.fill(0); sg.fill(0); sb.fill(0); cnt.fill(0);
    for (let s = 0; s < sample.length; s++) {
      const i = sample[s];
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = R[i] - cr[c], dg = G[i] - cg[c], db = B[i] - cb[c];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      sr[best] += R[i]; sg[best] += G[i]; sb[best] += B[i]; cnt[best]++;
    }
    let moved = 0;
    for (let c = 0; c < k; c++) {
      if (!cnt[c]) continue;
      const nr = sr[c] / cnt[c], ng = sg[c] / cnt[c], nb = sb[c] / cnt[c];
      moved += Math.abs(nr - cr[c]) + Math.abs(ng - cg[c]) + Math.abs(nb - cb[c]);
      cr[c] = nr; cg[c] = ng; cb[c] = nb;
    }
    if (moved < 1) break;
  }

  // ---- assign every ink pixel, building one mask per pen
  const masks = [];
  for (let c = 0; c < k; c++) masks.push(new Uint8Array(n));
  const counts = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    if (!ink[i]) continue;
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const dr = R[i] - cr[c], dg = G[i] - cg[c], db = B[i] - cb[c];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = c; }
    }
    masks[best][i] = 1; counts[best]++;
  }

  let layers = [];
  for (let c = 0; c < k; c++) {
    if (!counts[c]) continue;
    const share = counts[c] / inkPixels;
    if (share < o.minShare) continue;          // a stray fringe, not a pen
    const r = Math.round(cr[c]), g = Math.round(cg[c]), b = Math.round(cb[c]);
    layers.push({
      hex: hex(r, g, b), name: nameOf(r, g, b), rgb: [r, g, b],
      pixels: counts[c], share, luma: luma(r, g, b), mask: masks[c],
    });
  }
  if (!layers.length) throw new Error('no colour held enough ink to plot');
  // Lightest first: dark lines then sit on top of pale ones, which is how a
  // drawing reads, and it keeps the darkest pen for last.
  layers.sort((a, b2) => b2.luma - a.luma);
  return { layers, inkPixels, k: layers.length };
}

module.exports = { separate, DEFAULTS, nameOf, hex };
