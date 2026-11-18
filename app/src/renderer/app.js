'use strict';
const API = window.plotter;
const $ = (id) => document.getElementById(id);

const ui = {
  file: null,
  built: null,
  zStep: 0.1,
  zStep2: 1,
  xyStep: 1,
  settings: {},
  status: null,
  open: 1,
  busy: false,
  masks: [],
  masking: false,
  sending: false,
  tab: 'plot',      // 'plot' | 'card' | 'machine' | 'settings'
  builtFor: null,   // which of plot / card ui.built was made for
  sentSeconds: 0,   // estimate of the job that was actually sent, for the run bar
  wasOverflow: false,
  grid: false,      // 10 mm grid on the preview
  cardArt: null,    // a drawing to go with a card's message
  stackIndex: 0,    // which envelope of a stack the preview shows
  jobs: [],         // recent envelopes and cards
  isEnvChange: false,
};

// Which X / Y fields a dragged preview block writes to.
const BLOCK_FIELDS = {
  text: ['textX', 'textY'],
  message: ['cardX', 'cardY'],
  art: ['cardX', 'cardY'],
  sender: ['envSenderX', 'envSenderY'],
  recipient: ['envRecipientX', 'envRecipientY'],
};

// Step 3 is the one card that differs between the Plot and Card tabs.
const step3 = () => (ui.tab === 'card' ? 'W' : 3);
const writeMode = () => {
  const on = $('writeMode').querySelector('.sg.on');
  return on ? on.dataset.v : 'envelope';
};

// ------------------------------------------------------------------ toasts
function toast(msg, kind = '', title = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = (title ? `<b></b>` : '') + '<span></span>';
  if (title) el.querySelector('b').textContent = title;
  el.querySelector('span').textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, kind === 'err' ? 9000 : 4200);
}

// Every IPC call comes back as { ok, value | error }. This unwraps it and
// surfaces the failure instead of letting it vanish.
async function call(promise, what) {
  ui.busy = true;
  try {
    const r = await promise;
    if (!r || !r.ok) {
      toast(r ? r.error : 'no response', 'err', what || 'Failed');
      return null;
    }
    return r.value;
  } finally {
    ui.busy = false;
  }
}

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '--');
const metres = (mm) => (mm >= 1000 ? (mm / 1000).toFixed(2) + ' m' : Math.round(mm) + ' mm');

// ------------------------------------------------------------------ status
function paint(s) {
  ui.status = s;
  const dot = $('connDot');
  if (!s || !s.online) {
    dot.className = 'dot bad';
    $('connName').textContent = 'not connected';
    $('connState').textContent = s && s.error ? '· ' + s.error.slice(0, 60) : '';
    $('posX').textContent = $('posY').textContent = $('posZ').textContent = '--';
    setAlert('Not connected', (s && s.error) || 'Check the address in Settings.');
    return;
  }
  const ready = s.klipper === 'ready';
  dot.className = 'dot ' + (ready ? (s.printing ? 'warn' : 'ok') : 'bad');
  $('connName').textContent = (ui.settings.host || 'plotter');
  $('connState').textContent = '· ' + (s.printing ? (s.paused ? 'paused' : 'plotting') : s.klipper);

  $('posX').textContent = fmt(s.x);
  $('posY').textContent = fmt(s.y);
  $('posZ').textContent = fmt(s.z, 2);

  // ---- step 1
  $('zPos').textContent = s.homedZ ? fmt(s.z, 2) : 'no ref';
  $('zFloat').textContent = fmt(s.maxFloat, 1);
  $('zLift').textContent = fmt(s.lift, 1);
  card(1, s.zeroed, s.zeroed ? `Z0 locked` : 'not set');
  // With Z0 locked the only way to set a lower writing height is to release it,
  // so this button becomes that action rather than going dead.
  $('zRoom').textContent = s.zeroed ? 'Unlock Z0 to go lower' : 'Give Z room';
  // A paused plot is still "printing", but a pen change is exactly when the
  // writing height HAS to be set again: the new pen is a different length.
  // Gate the Z controls on actually moving, not on having a job loaded.
  const midPlot = s.printing && !s.paused;
  $('zRoom').disabled = midPlot;

  // ---- step 2
  $('mx').textContent = fmt(s.x);
  $('my').textContent = fmt(s.y);
  updateCentrePreview();
  // Both halves have to be true. Homing wipes the origin but leaves the paper
  // size behind, which used to show a green tick over an origin that was gone.
  const hasPaper = s.paperW > 0 && s.paperH > 0 && s.hasOrigin;
  card(2, hasPaper, hasPaper
    ? `${fmt(s.paperW)}×${fmt(s.paperH)} @ ${fmt(s.originX)},${fmt(s.originY)}`
    : (s.paperW > 0 && !s.hasOrigin ? 'origin cleared' : 'not set'));

  // ---- machine tab
  $('mState').textContent = s.klipper;
  $('mHomed').textContent = s.homedAxes ? s.homedAxes.toUpperCase() : 'none';
  $('mOrigin').textContent = `${fmt(s.originX)}, ${fmt(s.originY)}`;
  $('mPaper').textContent = hasPaper ? `${fmt(s.paperW)}×${fmt(s.paperH)}` : 'unset';
  document.querySelectorAll('[data-zjog2]').forEach((x) => { x.disabled = !s.homedZ || midPlot; });

  // ---- motion buttons need X/Y homed
  document.querySelectorAll('[data-jog]').forEach((b) => { b.disabled = !s.homedXY || s.printing; });
  document.querySelectorAll('[data-zjog]').forEach((b) => { b.disabled = !s.homedZ || midPlot; });
  $('penUp').disabled = $('penDown').disabled = !s.zeroed || midPlot;
  $('lockZ').disabled = !s.homedZ || midPlot;
  $('setCorner').disabled = !s.homedXY || s.printing;
  $('homeBtn').disabled = s.printing;
  $('mHome').disabled = s.printing;
  $('mPenTest').disabled = !s.zeroed || s.printing;

  // ---- pen change
  // Only the machine knows which pen it stopped for, so the prompt is read
  // back from what PEN_CHANGE actually said rather than guessed from progress.
  // Not every pause is a pen change: someone hitting Pause should not be told
  // to swap pens. PEN_CHANGE is the only thing that unzeroes mid-plot, so an
  // unzeroed pause is one for certain, and the console confirms it by name -
  // which is what keeps the panel up after Z0 is locked again.
  const penChange = s.paused && (!s.zeroed || ui.isPenChange === true);
  // A stack of envelopes pauses with the pen still zeroed; the console line
  // names it, and the prompt is only to load the next sheet.
  const envChange = s.paused && s.zeroed && !penChange && ui.isEnvChange === true;
  $('penChange').classList.toggle('hide', !penChange);
  $('envChange').classList.toggle('hide', !envChange);
  if (s.paused) {
    if (!ui.penChangeAsked) { ui.penChangeAsked = true; readPenChange(); }
    $('pcZeroed').textContent = s.zeroed
      ? 'Z0 is locked - ready to continue'
      : 'Z0 is NOT set - the pen cannot draw yet';
    $('pcZeroed').className = 'pcstate ' + (s.zeroed ? 'ok' : 'warn');
    $('pcResume').disabled = !s.zeroed;
    $('pcLock').disabled = !s.homedZ;
  } else {
    ui.penChangeAsked = false;
    ui.isPenChange = false;
    ui.isEnvChange = false;
  }

  // ---- run bar
  const running = s.printing;
  $('runbar').classList.toggle('hide', !running);
  if (running) {
    const pct = Math.max(0, Math.min(1, s.progress));
    $('runFill').style.width = (pct * 100).toFixed(1) + '%';
    $('runPct').textContent = Math.round(pct * 100) + '%';
    $('runTitle').textContent = s.paused ? 'Paused' : 'Plotting';
    $('pauseBtn').textContent = s.paused ? 'Resume' : 'Pause';
    const est = ui.sentSeconds || (ui.built ? ui.built.stats.seconds : 0);
    const left = est && pct > 0 ? est * (1 - pct) : 0;
    $('runEta').textContent = (s.printFile || '') + (left ? ` · ${mmss(left)} left` : '');
  }
  $('sendPlot').disabled = running || !ui.built || ui.sending;
  const dry = $('togDry').classList.contains('on');
  $('sendLabel').textContent = dry ? 'Send dry run' : 'Send plot';

  // ---- banners
  refreshBanners(s);
}

