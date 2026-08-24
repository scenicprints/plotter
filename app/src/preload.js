'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('plotter', {
  // Electron 32+ removed File.path, so the real path has to come from here.
  pathForFile: (f) => {
    try { return webUtils.getPathForFile(f); } catch { return f && f.path ? f.path : null; }
  },

  // state
  getState: () => call('state:get'),
  setSettings: (patch) => call('state:setSettings', patch),

  // connection
  setHost: (host) => call('machine:setHost', host),
  connect: () => call('machine:connect'),
  status: () => call('machine:status'),
  onStatus: (fn) => {
    const h = (_e, s) => fn(s);
    ipcRenderer.on('status', h);
    return () => ipcRenderer.removeListener('status', h);
  },

  // motion
  home: () => call('machine:home'),
  jog: (dx, dy) => call('machine:jog', dx, dy),
  zRoom: () => call('machine:zRoom'),
  releaseZ: () => call('machine:releaseZ'),
  zJog: (d) => call('machine:zJog', d),
  penUp: () => call('machine:penUp'),
  penDown: () => call('machine:penDown'),
  penTest: () => call('machine:penTest'),
  gotoCentre: () => call('machine:gotoCentre'),

  // the three sends
  zeroHere: () => call('machine:zeroHere'),
  unzero: () => call('machine:unzero'),
  setCorner: (w, h, which) => call('machine:setCorner', w, h, which),
  restoreCorner: () => call('machine:restoreCorner'),
  setLift: (mm) => call('machine:setLift', mm),
  preflight: () => call('machine:preflight'),
  consoleLog: (n) => call('machine:console', n),

  // artwork
  pickFile: () => call('file:pick'),
  buildPlot: (file, settings) => call('plot:build', file, settings),
  saveGcode: () => call('plot:saveGcode'),
  saveTracedSvg: () => call('plot:saveSvg'),
  listFonts: () => call('text:fonts'),

  // running
  send: () => call('plot:send'),
  pause: () => call('plot:pause'),
  resume: () => call('plot:resume'),
  cancel: () => call('plot:cancel'),
  estop: () => call('plot:estop'),
});
