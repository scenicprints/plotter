'use strict';
// Small JSON store in the app's userData directory. No dependency, and the
// point of it is the one thing that costs the most time on this machine:
// a Klipper restart wipes the corner, the paper size and the Z reference,
// and re-sighting all of it by hand is the single biggest time sink.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  host: 'plotter.local',
  window: { width: 1280, height: 840 },
  corner: null,          // { x, y, w, h, cx, cy, which, at }
  zeroedAt: null,        // ISO timestamp of the last PLOT_ZERO_HERE
  lastFile: null,
  settings: {
    margin: 10,
    minLen: 0.5,
    simplify: 0.05,
    mergeTol: 0.1,
    drawFeed: 3000,
    travelFeed: 9000,
    fit: 'fit',
    autoRotate: true,
    keepLayers: true,
    dryRun: true,
    paperW: 150,
    paperH: 100,
    corner: 'bottom-left',
    // tracing (only used when the artwork is a raster)
    traceThreshold: 0,     // 0 = pick automatically from the paper colour
    traceFills: true,      // outline+hatch solid shapes instead of thinning them
    traceHatch: true,
    traceFillWidth: 0.9,   // mm of ink above which something is a fill, not a line
    tracePen: 0.3,         // pen tip, sets hatch pitch
    traceUpscale: 2,
    traceOutline: true,    // trace ink outlines (line art) instead of centreline + fills
    // single-stroke text
    textOn: false,
    textMessage: '',
    textFont: 'EMSReadability',
    textSizeMm: 5,
    textLineMm: 0,      // 0 = 1.9x the cap height
    textAlign: 'centre',
    textX: 0,           // mm from the sheet centre, Y down
    textY: 0,
    masks: [],           // blanked regions, fractions of the source image
  },
};

class Store {
  constructor(dir, name = 'state.json') {
    this.file = path.join(dir, name);
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        ...DEFAULTS,
        ...parsed,
        settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
        window: { ...DEFAULTS.window, ...(parsed.window || {}) },
      };
    } catch {
      // first run, or the file got corrupted; defaults are fine either way
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      // Never let a bad write take the app down; it is only a convenience.
      console.error('could not save state:', e.message);
    }
  }

  get(key) { return key === undefined ? this.data : this.data[key]; }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  patchSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }
}

module.exports = { Store, DEFAULTS };