function mmss(sec) {
  const t = Math.round(sec);
  const m = Math.floor(t / 60);
  return `${m}m ${String(t % 60).padStart(2, '0')}s`;
}

function card(n, done, label) {
  const el = $('card' + n);
  el.classList.toggle('done', !!done);
  $('num' + n).textContent = done ? '✓' : String(n);
  $('val' + n).textContent = label;
}

function setAlert(title, text) {
  if (!text) { $('alertBanner').classList.add('hide'); return; }
  $('alertTitle').textContent = title;
  $('alertText').textContent = text;
  $('alertBanner').classList.remove('hide');
}

let savedCorner = null;
function refreshBanners(s) {
  // A restart wipes the origin, the paper size and the Z reference. If a
  // corner was saved and the machine has forgotten it, offer it back.
  const forgot = savedCorner && !(s.paperW > 0 && s.paperH > 0 && s.hasOrigin);
  $('restoreBanner').classList.toggle('hide', !forgot);
  if (forgot) {
    $('restoreText').textContent =
      `Last corner X${fmt(savedCorner.x)} Y${fmt(savedCorner.y)}, card ${fmt(savedCorner.w)} × ${fmt(savedCorner.h)}. `
      + 'Re-home first, then restore. The writing height has to be set by hand again.';
  }

  if (s.klipper !== 'ready') {
    setAlert('Klipper is not ready', s.klipperMessage ? s.klipperMessage.split('\n')[0] : s.klipper);
  } else if (!s.homedXY) {
    setAlert('Not homed', 'Home X and Y before setting a corner. After homing the carriage parks off the plate, so it moves back over the bed on its own.');
  } else {
    setAlert('', '');
  }
}

function updateCentrePreview() {
  const s = ui.status;
  if (!s) return;
  const w = parseFloat($('paperW').value) || 0;
  const h = parseFloat($('paperH').value) || 0;
  const which = $('cornerWhich').value;
  const middle = which === 'centre';
  $('cornerWord').textContent = middle ? 'centre' : which + ' corner';
  $('setCornerLabel').textContent = middle
    ? 'Set origin from the centre'
    : 'Set origin from this corner';
  if (!(w > 0 && h > 0) || !s.homedXY) { $('mc').textContent = '--'; return; }
  // At the centre the pen already IS the origin, so the measured size only
  // records the sheet dimensions.
  const sx = middle ? 0 : (which.includes('right') ? -1 : 1);
  const sy = middle ? 0 : (which.includes('top') ? -1 : 1);
  $('mc').textContent = `${fmt(s.x + (sx * w) / 2)} · ${fmt(s.y + (sy * h) / 2)}`;
}

// ------------------------------------------------------------- blank areas
// Masks live as fractions of the SOURCE image, so they survive a resolution
// change and mean the same thing whatever the card size. The preview shows
// paper space, so both directions of the mapping are needed: stats.map is the
// fit and rotate that build() applied, and the preview's own viewBox is paper
// space with Y flipped back down.
function imgToSvg(fx, fy, res) {
  const m = res.stats.map, t = res.trace;
  const ix = fx * t.widthMm, iy = fy * t.heightMm;
  const rx = m.rotated ? iy : ix;
  const ry = m.rotated ? -ix : iy;
  return [(rx - m.cx) * m.scale, (ry - m.cy) * m.scale];
}

function svgToImg(sx, sy, res) {
  const m = res.stats.map, t = res.trace;
  const rx = sx / m.scale + m.cx, ry = sy / m.scale + m.cy;
  const ix = m.rotated ? -ry : rx;
  const iy = m.rotated ? rx : ry;
  return [ix / t.widthMm, iy / t.heightMm];
}

