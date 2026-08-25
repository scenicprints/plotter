'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { Machine } = require('./machine');
const { Store } = require('./store');
const { build, buildLayers, composeText, toGcode } = require('../core/pipeline');
const SF = require('../core/strokefont');
const { traceImage, pathsToSVG, DEFAULTS: TRACE_DEFAULTS } = require('../core/trace');
const { isRaster, loadBitmap, plannedWidthMm, RASTER_EXT } = require('./raster');
const G = require('../core/geom');

let win = null;
let store = null;
let machine = null;
let pollTimer = null;
let lastJob = null;    // { paths, stats, options, gcode, name }
let traceCache = null; // { key, file, paths, heightMm, widthMm, stats, options }

// ------------------------------------------------------------------ window
function createWindow() {
  const b = store.get('window') || {};
  win = new BrowserWindow({
    width: b.width || 1280,
    height: b.height || 840,
    minWidth: 1060,
    minHeight: 700,
    x: b.x,
    y: b.y,
    show: false,
    backgroundColor: '#181613',
    autoHideMenuBar: true,
    title: 'Plotter',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    const { x, y, width, height } = win.getBounds();
    store.set('window', { x, y, width, height });
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('closed', () => { win = null; });

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ------------------------------------------------------------------ polling
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startPolling() {
  stopPolling();
  const tick = async () => {
    try {
      const s = await machine.refresh();
      send('status', s);
      // Poll harder while something is moving, gentler when idle.
      schedule(s.printing ? 700 : 1200);
    } catch (e) {
      send('status', { online: false, error: e.message });
      schedule(3000);
    }
  };
  const schedule = (ms) => {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(tick, ms);
  };
  tick();
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

// ------------------------------------------------------------------ helpers
// Turn any thrown error into a plain result the renderer can show, rather
// than an unhandled rejection that silently does nothing.
function guard(fn) {
  return async (_evt, ...args) => {
    try {
      const value = await fn(...args);
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  };
}

function safeName(file) {
  const base = path.basename(file || 'plot.svg').replace(/\.[^.]+$/, '');
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48) || 'plot';
  return `${clean}.gcode`;
}

// ------------------------------------------------------------------ tracing
function traceOptionsFrom(o) {
  return {
    threshold: Number(o.traceThreshold) || 0,          // 0 = pick automatically
    fills: o.traceFills !== false,
    hatch: o.traceHatch !== false,
    fillWidthMm: Number(o.traceFillWidth) || TRACE_DEFAULTS.fillWidthMm,
    penMm: Number(o.tracePen) || TRACE_DEFAULTS.penMm,
    outline: !!o.traceOutline,
    // Outline mode traces the native pixel grid; upscaling only adds points
    // and staircase there without helping (that trick is for the skeleton).
    upscale: o.traceOutline ? 1 : (Number(o.traceUpscale) || 2),
    masks: Array.isArray(o.masks) ? o.masks : [],
  };
}

// Tracing a big drawing takes a few seconds, and the settings that do NOT
// affect it (feeds, dry run) are exactly the ones fiddled with most, so the
// result is cached against everything that genuinely changes it.
function traceFor(file, o) {
  const t = traceOptionsFrom(o);
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* recheck below */ }
  const key = JSON.stringify([file, mtime, t, o.paperW, o.paperH, o.margin, o.fit, o.autoRotate]);
  if (traceCache && traceCache.key === key) return traceCache;

  const bmp = loadBitmap(file, t.upscale);
  const widthMm = plannedWidthMm(bmp.sourceWidth, bmp.sourceHeight, o);
  const res = traceImage(bmp, { ...t, upscale: bmp.scale, widthMm, channelOrder: 'bgra' });
  const mm = widthMm / bmp.width;
  const paths = res.paths.map((p) => p.map((q) => [q[0] * mm, q[1] * mm]));

  traceCache = {
    key,
    file,
    paths,
    widthMm,
    heightMm: (widthMm * bmp.height) / bmp.width,
    options: o,
    stats: {
      ...res.stats,
      upscale: bmp.scale,
      sourceWidth: bmp.sourceWidth,
      sourceHeight: bmp.sourceHeight,
      widthMm,
      heightMm: (widthMm * bmp.height) / bmp.width,
      raw: res.paths.length,
    },
  };
  return traceCache;
}

// Preview payload: draw polylines plus the travel moves between them, in
// paper space (origin at the sheet centre, Y up).
function previewOf(paths) {
  const draw = paths.map((p) => p.map((q) => [+q[0].toFixed(2), +q[1].toFixed(2)]));
  const travel = [];
  let prev = null;
  for (const p of draw) {
    if (prev) travel.push([prev[0], prev[1], p[0][0], p[0][1]]);
    prev = p[p.length - 1];
  }
  return { draw, travel };
}

// ------------------------------------------------------------------ IPC
function wireIPC() {
  ipcMain.handle('state:get', guard(async () => store.get()));

  ipcMain.handle('state:setSettings', guard(async (patch) => store.patchSettings(patch)));

  ipcMain.handle('machine:setHost', guard(async (host) => {
    const base = machine.setHost(host);
    store.set('host', host);
    if (!base) throw new Error('that does not look like an address');
    return base;
  }));

  ipcMain.handle('machine:connect', guard(async () => {
    const r = await machine.connect();
    startPolling();
    return r;
  }));

  ipcMain.handle('machine:status', guard(async () => machine.refresh()));
  ipcMain.handle('machine:home', guard(async () => machine.home()));
  ipcMain.handle('machine:jog', guard(async (dx, dy) => machine.jog(dx, dy)));
  ipcMain.handle('machine:zRoom', guard(async () => machine.zRoom()));
  ipcMain.handle('machine:releaseZ', guard(async () => {
    const s = await machine.releaseZ();
    store.set('zeroedAt', null);
    return s;
  }));
  ipcMain.handle('machine:zJog', guard(async (d) => machine.zJog(d)));
  ipcMain.handle('machine:penUp', guard(async () => machine.penUp()));
  ipcMain.handle('machine:penDown', guard(async () => machine.penDown()));
  ipcMain.handle('machine:penTest', guard(async () => machine.penTest()));
  ipcMain.handle('machine:gotoCentre', guard(async () => machine.gotoPaperCentre()));

  // SEND 1
  ipcMain.handle('machine:zeroHere', guard(async () => {
    const s = await machine.zeroHere();
    store.set('zeroedAt', new Date().toISOString());
    return s;
  }));
  ipcMain.handle('machine:unzero', guard(async () => {
    const s = await machine.unzero();
    store.set('zeroedAt', null);
    return s;
  }));

  // SEND 2
  ipcMain.handle('machine:setCorner', guard(async (w, h, which) => {
    const r = await machine.setCorner(w, h, which);
    store.set('corner', { ...r.corner, at: new Date().toISOString() });
    store.patchSettings({ paperW: w, paperH: h, corner: which });
    return r;
  }));
  ipcMain.handle('machine:restoreCorner', guard(async () => {
    const c = store.get('corner');
    if (!c) throw new Error('no corner has been saved yet');
    const s = await machine.restoreCorner(c);
    return { status: s, corner: c };
  }));

  ipcMain.handle('machine:setLift', guard(async (mm) => machine.setLift(mm)));
  ipcMain.handle('machine:preflight', guard(async () => machine.preflight()));
  ipcMain.handle('machine:console', guard(async (n) => machine.console(n)));

  // ---------------------------------------------------------------- files
  ipcMain.handle('file:pick', guard(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose artwork',
      filters: [
        { name: 'Artwork', extensions: ['svg', ...RASTER_EXT] },
        { name: 'SVG', extensions: ['svg'] },
        { name: 'Line drawings', extensions: RASTER_EXT },
      ],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  }));

  ipcMain.handle('text:fonts', guard(async () => SF.listFonts()));

  // ---------------------------------------------------------------- build
  ipcMain.handle('plot:build', guard(async (file, settings) => {
    if (!file) throw new Error('choose some artwork first');
    // Take the live lift and feeds off the machine when it is reachable, so
    // the estimate matches reality instead of a stale config on this laptop.
    const live = machine.last;
    const opts = {
      ...settings,
      lift: live?.lift ?? 10,
      zUpFeed: live?.zUpFeed ?? 1800,
      zDownFeed: live?.zDownFeed ?? 900,
    };

    // Text is optional and can stand alone: a card that is only a message is
    // a perfectly good plot, so artwork is not required when there is text.
    const wantText = !!(settings && settings.textOn && String(settings.textMessage || '').trim());
    const textOpts = {
      font: settings.textFont || 'EMSReadability',
      sizeMm: Number(settings.textSizeMm) || 5,
      lineMm: Number(settings.textLineMm) || 0,
      align: settings.textAlign || 'centre',
      x: Number(settings.textX) || 0,
      y: Number(settings.textY) || 0,
    };
    if (!file && !wantText) throw new Error('choose some artwork, or turn on text');

    let r, trace = null;
    if (!file) {
      r = null;
    } else if (isRaster(file)) {
      // A traced drawing is one pen's worth of work, so it enters as a single
      // layer. build's simplify / merge / filterMin then do the clean-up the
      // skeleton needs, which is why the tracer does none of it itself.
      const t = traceFor(file, opts);
      trace = t.stats;
      r = buildLayers([{ name: 'trace', paths: t.paths }], opts);
    } else {
      let src;
      try {
        src = fs.readFileSync(file, 'utf8');
      } catch (e) {
        throw new Error(`cannot read that file: ${e.message}`);
      }
      r = build(src, opts);
    }

    let text = null;
    if (wantText) {
      const paths = SF.layout(settings.textMessage, textOpts);
      const m = SF.measure(settings.textMessage, textOpts);
      r = composeText(r, paths, opts);
      text = {
        font: textOpts.font,
        paths: paths.length,
        width: m.width,
        height: m.height,
        lines: m.lines,
        sizeMm: textOpts.sizeMm,
        lineMm: m.lead,
      };
    }
    if (!r) throw new Error('nothing to plot');
    const label = file ? path.basename(file) : 'text';
    const gcode = toGcode(r.paths, r.options, { name: label, time: r.stats.time });
    lastJob = { ...r, gcode, file, name: safeName(file || 'message.svg') };
    if (file) store.set('lastFile', file);
    return {
      stats: r.stats,
      trace,
      text,
      preview: previewOf(r.paths),
      paper: { w: r.options.paperW, h: r.options.paperH, margin: r.options.margin },
      name: lastJob.name,
      gcodeLines: gcode.split('\n').length,
      gcodeBytes: Buffer.byteLength(gcode, 'utf8'),
    };
  }));

  // The traced drawing as a reusable SVG. Cleaned with the same tolerances
  // the plot used, so what lands on disk is what the pen would have drawn,
  // not the raw fifty-thousand-fragment skeleton.
  ipcMain.handle('plot:saveSvg', guard(async () => {
    if (!traceCache) throw new Error('trace a drawing first');
    const o = traceCache.options;
    let paths = traceCache.paths.map((p) => G.simplify(p, o.simplify ?? 0.05));
    paths = G.merge(paths, o.mergeTol ?? 0.1);
    paths = G.filterMin(paths, o.minLen ?? 0.5);
    const base = path.basename(traceCache.file).replace(/\.[^.]+$/, '');
    const r = await dialog.showSaveDialog(win, {
      title: 'Save traced SVG',
      defaultPath: `${base}_traced.svg`,
      filters: [{ name: 'SVG', extensions: ['svg'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const svg = pathsToSVG(paths, traceCache.widthMm, traceCache.heightMm,
                           traceCache.widthMm, Number(o.tracePen) || 0.3);
    fs.writeFileSync(r.filePath, svg, 'utf8');
    return { file: r.filePath, paths: paths.length };
  }));

  ipcMain.handle('plot:saveGcode', guard(async () => {
    if (!lastJob) throw new Error('nothing built yet');
    const r = await dialog.showSaveDialog(win, {
      title: 'Save gcode',
      defaultPath: lastJob.name,
      filters: [{ name: 'G-code', extensions: ['gcode'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, lastJob.gcode, 'utf8');
    return r.filePath;
  }));

  // SEND 3
  ipcMain.handle('plot:send', guard(async () => {
    if (!lastJob) throw new Error('nothing built yet');
    const pre = await machine.preflight();
    if (!pre.ok) {
      const e = new Error(pre.problems.join('; '));
      e.problems = pre.problems;
      throw e;
    }
    // The sheet the gcode was laid out for must match the sheet the machine
    // is set up for, or the plot lands off the card.
    const s = pre.status;
    const w = lastJob.options.paperW, h = lastJob.options.paperH;
    if (Math.abs(s.paperW - w) > 0.5 || Math.abs(s.paperH - h) > 0.5) {
      throw new Error(
        `this was laid out for ${w} x ${h} mm but the machine is set to `
        + `${s.paperW} x ${s.paperH} mm. Re-set the corner, or rebuild at the machine's size.`,
      );
    }
    await machine.uploadAndStart(lastJob.name, lastJob.gcode, { start: true });
    return { name: lastJob.name };
  }));

  ipcMain.handle('plot:pause', guard(async () => machine.pause()));
  ipcMain.handle('plot:resume', guard(async () => machine.resume()));
  ipcMain.handle('plot:cancel', guard(async () => machine.cancel()));
  ipcMain.handle('plot:estop', guard(async () => machine.estop()));
}

// ------------------------------------------------------------------ boot
// A headless self-check: boot, render, save a screenshot, quit. Only ever
// runs when the env var is set, so it cannot affect normal use.
function smokeTest() {
  if (!process.env.PLOTTER_SMOKE) return;
  win.webContents.on('console-message', (_e, level, message, line, src) => {
    console.log(`[renderer:${level}] ${message}` + (src ? ` (${src}:${line})` : ''));
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', JSON.stringify(d)));
  win.once('ready-to-show', () => {
    setTimeout(async () => {
      try {
        if (process.env.PLOTTER_SMOKE_CLICK) {
          await win.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(process.env.PLOTTER_SMOKE_CLICK)}).click()`);
          await new Promise((r) => setTimeout(r, 600));
        }
        const img = await win.webContents.capturePage();
        const out = process.env.PLOTTER_SMOKE_OUT || 'smoke.png';
        fs.writeFileSync(out, img.toPNG());
        console.log('[smoke] wrote ' + out);
      } catch (e) {
        console.log('[smoke] capture failed: ' + e.message);
      }
      app.exit(0);
    }, Number(process.env.PLOTTER_SMOKE_MS || 4500));
  });
}

app.whenReady().then(() => {
  if (process.env.PLOTTER_USERDATA) app.setPath('userData', process.env.PLOTTER_USERDATA);
  store = new Store(app.getPath('userData'));
  machine = new Machine(store.get('host'));
  wireIPC();
  createWindow();
  smokeTest();
  startPolling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopPolling();
  if (process.platform !== 'darwin') app.quit();
});
