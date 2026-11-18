'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { Machine } = require('./machine');
const { Store } = require('./store');
const { build, buildLayers, composeText, toGcode, toGcodeStack, fmtTime } = require('../core/pipeline');
const SF = require('../core/strokefont');
const CARD = require('../core/card');
const { traceImage, pathsToSVG, tracePathsFromMask, DEFAULTS: TRACE_DEFAULTS } = require('../core/trace');
const { separate } = require('../core/colours');
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

// One pen per colour. Same tracer, run over each colour's mask, returned as
// layers so buildLayers keeps them apart and toGcode can put a PEN_CHANGE on
// each boundary.
let colourCache = null;
function colourTraceFor(file, o) {
  const t = traceOptionsFrom(o);
  const colours = Math.max(2, Math.min(12, Number(o.traceColours) || 4));
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* recheck below */ }
  const key = JSON.stringify([file, mtime, t, colours, o.paperW, o.paperH, o.margin, o.fit, o.autoRotate]);
  if (colourCache && colourCache.key === key) return colourCache;

  const bmp = loadBitmap(file, 1);            // native resolution, like outline mode
  const widthMm = plannedWidthMm(bmp.sourceWidth, bmp.sourceHeight, o);
  const sep = separate(bmp, { colours, channelOrder: 'bgra' });
  const mm = widthMm / bmp.width;

  const layers = [];
  for (const c of sep.layers) {
    const paths = tracePathsFromMask(c.mask, bmp.width, bmp.height, {
      ...t, outline: true, upscale: 1, widthMm,
    });
    if (!paths.length) continue;
    layers.push({
      name: c.name, colour: c.hex, penName: c.name,
      paths: paths.map((p) => p.map((q) => [q[0] * mm, q[1] * mm])),
      swatch: { hex: c.hex, name: c.name, share: c.share },
    });
  }
  if (!layers.length) throw new Error('no colour produced any strokes - try fewer colours');

  colourCache = {
    key, file, layers, widthMm,
    heightMm: (widthMm * bmp.height) / bmp.width,
    stats: {
      mode: 'colour',
      colours: layers.length,
      swatches: layers.map((L) => ({ ...L.swatch, paths: L.paths.length })),
      sourceWidth: bmp.sourceWidth, sourceHeight: bmp.sourceHeight,
      inkPixels: sep.inkPixels,
      widthMm, heightMm: (widthMm * bmp.height) / bmp.width,
    },
  };
  return colourCache;
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

// ------------------------------------------------------------------ written
// The Card tab: an envelope (sender top-left, recipient centred) or a card
// (one message, centred both ways). Same compose, gcode and preview as text
// added to artwork, so dry run, the sheet check and Send all behave the same.