function maskRectSvg(mk, res) {
  const c = [imgToSvg(mk.x, mk.y, res), imgToSvg(mk.x + mk.w, mk.y, res),
             imgToSvg(mk.x, mk.y + mk.h, res), imgToSvg(mk.x + mk.w, mk.y + mk.h, res)];
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Screen pixels -> the preview's own user units.
function svgPoint(evt) {
  const svg = $('pv');
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const p = svg.createSVGPoint();
  p.x = evt.clientX; p.y = evt.clientY;
  const q = p.matrixTransform(ctm.inverse());
  return [q.x, q.y];
}

function wireMasks() {
  const svg = $('pv');
  let drag = null;
  // Dragging a text block: the handle follows the pointer and the block's X
  // and Y fields follow the handle, then the plot is rebuilt on release. The
  // preview's units are millimetres with Y down, the same as the fields.
  let bdrag = null;
  svg.addEventListener('mousedown', (e) => {
    if (ui.masking || !ui.built) return;
    const el = e.target && e.target.closest ? e.target.closest('.blk') : null;
    if (!el) return;
    const f = BLOCK_FIELDS[el.dataset.id];
    const p = svgPoint(e);
    if (!f || !p) return;
    bdrag = { el, x0: p[0], y0: p[1], f, vx: parseFloat($(f[0]).value) || 0, vy: parseFloat($(f[1]).value) || 0 };
    el.classList.add('dragging');
    e.preventDefault();
  });
  svg.addEventListener('mousedown', (e) => {
    if (!ui.masking || !ui.built || !ui.built.trace) return;
    const p = svgPoint(e);
    if (!p) return;
    drag = { x0: p[0], y0: p[1], x1: p[0], y1: p[1] };
    e.preventDefault();
  });
  svg.addEventListener('mousemove', (e) => {
    if (bdrag) {
      const p = svgPoint(e);
      if (!p) return;
      const dx = p[0] - bdrag.x0, dy = p[1] - bdrag.y0;
      bdrag.el.setAttribute('transform', `translate(${dx} ${dy})`);
      $(bdrag.f[0]).value = (bdrag.vx + dx).toFixed(1);
      $(bdrag.f[1]).value = (bdrag.vy + dy).toFixed(1);
      return;
    }
    if (!drag) return;
    const p = svgPoint(e);
    if (!p) return;
    drag.x1 = p[0]; drag.y1 = p[1];
    const r = $('pvDrag');
    if (r) {
      r.setAttribute('x', Math.min(drag.x0, drag.x1));
      r.setAttribute('y', Math.min(drag.y0, drag.y1));
      r.setAttribute('width', Math.abs(drag.x1 - drag.x0));
      r.setAttribute('height', Math.abs(drag.y1 - drag.y0));
    }
  });
  window.addEventListener('mouseup', () => {
    if (bdrag) {
      bdrag.el.classList.remove('dragging');
      bdrag = null;
      rebuild();
      return;
    }
    if (!drag) return;
    const d = drag; drag = null;
    if (Math.abs(d.x1 - d.x0) < 1 || Math.abs(d.y1 - d.y0) < 1) { drawPreview(ui.built); return; }
    const a = svgToImg(d.x0, d.y0, ui.built);
    const b = svgToImg(d.x1, d.y1, ui.built);
    const x = Math.max(0, Math.min(a[0], b[0])), y = Math.max(0, Math.min(a[1], b[1]));
    const w = Math.min(1 - x, Math.abs(b[0] - a[0])), h = Math.min(1 - y, Math.abs(b[1] - a[1]));
    if (w > 0.002 && h > 0.002) ui.masks.push({ x, y, w, h });
    setMasking(false);
    rebuild();
  });
}

function setMasking(on) {
  ui.masking = on;
  $('maskAdd').classList.toggle('act', on);
  $('maskAdd').textContent = on ? 'Drag over the area' : 'Blank an area';
  $('pv').classList.toggle('masking', on);
}

// ------------------------------------------------------------------ preview
function drawPreview(res) {
  const svg = $('pv');
  if (!res) {
    svg.classList.add('hide');
    $('pvEmpty').classList.remove('hide');
    ['sPaths', 'sDraw', 'sTravel', 'sLifts', 'sTime'].forEach((k) => { $(k).textContent = '--'; });
    $('val3').textContent = 'no artwork';
    $('valW').textContent = 'nothing yet';
    return;
  }
  const { preview, paper, stats } = res;
  const w = paper.w, h = paper.h, m = paper.margin;
  const d = preview.draw.map((p) => 'M' + p.map((q) => `${q[0]} ${q[1]}`).join('L')).join('');
  const t = preview.travel.map((s) => `M${s[0]} ${s[1]}L${s[2]} ${s[3]}`).join('');
  // A 10 mm grid out from the sheet centre, which is where every coordinate
  // in the app is measured from.
  let grid = '';
  if (ui.grid) {
    let g = '';
    for (let x = 10; x < w / 2; x += 10) g += `M${x} ${-h / 2}V${h / 2}M${-x} ${-h / 2}V${h / 2}`;
    for (let y = 10; y < h / 2; y += 10) g += `M${-w / 2} ${y}H${w / 2}M${-w / 2} ${-y}H${w / 2}`;
    grid = `<path class="grid" d="${g}"/><path class="axis" d="M0 ${-h / 2}V${h / 2}M${-w / 2} 0H${w / 2}"/>`;
  }
  // Each text block gets a handle over its ink, in SVG space (Y down), so it
  // can be dragged. Its id says which X / Y fields it moves.
  const blocks = (res.blocks || []).map((b) =>
    `<rect class="blk" data-id="${b.id}" x="${b.x0}" y="${-b.y1}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}"/>`).join('');
  // Paper space has Y up; the flip puts it into SVG's Y-down viewBox.
  svg.setAttribute('viewBox', `${-w / 2} ${-h / 2} ${w} ${h}`);
  svg.innerHTML =
    `<rect class="sheet" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}"/>`
    + `<g transform="scale(1,-1)">`
    + grid
    + `<rect class="marginbox${stats.overflow ? ' over' : ''}" x="${-w / 2 + m}" y="${-h / 2 + m}" width="${w - 2 * m}" height="${h - 2 * m}"/>`
    + `<path class="tv" d="${t}"/><path class="dr" d="${d}"/>`
    + `</g>`
    + blocks
    + (res.trace && res.stats.map
      ? ui.masks.map((mk) => {
          const r = maskRectSvg(mk, res);
          return `<rect class="mask" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`;
        }).join('')
      : '')
    + `<rect id="pvDrag" class="mask drag" x="0" y="0" width="0" height="0"/>`;
  svg.classList.remove('hide');
  $('pvEmpty').classList.add('hide');

  $('sPaths').textContent = stats.paths;
  $('sDraw').textContent = metres(stats.drawLen);
  $('sTravel').textContent = metres(stats.travelLen);
  $('sLifts').textContent = stats.lifts;
  $('sTime').textContent = stats.time;
  $('val' + step3()).textContent = stats.overflow ? 'will not fit'
    : (stats.sheets > 1 ? `${stats.sheets} envelopes, ${stats.time}` : stats.time);
}

// The fit warning is a standing state (the margin box turns red and step 3
// says so), and the toast fires once when it starts, not on every keystroke.
function overflowToast(res, msg) {
  const over = !!(res && res.stats.overflow);
  if (over && !ui.wasOverflow) toast(msg, 'err', 'It will not fit');
  ui.wasOverflow = over;
}

function currentSettings() {
  return {
    paperW: parseFloat($('paperW').value) || 150,
    paperH: parseFloat($('paperH').value) || 100,
    margin: parseFloat($('margin').value) || 0,
    minLen: parseFloat($('minLen').value) || 0,
    drawFeed: parseFloat($('drawFeed').value) || 3000,
    travelFeed: parseFloat($('travelFeed').value) || 9000,
    simplify: parseFloat($('simplify').value) || 0,
    mergeTol: parseFloat($('mergeTol').value) || 0,
    fit: $('togFit').classList.contains('on') ? 'fit' : 'actual',
    autoRotate: $('togRotate').classList.contains('on'),
    keepLayers: $('togLayers').classList.contains('on'),
    dryRun: $('togDry').classList.contains('on'),
    corner: $('cornerWhich').value,
    // tracing: ignored outright when the artwork is an SVG
    traceThreshold: parseFloat($('traceThreshold').value) || 0,
    traceFillWidth: parseFloat($('traceFillWidth').value) || 0.9,
    tracePen: parseFloat($('tracePen').value) || 0.3,
    traceOutline: $('togOutline').classList.contains('on'),
    traceMulticolour: $('togMulti').classList.contains('on'),
    traceColours: parseInt($('traceColours').value, 10) || 4,
    traceFills: $('togFills').classList.contains('on'),
    traceHatch: $('togHatch').classList.contains('on'),
    // single-stroke text
    textOn: $('togText').classList.contains('on'),
    textMessage: $('textMessage').value,
    textFont: $('textFont').value || 'EMSReadability',
    textSizeMm: parseFloat($('textSizeMm').value) || 5,
    textLineMm: parseFloat($('textLineMm').value) || 0,
    textAlign: $('textAlign').value || 'centre',
    textX: parseFloat($('textX').value) || 0,
    textY: parseFloat($('textY').value) || 0,
    textSpacingMm: parseFloat($('textSpacingMm').value) || 0,
    showGrid: ui.grid,
    masks: ui.masks,
    // the Card tab. mode tells the build which path to take; only the active
    // tab's mode is sent, so the Plot tab never builds an envelope.
    mode: ui.tab === 'card' ? writeMode() : 'art',
    writeMode: writeMode(),
    envMargin: parseFloat($('writeMarginEnv').value) || 0,
    cardMargin: parseFloat($('writeMarginCard').value) || 0,
    envSender: $('envSender').value,
    envRecipient: $('envRecipient').value,
    envFont: $('envFont').value || 'EMSReadability',
    envSenderMm: parseFloat($('envSenderMm').value) || 3.5,
    envRecipientMm: parseFloat($('envRecipientMm').value) || 5,
    envRecipientX: parseFloat($('envRecipientX').value) || 0,
    envRecipientY: parseFloat($('envRecipientY').value) || 0,
    envSenderX: parseFloat($('envSenderX').value) || 0,
    envSenderY: parseFloat($('envSenderY').value) || 0,
    envSpacingMm: parseFloat($('envSpacingMm').value) || 0,
    stackIndex: ui.stackIndex,
    cardMessage: $('cardMessage').value,
    cardFont: $('cardFont').value || 'EMSReadability',
    cardSizeMm: parseFloat($('cardSizeMm').value) || 5,
    cardLineMm: parseFloat($('cardLineMm').value) || 0,
    cardAlign: $('cardAlign').value || 'centre',
    cardX: parseFloat($('cardX').value) || 0,
    cardY: parseFloat($('cardY').value) || 0,
    cardSpacingMm: parseFloat($('cardSpacingMm').value) || 0,
    cardArt: ui.cardArt,
    cardArtMm: parseFloat($('cardArtMm').value) || 30,
    cardArtWhere: $('cardArtWhere').value || 'above',
    cardArtGap: parseFloat($('cardArtGap').value) || 0,
  };
}

const blockInfo = (b) => {
  if (!b) return 'nothing yet';
  let s = `${b.lines} line${b.lines === 1 ? '' : 's'}, ${b.width.toFixed(1)} x ${b.height.toFixed(1)} mm, ${b.paths} strokes`;
  if (b.fitted) s += ` - shrunk to ${b.sizeMm.toFixed(1)} mm caps to fit`;
  if (b.missing && b.missing.length) s += ` - cannot draw ${b.missing.map((c) => JSON.stringify(c)).join(' ')}`;
  return s;
};

let buildTimer = null;
function rebuildSoon(delay = 260) {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(rebuild, delay);
}

async function rebuild() {
  const s = currentSettings();
  API.setSettings(s);
  ui.settings = { ...ui.settings, ...s };
  ui.builtFor = ui.tab === 'card' ? 'card' : 'plot';
  if (s.mode !== 'art') return rebuildWritten(s);
  // Text alone is a perfectly good plot, so artwork is not required.
  const hasText = s.textOn && String(s.textMessage || '').trim();
  if (!ui.file && !hasText) { drawPreview(null); ui.built = null; ui.wasOverflow = false; return; }
  const res = await call(API.buildPlot(ui.file, s), 'Could not build that artwork');
  ui.built = res;
  drawPreview(res);
  if (res && res.text) {
    const t = res.text;
    $('textInfo').textContent =
      `${t.lines} line${t.lines === 1 ? '' : 's'}, ${t.width.toFixed(1)} x ${t.height.toFixed(1)} mm`
      + `, ${t.paths} strokes, ${t.lineMm.toFixed(1)} mm line pitch`
      + (t.missing && t.missing.length ? ` - cannot draw ${t.missing.map((c) => JSON.stringify(c)).join(' ')}` : '');
  } else if ($('togText').classList.contains('on')) {
    $('textInfo').textContent = 'nothing to write yet';
  }
  if (res && res.trace) {
    const t = res.trace;
    if (t.mode === 'colour') {
      // Built as nodes, not an HTML string: the page's CSP forbids inline
      // style attributes, so the swatch colour has to be set through the CSSOM
      // or every dot comes out blank.
      const box = $('swatches');
      box.innerHTML = '';
      t.swatches.forEach((s2, i) => {
        const el = document.createElement('span');
        el.className = 'swatch';
        const dot = document.createElement('i');
        dot.style.background = s2.hex;
        const nm = document.createElement('b');
        nm.textContent = `${i + 1}. ${s2.name}`;
        const ct = document.createElement('small');
        ct.textContent = s2.paths;
        el.append(dot, nm, ct);
        el.title = `${s2.hex} - ${s2.paths} paths`;
        box.appendChild(el);
      });
      $('traceInfo').textContent =
        `${t.sourceWidth}x${t.sourceHeight}, ${t.colours} pens, ${res.stats.paths} paths`
        + `, ${t.colours - 1} pen change${t.colours === 2 ? '' : 's'}`;
    } else
    $('traceInfo').textContent = t.mode === 'outline'
      ? `${t.sourceWidth}x${t.sourceHeight}, threshold ${t.threshold}, ink ${t.inkPercent.toFixed(1)}%, ${res.stats.paths} outlines`
      : `${t.sourceWidth}x${t.sourceHeight} at ${t.upscale}x, threshold ${t.threshold}`
        + `, ink ${t.inkPercent.toFixed(1)}%, fills ${t.filledPercent.toFixed(1)}% of it`
        + `, ${res.stats.paths} strokes`;
  }
  overflowToast(res, 'The artwork is larger than the card minus the margin. Turn on "Fit to the card" or increase the margin.');
  if (res && !res.stats.overflow && res.stats.rotated) {
    toast('Rotated 90° to fill the card better. Turn off Auto-rotate to keep the original orientation.', '', 'Auto-rotated');
  }
  if (ui.status) paint(ui.status);
}

// The Card tab: an envelope or a card, with no artwork involved at all.
async function rebuildWritten(s) {
  const has = s.mode === 'envelope'
    ? (s.envSender.trim() || s.envRecipient.trim())
    : (s.cardMessage.trim() || s.cardArt);
  if (!has) {
    drawPreview(null); ui.built = null; ui.wasOverflow = false;
    ['envSenderInfo', 'envRecipientInfo', 'cardInfo'].forEach((id) => { $(id).textContent = 'nothing yet'; });
    $('stackNav').classList.add('hide');
    if (ui.status) paint(ui.status);
    return;
  }
  const res = await call(API.buildPlot(null, s), 'Could not lay that out');
  ui.built = res;
  drawPreview(res);
  if (res && res.text) {
    const t = res.text;
    if (t.mode === 'envelope') {
      $('envSenderInfo').textContent = blockInfo(t.sender);
      $('envRecipientInfo').textContent = blockInfo(t.recipient);
      const stack = t.stack > 1;
      $('stackNav').classList.toggle('hide', !stack);
      ui.stackIndex = t.index || 0;
      if (stack) $('stackPos').textContent = `${t.index + 1} / ${t.stack}`;
    } else {
      $('cardInfo').textContent = blockInfo(t.message) + (t.message ? `, ${t.message.lineMm.toFixed(1)} mm line pitch` : '');
      $('cardArtInfo').textContent = t.art
        ? `${t.art.file}: ${t.art.w.toFixed(1)} x ${t.art.h.toFixed(1)} mm, ${t.art.paths} paths`
        : 'none; the message stands alone';
    }
  }
  overflowToast(res, 'The writing reaches past the margin. Use smaller capitals, fewer lines, or a smaller margin.');
  if (ui.status) paint(ui.status);
}

// ------------------------------------------------------------------ wiring
function openCard(n) {
  ui.open = n;
  [1, 2, 3, 'W'].forEach((i) => $('card' + i).classList.toggle('open', i === n));
}

// Steps 1 and 2 and the banners are one set of elements that live in
// whichever of the Plot and Card tabs is showing, and so is the Dry run /
// Send block at the foot of step 3. Moving them keeps one id for each
// control, so every handler above works unchanged on either tab.
function placeShared(tab) {
  const host = $('tab-' + (tab === 'card' ? 'card' : 'plot'));
  host.prepend($('penChange'), $('envChange'), $('restoreBanner'), $('alertBanner'), $('card1'), $('card2'));
  const foot = $(tab === 'card' ? 'cardW' : 'card3').querySelector('.cbody');
  foot.appendChild($('sendBlock'));
}

function showTab(tab) {
  const was = ui.tab;
  ui.tab = tab;
  document.querySelectorAll('.rtab').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  ['plot', 'card', 'machine', 'settings'].forEach((t) => $('tab-' + t).classList.toggle('hide', t !== tab));
  if (tab === 'plot' || tab === 'card') {
    placeShared(tab);
    // Step 3 means a different card on each tab; carry the open state across.
    if (ui.open === 3 || ui.open === 'W') openCard(step3());
    $('pvEmpty').innerHTML = tab === 'card'
      ? 'Write in step 3 and the envelope or card appears here,<br>with travel moves shown so you can see the pen lifts.'
      : 'Choose artwork in step 3 and the plot appears here,<br>with travel moves shown so you can see the pen lifts.';
    // The preview belongs to one tab at a time. A build made for the other
    // tab is not just a wrong picture: Send would upload it. So any entry
    // whose build is not this tab's own gets a fresh one, including a return
    // from Machine or Settings.
    setMasking(false);
    if (ui.builtFor !== tab) rebuild();
  }
  if (tab === 'machine') refreshConsole();
}

// ---- recent envelopes and cards
async function refreshJobs(list) {
  const jobs = list || (await call(API.listJobs(), 'Could not read the recent jobs')) || [];
  ui.jobs = jobs;
  const sel = $('jobPick');
  sel.innerHTML = '';
  const o0 = document.createElement('option');
  o0.value = ''; o0.textContent = jobs.length ? 'Pick one to load it' : 'No recent jobs yet';
  sel.appendChild(o0);
  for (const j of jobs) {
    const o = document.createElement('option');
    o.value = j.id; o.textContent = j.name;
    sel.appendChild(o);
  }
}

function loadJob(j) {
  const f = j.fields || {};
  const set = (id, v) => { if (v !== undefined && v !== null) $(id).value = v; };
  set('paperW', f.paperW); set('paperH', f.paperH); updateCentrePreview();
  const mode = f.writeMode || j.mode || 'envelope';
  $('writeMode').querySelectorAll('.sg').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
  ['envSender', 'envRecipient', 'envFont', 'envSenderMm', 'envRecipientMm', 'envSenderX', 'envSenderY',
   'envRecipientX', 'envRecipientY', 'envSpacingMm', 'cardMessage', 'cardFont', 'cardSizeMm', 'cardLineMm',
   'cardAlign', 'cardX', 'cardY', 'cardSpacingMm', 'cardArtMm', 'cardArtWhere', 'cardArtGap'].forEach((k) => set(k, f[k]));
  set('writeMarginEnv', f.envMargin); set('writeMarginCard', f.cardMargin);
  setCardArt(f.cardArt || null);
  ui.stackIndex = 0;
  syncWriteMode();
  rebuild();
  toast(`${j.name} loaded. The sheet size came with it; check step 2 still matches the machine.`, 'ok', 'Recent job');
}

function setCardArt(p) {
  ui.cardArt = p || null;
  $('cardArtPick').textContent = p ? p.split(/[\\/]/).pop() : 'Add a drawing (SVG, PNG, JPG)';
  $('cardArtClear').classList.toggle('hide', !p);
  $('cardArtOpts').classList.toggle('hide', !p);
  if (!p) $('cardArtInfo').textContent = 'none; the message stands alone';
}

function syncWriteMode() {
  const m = writeMode();
  $('envBox').classList.toggle('hide', m !== 'envelope');
  $('cardBox').classList.toggle('hide', m !== 'card');
}

function chipGroup(el, onPick) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.sc');
    if (!b) return;
    el.querySelectorAll('.sc').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    onPick(b);
  });
}

