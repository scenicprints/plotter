'use strict';
// Moonraker HTTP client. Polling rather than a websocket on purpose: a plot
// runs for minutes, a poll every half second is nothing to a Pi 4, and it
// removes a whole class of reconnect bugs from the app.

const DEFAULT_PORT = 7125;

function normaliseHost(input) {
  let h = String(input || '').trim();
  if (!h) return null;
  h = h.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  let u;
  try { u = new URL(h); } catch { return null; }
  if (!u.port) u.port = String(DEFAULT_PORT);
  return `${u.protocol}//${u.hostname}:${u.port}`;
}

class MoonrakerError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'MoonrakerError';
    this.status = status;
  }
}

class Moonraker {
  constructor(host) {
    this.base = normaliseHost(host);
  }

  setHost(host) {
    this.base = normaliseHost(host);
    return this.base;
  }

  async req(path, opts = {}) {
    if (!this.base) throw new MoonrakerError('no plotter address set');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || 10000);
    let res;
    try {
      res = await fetch(this.base + path, {
        method: opts.method || 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new MoonrakerError('timed out talking to the plotter');
      throw new MoonrakerError(`cannot reach the plotter: ${e.message}`);
    }
    clearTimeout(timer);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text.slice(0, 300) || res.statusText;
      throw new MoonrakerError(msg, res.status);
    }
    return json;
  }

  // ------------------------------------------------------------- status
  async info() {
    const r = await this.req('/printer/info', { timeout: 5000 });
    return r?.result || null;
  }

  static OBJECTS = [
    'toolhead',
    'gcode_move',
    'print_stats',
    'virtual_sdcard',
    'webhooks',
    'gcode_macro _PLOT_VARS',
  ];

  async status() {
    const q = Moonraker.OBJECTS.map((o) => encodeURIComponent(o)).join('&');
    const r = await this.req('/printer/objects/query?' + q, { timeout: 6000 });
    return r?.result?.status || {};
  }

  // ------------------------------------------------------------- control
  // Klipper reports a failed command as a 400 with the reason in the body,
  // which req() turns into a MoonrakerError. Callers can just try/catch.
  async script(gcode) {
    const body = Array.isArray(gcode) ? gcode.join('\n') : String(gcode);
    return this.req('/printer/gcode/script?script=' + encodeURIComponent(body), {
      method: 'POST',
      timeout: 120000, // a homing move or a long macro can take a while
    });
  }

  async emergencyStop() {
    return this.req('/printer/emergency_stop', { method: 'POST', timeout: 5000 });
  }

  async firmwareRestart() {
    return this.req('/printer/firmware_restart', { method: 'POST', timeout: 30000 });
  }

  // ------------------------------------------------------------- files
  async upload(filename, content, { root = 'gcodes', print = false } = {}) {
    const boundary = '----plotter' + Math.random().toString(16).slice(2) + Date.now().toString(16);
    const part = (name, value) => Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    );
    const head = Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    );
    const body = Buffer.concat([
      head,
      Buffer.from(content, 'utf8'),
      Buffer.from('\r\n', 'utf8'),
      part('root', root),
      part('print', print ? 'true' : 'false'),
      Buffer.from(`--${boundary}--\r\n`, 'utf8'),
    ]);
    return this.req('/server/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      timeout: 120000,
    });
  }

  async startPrint(filename) {
    return this.req('/printer/print/start?filename=' + encodeURIComponent(filename), {
      method: 'POST',
      timeout: 30000,
    });
  }

  async pausePrint() { return this.req('/printer/print/pause', { method: 'POST', timeout: 15000 }); }

  async resumePrint() { return this.req('/printer/print/resume', { method: 'POST', timeout: 15000 }); }

  async cancelPrint() { return this.req('/printer/print/cancel', { method: 'POST', timeout: 15000 }); }

  async deleteFile(filename, root = 'gcodes') {
    return this.req(`/server/files/${root}/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
      timeout: 15000,
    });
  }

  // Recent console output, for the log panel.
  async gcodeStore(count = 40) {
    const r = await this.req('/server/gcode_store?count=' + count, { timeout: 6000 });
    return r?.result?.gcode_store || [];
  }
}

module.exports = { Moonraker, MoonrakerError, normaliseHost, DEFAULT_PORT };