const firstLine = (t) => String(t || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';

// Ink boxes in paper space (Y up) for the blocks the preview lets you drag,
// from the Y-down boxes the layouts report.
function blockOf(id, info) {
  if (!info || !info.box) return null;
  const b = info.box;
  return { id, x0: b.x0, x1: b.x1, y0: -b.y1, y1: -b.y0 };
}

function writtenOptions(opts, mode) {
  const o = { ...opts, margin: Number(mode === 'envelope' ? opts.envMargin : opts.cardMargin) || 0 };
  o.availW = Math.max(1, o.paperW - 2 * o.margin);
  o.availH = Math.max(1, o.paperH - 2 * o.margin);
  return o;
}

function writtenPayload(r, stats, text, blocks, name) {
  const gcode = lastJob.gcode;
  return {
    stats,
    trace: null,
    text,
    blocks,
    preview: previewOf(r.paths),
    paper: { w: r.options.paperW, h: r.options.paperH, margin: r.options.margin },
    name,
    gcodeLines: gcode.split('\n').length,
    gcodeBytes: Buffer.byteLength(gcode, 'utf8'),
  };
}

// What a recent-jobs entry remembers: everything on the Write card plus the
// sheet it was laid out for.
const JOB_KEYS = [
  'writeMode', 'paperW', 'paperH',
  'envSender', 'envRecipient', 'envFont', 'envSenderMm', 'envRecipientMm',
  'envSenderX', 'envSenderY', 'envRecipientX', 'envRecipientY', 'envSpacingMm', 'envMargin',
  'cardMessage', 'cardFont', 'cardSizeMm', 'cardLineMm', 'cardAlign', 'cardX', 'cardY',
  'cardSpacingMm', 'cardMargin', 'cardArt', 'cardArtMm', 'cardArtWhere', 'cardArtGap',
];

function jobSnapshot(mode, o, label) {
  const fields = {};
  for (const k of JOB_KEYS) if (o[k] !== undefined) fields[k] = o[k];
  fields.writeMode = mode;
  return { name: `${mode === 'envelope' ? 'Envelope' : 'Card'}: ${label || '(blank)'}`.slice(0, 60), mode, fields };
}

function saveJob(job) {
  const jobs = (store.get('jobs') || []).filter((j) => j.name !== job.name);
  jobs.unshift({ id: Date.now().toString(36), at: new Date().toISOString(), ...job });
  store.set('jobs', jobs.slice(0, 20));
  return store.get('jobs');
}

function buildWritten(mode, opts) {
  const o = writtenOptions(opts, mode);
  if (mode === 'envelope') return buildEnvelopes(o);
  return buildCard(o);
}

// ---- envelopes: one, or a stack of them with a pause between
function buildEnvelopes(o) {
  const spacingMm = Number(o.envSpacingMm) || 0;
  const list = CARD.splitRecipients(o.envRecipient);
  const items = list.length ? list : [''];
  const laid = items.map((recipient) => CARD.envelope({
    sender: o.envSender, recipient,
    font: o.envFont || 'EMSReadability',
    senderMm: Number(o.envSenderMm) || 3.5,
    recipientMm: Number(o.envRecipientMm) || 5,
    senderX: Number(o.envSenderX) || 0, senderY: Number(o.envSenderY) || 0,
    recipientX: Number(o.envRecipientX) || 0, recipientY: Number(o.envRecipientY) || 0,
    spacingMm,
    paperW: o.paperW, paperH: o.paperH, margin: o.margin,
    fitW: o.availW, fitH: o.availH,
  }));
  if (!laid.some((e) => e.paths.length)) throw new Error('nothing to write yet');
  const results = laid.map((e) => (e.paths.length ? composeText(null, e.paths, o) : null));
  const n = results.length;
  const show = Math.min(Math.max(0, Number(o.stackIndex) || 0), n - 1);
  const r = results[show] || results.find(Boolean);

  let stats = r.stats;
  let gcode, name;
  if (n > 1) {
    // The stats describe the whole stack; the preview shows one sheet of it.
    const sum = { paths: 0, lifts: 0, drawLen: 0, travelLen: 0, seconds: 0, overflow: false };
    for (const x of results) {
      if (!x) continue;
      sum.paths += x.stats.paths; sum.lifts += x.stats.lifts;
      sum.drawLen += x.stats.drawLen; sum.travelLen += x.stats.travelLen;
      sum.seconds += x.stats.seconds; sum.overflow = sum.overflow || x.stats.overflow;
    }
    stats = { ...r.stats, ...sum, time: fmtTime(sum.seconds), sheets: n };
    gcode = toGcodeStack(
      results.map((x, i) => ({ paths: x ? x.paths : [], label: firstLine(items[i]) })),
      r.options, { name: `${n} envelopes`, time: stats.time });
    name = 'envelopes.gcode';
  } else {
    gcode = toGcode(r.paths, r.options, { name: 'envelope', time: stats.time });
    name = 'envelope.gcode';
  }
  const label = n > 1 ? `${n} envelopes, ${firstLine(items[0])}` : (firstLine(items[0]) || firstLine(o.envSender));
  lastJob = { ...r, stats, gcode, file: null, name, job: jobSnapshot('envelope', o, label) };
  const e = laid[show];
  const text = { mode: 'envelope', sender: e.sender, recipient: e.recipient, stack: n, index: show };
  const blocks = [blockOf('sender', e.sender), blockOf('recipient', e.recipient)].filter(Boolean);
  return writtenPayload(r, stats, text, blocks, name);
}

// ---- a card: a centred message, with a drawing above or below it if asked
function cardArtFor(file, o) {
  const mm = Math.max(1, Number(o.cardArtMm) || 30);
  // Fit the drawing into an mm x mm box of its own: the sheet-fitting code
  // then does the scaling, with no margin and no rotation.
  const base = { ...o, fit: 'fit', autoRotate: false, margin: 0, paperW: mm, paperH: mm, keepLayers: false, traceMulticolour: false };
  let r;
  if (isRaster(file)) {
    const t = traceFor(file, base);
    r = buildLayers([{ name: 'art', paths: t.paths }], base);
  } else {
    r = build(fs.readFileSync(file, 'utf8'), base);
  }
  return { paths: r.paths, w: r.stats.width, h: r.stats.height, pathCount: r.paths.length };
}

function buildCard(o) {
  const cardX = Number(o.cardX) || 0, cardY = Number(o.cardY) || 0;
  let art = null;
  if (o.cardArt) {
    try {
      art = cardArtFor(o.cardArt, o);
    } catch (e) {
      throw new Error(`the drawing could not be used: ${e.message}`);
    }
  }
  const gap = art ? Math.max(0, Number(o.cardArtGap) || 0) : 0;
  const reserve = art ? art.h + gap : 0;
  const textOpts = {
    message: o.cardMessage,
    font: o.cardFont || 'EMSReadability',
    sizeMm: Number(o.cardSizeMm) || 5,
    lineMm: Number(o.cardLineMm) || 0,
    align: o.cardAlign || 'centre',
    spacingMm: Number(o.cardSpacingMm) || 0,
    x: cardX, y: cardY,
    fitW: o.availW, fitH: Math.max(1, o.availH - reserve),
  };
  let c = CARD.card(textOpts);
  if (!c.paths.length && !art) throw new Error('nothing to write yet');

  // Y-down offsets of the two middles from (cardX, cardY), so the pair is
  // centred as a group: drawing, gap, message.
  let artMid = 0;
  if (art && c.paths.length) {
    const th = c.info.height;
    const total = art.h + gap + th;
    const above = o.cardArtWhere !== 'below';
    const textMid = above ? total / 2 - th / 2 : -total / 2 + th / 2;
    artMid = above ? -total / 2 + art.h / 2 : total / 2 - art.h / 2;
    c = CARD.card({ ...textOpts, y: cardY + textMid });
  }
  // The drawing joins the text in Y-down space and the two are composed and
  // ordered together, exactly like text on artwork.
  let artBox = null;
  const paths = c.paths.slice();
  if (art) {
    const down = art.paths.map((p) => p.map((q) => [q[0] + cardX, -q[1] + cardY + artMid]));
    paths.push(...down);
    artBox = { id: 'art', x0: cardX - art.w / 2, x1: cardX + art.w / 2, y0: -(cardY + artMid) - art.h / 2, y1: -(cardY + artMid) + art.h / 2 };
  }
  const r = composeText(null, paths, o);
  const gcode = toGcode(r.paths, r.options, { name: 'card', time: r.stats.time });
  const label = firstLine(o.cardMessage) || (art ? path.basename(o.cardArt) : '');
  lastJob = { ...r, gcode, file: null, name: 'card.gcode', job: jobSnapshot('card', o, label) };
  const text = {
    mode: 'card',
    message: c.info,
    art: art ? { file: path.basename(o.cardArt), w: art.w, h: art.h, paths: art.pathCount } : null,
  };
  const blocks = [blockOf('message', c.info), artBox].filter(Boolean);
  return writtenPayload(r, r.stats, text, blocks, 'card.gcode');
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

  // Recent envelopes and cards. One is saved whenever one is sent, or on
  // request; picking one back puts its fields on the Write card.
  ipcMain.handle('jobs:list', guard(async () => store.get('jobs') || []));
  ipcMain.handle('jobs:save', guard(async () => {
    if (!lastJob || !lastJob.job) throw new Error('write something first');
    return saveJob(lastJob.job);
  }));
  ipcMain.handle('jobs:forget', guard(async (id) => {
    store.set('jobs', (store.get('jobs') || []).filter((j) => j.id !== id));
    return store.get('jobs');
  }));

  // ---------------------------------------------------------------- build
  ipcMain.handle('plot:build', guard(async (file, settings) => {
    // Take the live lift and feeds off the machine when it is reachable, so
    // the estimate matches reality instead of a stale config on this laptop.
    const live = machine.last;
    const opts = {
      ...settings,
      lift: live?.lift ?? 10,
      zUpFeed: live?.zUpFeed ?? 1800,
      zDownFeed: live?.zDownFeed ?? 900,
    };

    // An envelope or a card is all text with a fixed place for it, so it
    // never touches the artwork path: no file, no trace, no fit.
    if (settings && (settings.mode === 'envelope' || settings.mode === 'card')) {
      return buildWritten(settings.mode, opts);
    }

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
      trackingMm: Number(settings.textSpacingMm) || 0,
    };
    if (!file && !wantText) throw new Error('choose some artwork, or turn on text');

    let r, trace = null;
    if (!file) {
      r = null;
    } else if (isRaster(file) && opts.traceMulticolour) {
      // One layer per pen. keepLayers has to stay on here or the colours would
      // be flattened into a single pass and the pen changes would be lost.
      const c = colourTraceFor(file, opts);
      trace = c.stats;
      r = buildLayers(c.layers, { ...opts, keepLayers: true });
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

    let text = null, blocks = [];
    if (wantText) {
      const paths = SF.layout(settings.textMessage, textOpts);
      const m = SF.measure(settings.textMessage, textOpts);
      r = composeText(r, paths, opts);
      if (m.paths) blocks = [{ id: 'text', x0: m.x0, x1: m.x1, y0: -m.y1, y1: -m.y0 }];
      text = {
        font: textOpts.font,
        paths: paths.length,
        width: m.width,
        height: m.height,
        lines: m.lines,
        sizeMm: textOpts.sizeMm,
        lineMm: m.lead,
        missing: SF.loadFont(textOpts.font).unsupported(settings.textMessage),
      };
    }
    if (!r) throw new Error('nothing to plot');
    const label = file ? path.basename(file) : 'text';
    const gcode = toGcode(r.paths, r.options, { name: label, time: r.stats.time, runs: r.stats.runs });
    lastJob = { ...r, gcode, file, name: safeName(file || 'message.svg') };
    if (file) store.set('lastFile', file);
    return {
      stats: r.stats,
      trace,
      text,
      blocks,
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
    if (lastJob.job) saveJob(lastJob.job);
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
        // A script file to run in the page before the capture, for driving a
        // tab into a state worth looking at (type a message, pick a mode).
        if (process.env.PLOTTER_SMOKE_JS) {
          await win.webContents.executeJavaScript(fs.readFileSync(process.env.PLOTTER_SMOKE_JS, 'utf8'));
          await new Promise((r) => setTimeout(r, 1200));
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