function toggle(id, onChange) {
  $(id).addEventListener('click', () => {
    $(id).classList.toggle('on');
    onChange($(id).classList.contains('on'));
  });
}

async function boot() {
  const st = await call(API.getState(), 'Could not read saved settings');
  if (st) {
    ui.settings = st.settings || {};
    savedCorner = st.corner || null;
    $('host').value = st.host || 'plotter.local';
    const s = ui.settings;
    $('paperW').value = s.paperW ?? 150;
    $('paperH').value = s.paperH ?? 100;
    $('margin').value = s.margin ?? 10;
    $('minLen').value = s.minLen ?? 0.5;
    $('drawFeed').value = s.drawFeed ?? 3000;
    $('travelFeed').value = s.travelFeed ?? 9000;
    $('simplify').value = s.simplify ?? 0.05;
    $('mergeTol').value = s.mergeTol ?? 0.1;
    if (s.corner) $('cornerWhich').value = s.corner;
    $('togDry').classList.toggle('on', s.dryRun !== false);
    $('togFit').classList.toggle('on', (s.fit ?? 'fit') === 'fit');
    $('togRotate').classList.toggle('on', s.autoRotate !== false);
    $('togLayers').classList.toggle('on', s.keepLayers !== false);
    $('traceThreshold').value = s.traceThreshold ?? 0;
    $('traceFillWidth').value = s.traceFillWidth ?? 0.9;
    $('tracePen').value = s.tracePen ?? 0.3;
    $('togOutline').classList.toggle('on', s.traceOutline !== false);
    $('togMulti').classList.toggle('on', !!s.traceMulticolour);
    $('traceColours').value = s.traceColours ?? 4;
    $('togFills').classList.toggle('on', s.traceFills !== false);
    $('togHatch').classList.toggle('on', s.traceHatch !== false);
    syncTraceMode();
    // fonts come from the main process, so fill the picker before selecting
    const fonts = await call(API.listFonts(), 'Could not read the fonts');
    if (fonts) {
      for (const id of ['textFont', 'envFont', 'cardFont']) {
        $(id).innerHTML = '';
        for (const f of fonts) {
          const o = document.createElement('option');
          o.value = f.id; o.textContent = f.name;
          $(id).appendChild(o);
        }
      }
    }
    $('textMessage').value = s.textMessage || '';
    $('textFont').value = s.textFont || 'EMSReadability';
    $('textSizeMm').value = s.textSizeMm ?? 5;
    $('textLineMm').value = s.textLineMm ?? 0;
    $('textAlign').value = s.textAlign || 'centre';
    $('textX').value = s.textX ?? 0;
    $('textY').value = s.textY ?? 0;
    $('textSpacingMm').value = s.textSpacingMm ?? 0;
    ui.grid = !!s.showGrid;
    $('gridBtn').classList.toggle('on', ui.grid);
    ui.masks = Array.isArray(s.masks) ? s.masks : [];
    $('togText').classList.toggle('on', !!s.textOn);
    $('textBox').classList.toggle('hide', !s.textOn);
    // the Card tab
    $('writeMode').querySelectorAll('.sg').forEach((b) => b.classList.toggle('on', b.dataset.v === (s.writeMode || 'envelope')));
    $('writeMarginEnv').value = s.envMargin ?? 10;
    $('writeMarginCard').value = s.cardMargin ?? 10;
    $('envSender').value = s.envSender || '';
    $('envRecipient').value = s.envRecipient || '';
    $('envFont').value = s.envFont || 'EMSReadability';
    $('envSenderMm').value = s.envSenderMm ?? 3.5;
    $('envRecipientMm').value = s.envRecipientMm ?? 5;
    $('envRecipientX').value = s.envRecipientX ?? 0;
    $('envRecipientY').value = s.envRecipientY ?? 0;
    $('envSenderX').value = s.envSenderX ?? 0;
    $('envSenderY').value = s.envSenderY ?? 0;
    $('envSpacingMm').value = s.envSpacingMm ?? 0;
    $('cardMessage').value = s.cardMessage || '';
    $('cardFont').value = s.cardFont || 'EMSReadability';
    $('cardSizeMm').value = s.cardSizeMm ?? 5;
    $('cardLineMm').value = s.cardLineMm ?? 0;
    $('cardAlign').value = s.cardAlign || 'centre';
    $('cardX').value = s.cardX ?? 0;
    $('cardY').value = s.cardY ?? 0;
    $('cardSpacingMm').value = s.cardSpacingMm ?? 0;
    $('cardArtMm').value = s.cardArtMm ?? 30;
    $('cardArtWhere').value = s.cardArtWhere || 'above';
    $('cardArtGap').value = s.cardArtGap ?? 5;
    setCardArt(s.cardArt || null);
    syncWriteMode();
    refreshJobs();
    if (st.lastFile) setFile(st.lastFile, true);
  }
  openCard(1);
  API.onStatus(paint);
  const c = await call(API.connect(), 'Could not connect');
  if (c) toast(`Klipper ${c.info?.state || 'connected'}`, 'ok', 'Connected');
  refreshConsole();
  setInterval(refreshConsole, 4000);
}

function setFile(path, doBuild = true) {
  ui.file = path;
  const base = path.split(/[\\/]/).pop();
  ui.raster = /\.(png|jpe?g|bmp|webp|gif)$/i.test(base);
  $('dropName').textContent = base;
  $('dropSub').textContent = 'drop another file, or click to browse';
  // The trace controls mean nothing for an SVG, so an SVG never shows them.
  $('traceBox').classList.toggle('hide', !ui.raster);
  if (ui.raster) { $('traceInfo').textContent = 'tracing the drawing'; syncTraceMode(); }
  if (doBuild) rebuild();
}

// Outline mode has no fills or hatch, so hide the controls that do not apply.
function syncTraceMode() {
  const multi = $('togMulti') && $('togMulti').classList.contains('on');
  // Multicolour always traces outlines: a colour is a region, and its edge is
  // what a pen can actually follow.
  if (multi) $('togOutline').classList.add('on');
  const on = $('togOutline') && $('togOutline').classList.contains('on');
  ['togFills', 'togHatch', 'fFillWidth', 'fPen'].forEach((id) => {
    const el = $(id); if (el) el.classList.toggle('hide', on);
  });
  $('togOutline').classList.toggle('hide', multi);
  $('fColours').classList.toggle('hide', !multi);
  $('swatches').classList.toggle('hide', !multi);
  if (!multi) $('swatches').innerHTML = '';
}

// What did PEN_CHANGE say? The console is the honest source: it names the pen
// the gcode actually asked for, in the order the file really uses.
async function readPenChange() {
  const r = await API.consoleLog(60);
  if (!r || !r.ok) return;
  const line = r.value.map((l) => l.message).reverse()
    .find((m) => /PEN CHANGE|NEXT ENVELOPE/i.test(m));
  if (!line) { $('pcWhich').textContent = 'Swap to the next pen'; return; }
  if (/NEXT ENVELOPE/i.test(line)) {
    ui.isEnvChange = true;
    const e = /NEXT ENVELOPE\s+(\d+)\s+of\s+(\d+):\s*(.*?)\.\s+Load/i.exec(line);
    $('ecWhich').textContent = e ? `Load envelope ${e[1]} of ${e[2]}: ${e[3]}` : line.slice(0, 90);
    if (ui.status) paint(ui.status);
    return;
  }
  ui.isPenChange = true;
  const m = /PEN CHANGE\s+(\d+)\s+of\s+(\d+):\s*load\s+(.+?)\.\s/i.exec(`${line} `);
  $('pcWhich').textContent = m ? `Load the ${m[3]} pen  (${m[1]} of ${m[2]})` : line.slice(0, 90);
  if (ui.status) paint(ui.status);
}

async function refreshConsole() {
  if ($('tab-machine').classList.contains('hide')) return;
  const lines = await API.consoleLog(60);
  if (!lines || !lines.ok) return;
  const txt = lines.value
    .map((l) => (l.type === 'command' ? '> ' : '') + l.message)
    .join('\n');
  const pre = $('console');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = txt || '(nothing yet)';
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

document.addEventListener('DOMContentLoaded', () => {
  // rail
  document.querySelectorAll('.rtab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  placeShared('plot');

  document.querySelectorAll('.chead').forEach((b) => {
    if (b.dataset.open) b.addEventListener('click', () => openCard(b.dataset.open === 'W' ? 'W' : +b.dataset.open));
  });

  chipGroup($('zSteps'), (b) => { ui.zStep = parseFloat(b.dataset.v); });
  chipGroup($('zSteps2'), (b) => { ui.zStep2 = parseFloat(b.dataset.v); });
  chipGroup($('xySteps'), (b) => { ui.xyStep = parseFloat(b.dataset.v); });
  chipGroup($('presets'), (b) => {
    $('paperW').value = b.dataset.w;
    $('paperH').value = b.dataset.h;
    updateCentrePreview();
    rebuildSoon(80);
  });

  // --- step 1
  document.querySelectorAll('[data-zjog2]').forEach((b) => b.addEventListener('click', async () => {
    const dir = parseFloat(b.dataset.zjog2);
    const s = await call(API.zJog(dir * ui.zStep2), 'Z jog refused');
    if (s) paint(s);
  }));
  document.querySelectorAll('[data-zjog]').forEach((b) => b.addEventListener('click', async () => {
    const dir = parseFloat(b.dataset.zjog);
    const s = await call(API.zJog(dir * ui.zStep), 'Z jog refused');
    if (s) paint(s);
  }));
  $('zRoom').addEventListener('click', async () => {
    const wasZeroed = ui.status && ui.status.zeroed;
    const s = await call(wasZeroed ? API.releaseZ() : API.zRoom(),
      wasZeroed ? 'Could not unlock Z0' : 'Could not give Z room');
    if (!s) return;
    paint(s);
    toast(wasZeroed
      ? 'Old Z0 released and 200 mm of room opened below. Jog down to the new writing height, then lock it.'
      : 'Z re-declared at 200. Jog down to the writing height, then lock it.', 'ok');
  });
  $('penUp').addEventListener('click', async () => { const s = await call(API.penUp(), 'Pen up refused'); if (s) paint(s); });
  $('penDown').addEventListener('click', async () => { const s = await call(API.penDown(), 'Pen down refused'); if (s) paint(s); });
  // The pen-change panel drives the same actions as step 1, so a swap never
  // means hunting for the controls behind a collapsed card.
  $('pcRoom').addEventListener('click', async () => {
    const st = ui.status;
    const s2 = await call(st && st.zeroed ? API.releaseZ() : API.zRoom(), 'Could not give Z room');
    if (s2) paint(s2);
  });
  document.querySelectorAll('[data-pcjog]').forEach((b) => b.addEventListener('click', async () => {
    const d = parseFloat(b.dataset.pcjog);
    const s2 = await call(API.zJog(d), 'Z jog refused');
    if (s2) paint(s2);
  }));
  $('pcLock').addEventListener('click', async () => {
    const s2 = await call(API.zeroHere(), 'Could not lock Z0');
    if (s2) { paint(s2); toast('Z0 locked for the new pen. Continue when ready.', 'ok'); }
  });
  $('pcResume').addEventListener('click', async () => {
    const s2 = await call(API.resume(), 'Could not resume');
    if (s2) paint(s2);
  });

  $('lockZ').addEventListener('click', async () => {
    const s = await call(API.zeroHere(), 'Could not lock Z0');
    if (s) { paint(s); toast('This height is now Z0 and the floor. Pen moves are unlocked.', 'ok', 'Writing height locked'); openCard(2); }
  });


  // --- step 2
  document.querySelectorAll('[data-jog]').forEach((b) => b.addEventListener('click', async () => {
    const [dx, dy] = b.dataset.jog.split(',').map(Number);
    const s = await call(API.jog(dx * ui.xyStep, dy * ui.xyStep), 'Jog refused');
    if (s) paint(s);
  }));
  const doHome = async () => {
    toast('Homing, then moving back over the bed…', '');
    const s = await call(API.home(), 'Homing failed');
    if (s) { paint(s); toast('Homed. Jog to the corner of the card.', 'ok'); }
  };
  $('homeBtn').addEventListener('click', doHome);
  $('mHome').addEventListener('click', doHome);
  ['paperW', 'paperH'].forEach((id) => $(id).addEventListener('input', () => {
    updateCentrePreview();
    rebuildSoon();
  }));
  $('cornerWhich').addEventListener('change', updateCentrePreview);
  $('setCorner').addEventListener('click', async () => {
    const w = parseFloat($('paperW').value);
    const h = parseFloat($('paperH').value);
    const r = await call(API.setCorner(w, h, $('cornerWhich').value), 'Could not set the origin');
    if (r) {
      savedCorner = r.corner;
      paint(r.status);
      toast(`Sheet centre at X${fmt(r.corner.cx)} Y${fmt(r.corner.cy)}, card ${fmt(w)} × ${fmt(h)}.`, 'ok', 'Origin set');
      openCard(step3());
      rebuild();
    }
  });
  $('restoreBtn').addEventListener('click', async () => {
    const r = await call(API.restoreCorner(), 'Could not restore');
    if (r) { paint(r.status); toast('Corner and card size restored. Set the writing height by hand.', 'ok'); }
  });

  // --- step 3
  $('drop').addEventListener('click', async () => {
    const p = await call(API.pickFile(), 'Could not open that');
    if (p) setFile(p);
  });
  ['dragenter', 'dragover'].forEach((ev) => $('drop').addEventListener(ev, (e) => {
    e.preventDefault(); $('drop').classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => $('drop').addEventListener(ev, (e) => {
    e.preventDefault(); $('drop').classList.remove('over');
  }));
  $('drop').addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.(svg|png|jpe?g|bmp|webp|gif)$/i.test(f.name)) { toast('Drop an SVG or an image (PNG, JPG).', 'err'); return; }
    const real = API.pathForFile(f);
    if (!real) { toast('Could not read that file path. Use the browse button instead.', 'err'); return; }
    setFile(real);
  });
  ['margin', 'minLen', 'drawFeed', 'simplify', 'mergeTol'].forEach((id) =>
    $(id).addEventListener('input', () => rebuildSoon()));
  toggle('togDry', () => rebuildSoon(60));
  toggle('togFit', () => rebuildSoon(60));
  toggle('togRotate', () => rebuildSoon(60));
  toggle('togLayers', () => rebuildSoon(60));
  // Tracing costs a second or two, so these wait longer before firing.
  ['traceThreshold', 'traceFillWidth', 'tracePen'].forEach((id) =>
    $(id).addEventListener('input', () => rebuildSoon(600)));
  toggle('togOutline', () => { syncTraceMode(); rebuildSoon(60); });
  toggle('togMulti', () => { syncTraceMode(); rebuildSoon(60); });
  $('traceColours').addEventListener('input', () => rebuildSoon(600));
  toggle('togFills', () => rebuildSoon(60));
  toggle('togHatch', () => rebuildSoon(60));
  toggle('togText', (on) => { $('textBox').classList.toggle('hide', !on); rebuildSoon(60); });
  ['textSizeMm', 'textLineMm', 'textX', 'textY', 'textSpacingMm'].forEach((id) =>
    $(id).addEventListener('input', () => rebuildSoon()));
  ['textFont', 'textAlign'].forEach((id) =>
    $(id).addEventListener('change', () => rebuildSoon(60)));
  // Typing should not rebuild on every keystroke of a five-line message.
  $('textMessage').addEventListener('input', () => rebuildSoon(450));
  // --- the Card tab
  $('writeMode').addEventListener('click', (e) => {
    const b = e.target.closest('.sg');
    if (!b) return;
    $('writeMode').querySelectorAll('.sg').forEach((x) => x.classList.toggle('on', x === b));
    syncWriteMode();
    rebuildSoon(60);
  });
  ['envSender', 'envRecipient', 'cardMessage'].forEach((id) =>
    $(id).addEventListener('input', () => rebuildSoon(450)));
  ['envSenderMm', 'envRecipientMm', 'envRecipientX', 'envRecipientY', 'envSenderX', 'envSenderY',
   'envSpacingMm', 'writeMarginEnv', 'cardSizeMm', 'cardLineMm', 'cardX', 'cardY', 'cardSpacingMm',
   'writeMarginCard', 'cardArtMm', 'cardArtGap'].forEach((id) =>
    $(id).addEventListener('input', () => rebuildSoon()));
  ['envFont', 'cardFont', 'cardAlign', 'cardArtWhere'].forEach((id) =>
    $(id).addEventListener('change', () => rebuildSoon(60)));
  // a stack of envelopes: which one the preview shows
  $('stackPrev').addEventListener('click', () => { ui.stackIndex = Math.max(0, ui.stackIndex - 1); rebuild(); });
  $('stackNext').addEventListener('click', () => { ui.stackIndex += 1; rebuild(); });
  $('ecResume').addEventListener('click', async () => {
    const s2 = await call(API.resume(), 'Could not resume');
    if (s2) paint(s2);
  });
  // the drawing on a card
  $('cardArtPick').addEventListener('click', async () => {
    const p = await call(API.pickFile(), 'Could not open that');
    if (p) { setCardArt(p); rebuild(); }
  });
  $('cardArtClear').addEventListener('click', () => { setCardArt(null); rebuild(); });
  // recents
  $('jobPick').addEventListener('change', () => {
    const j = ui.jobs.find((x) => x.id === $('jobPick').value);
    $('jobPick').value = '';
    if (j) loadJob(j);
  });
  $('jobSave').addEventListener('click', async () => {
    if (ui.tab !== 'card' || !ui.built) { toast('Write something first.', 'err'); return; }
    const list = await call(API.saveJob(), 'Could not save');
    if (list) { refreshJobs(list); toast('Kept in the Recent list.', 'ok', 'Saved'); }
  });
  // the preview grid
  $('gridBtn').addEventListener('click', () => {
    ui.grid = !ui.grid;
    $('gridBtn').classList.toggle('on', ui.grid);
    API.setSettings({ showGrid: ui.grid });
    if (ui.built) drawPreview(ui.built);
  });

  wireMasks();
  $('maskAdd').addEventListener('click', () => {
    if (!ui.built || !ui.built.trace) { toast('Blanking applies to a traced drawing, so choose an image first.', 'err'); return; }
    setMasking(!ui.masking);
  });
  $('maskClear').addEventListener('click', () => {
    if (!ui.masks.length) return;
    ui.masks = []; setMasking(false); rebuild();
  });
  $('saveSvg').addEventListener('click', async () => {
    const r = await call(API.saveTracedSvg(), 'Could not save that SVG');
    if (r) toast(`${r.paths} paths written to ${r.file.split(/[\\/]/).pop()}`, 'ok', 'Saved');
  });

  $('sendPlot').addEventListener('click', async () => {
    if (!ui.built) { toast(ui.tab === 'card' ? 'Write something first.' : 'Choose some artwork first.', 'err'); return; }
    const pre = await call(API.preflight(), 'Preflight failed');
    if (pre && !pre.ok) {
      toast(pre.problems.join('. ') + '.', 'err', 'Not ready to plot');
      return;
    }
    ui.sending = true;
    $('sendPlot').disabled = true;
    const r = await call(API.send(), 'Could not start the plot');
    ui.sending = false;
    if (r) {
      ui.sentSeconds = ui.built.stats.seconds;
      toast(`${r.name} uploaded and started.`, 'ok',
        ui.built.stats.dryRun ? 'Dry run, nothing is being drawn' : 'Plotting');
    }
  });
  $('saveGcode').addEventListener('click', async () => {
    if (!ui.built) { toast('Nothing built yet.', 'err'); return; }
    const p = await call(API.saveGcode(), 'Could not save');
    if (p) toast(p, 'ok', 'Saved');
  });

  // --- run bar
  $('pauseBtn').addEventListener('click', async () => {
    const s = ui.status;
    const r = await call(s && s.paused ? API.resume() : API.pause(), 'Could not change state');
    if (r) paint(r);
  });
  $('cancelBtn').addEventListener('click', async () => {
    const r = await call(API.cancel(), 'Could not cancel');
    if (r) { paint(r); toast('Cancelled. The pen lifted and the motors stayed on, so the Z reference survives.', 'ok'); }
  });
  $('estop').addEventListener('click', async () => {
    await call(API.estop(), 'Emergency stop failed');
    toast('Emergency stop sent. Klipper needs a firmware restart, and that clears the Z reference and the origin.', 'err', 'Stopped');
  });

  // --- machine tab
  $('mRefresh').addEventListener('click', async () => { const s = await call(API.status(), 'No status'); if (s) paint(s); });
  $('mPenTest').addEventListener('click', async () => { const s = await call(API.penTest(), 'Pen test refused'); if (s) paint(s); });
  $('mGotoCentre').addEventListener('click', async () => {
    const r = await call(API.gotoCentre(), 'Move failed');
    if (r) paint(r);
  });

  // --- settings
  $('reconnect').addEventListener('click', async () => {
    const h = await call(API.setHost($('host').value.trim()), 'Bad address');
    if (!h) return;
    const c = await call(API.connect(), 'Could not connect');
    if (c) { toast(h, 'ok', 'Connected'); paint(c.status); }
  });
  $('lift').addEventListener('change', async () => {
    const v = parseFloat($('lift').value);
    if (!(v > 0)) return;
    const s = await call(API.setLift(v), 'Could not set lift');
    if (s) { paint(s); toast(`Lift is now ${v} mm.`, 'ok'); rebuildSoon(60); }
  });
  $('travelFeed').addEventListener('input', () => rebuildSoon());

  $('connChip').addEventListener('click', () => {
    document.querySelector('.rtab[data-tab="settings"]').click();
  });

  boot();
});
