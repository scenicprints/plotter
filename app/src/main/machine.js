'use strict';
// The plotter ritual, encoded once so the UI never has to know gcode.
//
// Every rule here came out of something that went wrong on the real machine:
//  * Z0 is the writing height AND the floor. Nothing may command Z below 0.
//  * Read a position only after M400. Straight after G28 the second homing
//    pass is still running and the number that comes back is wrong.
//  * After homing, X/Y park off the plate. Move back over the bed first.
//  * Check homed_axes, not just the zeroed flag. A flag alone once claimed
//    "zeroed" while Klipper had unhomed, and a job drove the carriage down
//    into the bed.

const { Moonraker, MoonrakerError } = require('./moonraker');

const VARS = 'gcode_macro _PLOT_VARS';

class Machine {
  constructor(host) {
    this.mr = new Moonraker(host);
    this.last = null;
  }

  setHost(h) { return this.mr.setHost(h); }

  get host() { return this.mr.base; }

  // ---------------------------------------------------------------- read
  async refresh() {
    const s = await this.mr.status();
    const th = s.toolhead || {};
    const gm = s.gcode_move || {};
    const ps = s.print_stats || {};
    const vs = s.virtual_sdcard || {};
    const wh = s.webhooks || {};
    const v = s[VARS] || {};
    const pos = th.position || [0, 0, 0, 0];
    const off = gm.homing_origin || [0, 0, 0, 0];
    const homed = String(th.homed_axes || '');

    this.last = {
      online: true,
      klipper: wh.state || 'unknown',           // ready | startup | shutdown | error
      klipperMessage: wh.state_message || '',
      homedAxes: homed,
      homedXY: homed.includes('x') && homed.includes('y'),
      homedZ: homed.includes('z'),
      // machine coordinates, what PLOT_P1 reads
      x: pos[0], y: pos[1], z: pos[2],
      // where the sheet centre currently sits, in machine coordinates
      originX: off[0], originY: off[1],
      // Homing clears the gcode offset. The sheet centre can never legitimately
      // be the machine origin, so 0,0 means "no origin set" rather than an
      // origin that happens to sit there.
      hasOrigin: Math.abs(off[0]) > 0.01 || Math.abs(off[1]) > 0.01,
      // position relative to the sheet centre, what the gcode works in
      paperX: (gm.gcode_position || [0, 0, 0, 0])[0],
      paperY: (gm.gcode_position || [0, 0, 0, 0])[1],
      zeroed: Number(v.zeroed || 0) === 1,
      lift: Number(v.lift ?? 10),
      maxFloat: Number(v.max_float ?? 15.9),
      paperW: Number(v.paper_w || 0),
      paperH: Number(v.paper_h || 0),
      zUpFeed: Number(v.z_up_feed ?? 1800),
      zDownFeed: Number(v.z_down_feed ?? 900),
      travelFeed: Number(v.travel_feed ?? 9000),
      axisMax: th.axis_maximum || [235, 235, 250, 0],
      axisMin: th.axis_minimum || [0, 0, 0, 0],
      printState: ps.state || 'standby',        // standby|printing|paused|complete|cancelled|error
      printFile: ps.filename || '',
      printMessage: ps.message || '',
      printDuration: Number(ps.print_duration || 0),
      progress: Number(vs.progress || 0),
      printing: ps.state === 'printing' || ps.state === 'paused',
      paused: ps.state === 'paused',
    };
    return this.last;
  }

  async connect() {
    const info = await this.mr.info();
    const st = await this.refresh();
    return { info, status: st };
  }

  // ---------------------------------------------------------------- moves
  async run(gcode) { return this.mr.script(gcode); }

  async home() {
    const s = await this.refresh();
    if (s.printing) throw new Error('the machine is mid-plot, cancel it first');
    // Clear any old paper origin so the homing move is in real machine space.
    await this.run(['SET_GCODE_OFFSET X=0 Y=0', 'G28 X Y', 'M400']);
    const after = await this.refresh();
    // After homing the carriage parks off the plate, so bring it back over
    // the bed before the operator starts jogging to a corner.
    const midX = (after.axisMax[0] + after.axisMin[0]) / 2;
    const midY = (after.axisMax[1] + after.axisMin[1]) / 2;
    await this.run([`G90`, `G1 X${midX.toFixed(1)} Y${midY.toFixed(1)} F6000`, 'M400']);
    return this.refresh();
  }

  async jog(dx, dy) {
    const s = this.last || await this.refresh();
    if (!s.homedXY) throw new Error('home X and Y first');
    const parts = [];
    if (dx) parts.push(`X=${dx}`);
    if (dy) parts.push(`Y=${dy}`);
    if (!parts.length) return this.refresh();
    await this.run(`JOG ${parts.join(' ')}`);
    await this.run('M400');
    return this.refresh();
  }

  // The gcode offset is the sheet centre, so X0 Y0 in gcode space IS the
  // centre of the card. Lift first, best effort, in case a pen is down.
  async gotoPaperCentre() {
    const s = this.last || await this.refresh();
    if (!s.homedXY) throw new Error('home X and Y first');
    await this.run('PEN_UP').catch(() => {});
    await this.run(['GOTO X=0 Y=0', 'M400']);
    return this.refresh();
  }

  async gotoXY(x, y) {
    await this.run([`GOTO X=${x} Y=${y}`, 'M400']);
    return this.refresh();
  }

  // Release a locked Z0 and immediately give room beneath it, as one action.
  // Once Z0 is set it is the floor, so setting a NEW, lower writing height is
  // impossible until the old reference is cleared. Doing it in two steps sent
  // people hunting, so this is one call. Neither command moves the machine:
  // PLOT_UNZERO only clears a flag, and ZROOM re-declares the current physical
  // height as 200 so there is somewhere to jog down to.
  async releaseZ() {
    const s = this.last || await this.refresh();
    if (s.zeroed) await this.run('PLOT_UNZERO');
    await this.run('ZROOM');
    return this.refresh();
  }

  // Give Z somewhere to travel before it has ever been referenced.
  async zRoom() {
    await this.run('ZROOM');
    return this.refresh();
  }

  // Positive d raises the pen, negative lowers it. Below Z0 Klipper itself
  // refuses the move, which is the backstop we want rather than a check here.
  async zJog(d) {
    const s = this.last || await this.refresh();
    if (!s.homedZ) throw new Error('Z has no reference yet, use "Give Z room" first');
    const mm = Math.abs(d);
    if (!mm) return this.refresh();
    try {
      await this.run([d < 0 ? `ZDOWN D=${mm}` : `ZUP D=${mm}`, 'M400']);
    } catch (e) {
      if (/out of range/i.test(e.message)) {
        throw new Error('Z0 is the floor, so this is as low as it goes. To set a NEW, lower writing height, press "Unlock Z0 to go lower" and then keep jogging down.');
      }
      throw e;
    }
    return this.refresh();
  }

  async penUp() { await this.run(['PEN_UP', 'M400']); return this.refresh(); }

  async penDown() { await this.run(['PEN_DOWN', 'M400']); return this.refresh(); }

  async penTest() { await this.run(['PEN_TEST', 'M400']); return this.refresh(); }

  // ----------------------------------------------------------- the ritual
  // SEND 1. Lock the current physical height as Z0.
  async zeroHere() {
    await this.run('PLOT_ZERO_HERE');
    return this.refresh();
  }

  async unzero() {
    await this.run('PLOT_UNZERO');
    return this.refresh();
  }

  // SEND 2. One corner plus measured dimensions. This replaced two-corner
  // sighting because it removes a whole sighting error and takes the size
  // from a ruler instead of two eyeballed points.
  //
  // 'centre' means the pen is already at the middle of the sheet, so the
  // measured size only records the paper dimensions and the origin is read
  // straight off the pen. No corner-sighting error at all.
  async setCorner(w, h, corner = 'bottom-left') {
    if (!(w > 0) || !(h > 0)) throw new Error('enter the card width and height in mm');
    const s = await this.refresh();
    if (!s.homedXY) throw new Error('home X and Y first');
    const x = s.x, y = s.y;
    const middle = corner === 'centre';
    const sx = middle ? 0 : (corner.includes('right') ? -1 : 1);
    const sy = middle ? 0 : (corner.includes('top') ? -1 : 1);
    const cx = x + (sx * w) / 2;
    const cy = y + (sy * h) / 2;
    await this.run([
      `SET_GCODE_OFFSET X=${cx.toFixed(3)} Y=${cy.toFixed(3)}`,
      `SET_GCODE_VARIABLE MACRO=_PLOT_VARS VARIABLE=paper_w VALUE=${w}`,
      `SET_GCODE_VARIABLE MACRO=_PLOT_VARS VARIABLE=paper_h VALUE=${h}`,
    ]);
    const after = await this.refresh();
    return { status: after, corner: { x, y, w, h, cx, cy, which: corner } };
  }

  // Re-apply a remembered corner. Safe on its own: it only moves numbers,
  // not the machine, and the machine re-homes to the same physical place.
  async restoreCorner(c) {
    if (!c || !(c.w > 0) || !(c.h > 0)) throw new Error('nothing to restore');
    await this.run([
      `SET_GCODE_OFFSET X=${Number(c.cx).toFixed(3)} Y=${Number(c.cy).toFixed(3)}`,
      `SET_GCODE_VARIABLE MACRO=_PLOT_VARS VARIABLE=paper_w VALUE=${c.w}`,
      `SET_GCODE_VARIABLE MACRO=_PLOT_VARS VARIABLE=paper_h VALUE=${c.h}`,
    ]);
    return this.refresh();
  }

  async setLift(mm) {
    await this.run(`SET_GCODE_VARIABLE MACRO=_PLOT_VARS VARIABLE=lift VALUE=${Number(mm)}`);
    return this.refresh();
  }

  // ------------------------------------------------------------ preflight
  // Everything that has to be true before gcode may run. Returns a list of
  // blocking reasons; empty means good to go.
  async preflight() {
    const problems = [];
    let s;
    try {
      s = await this.refresh();
    } catch (e) {
      return { ok: false, problems: [e.message], status: null };
    }
    if (s.klipper !== 'ready') {
      problems.push(`Klipper is "${s.klipper}"${s.klipperMessage ? ': ' + s.klipperMessage.split('\n')[0] : ''}`);
    }
    if (s.printing) problems.push('a plot is already running');
    if (!s.homedXY) problems.push('X and Y are not homed');
    if (!s.homedZ) problems.push('Z has no reference');
    if (!s.zeroed) problems.push('the writing height has not been set (step 1)');
    if (!(s.paperW > 0) || !(s.paperH > 0) || !s.hasOrigin) {
      problems.push('the card position and size have not been set (step 2)');
    }
    return { ok: problems.length === 0, problems, status: s };
  }

  // ---------------------------------------------------------------- print
  async uploadAndStart(filename, gcode, { start = true } = {}) {
    await this.mr.upload(filename, gcode, { root: 'gcodes', print: false });
    if (start) await this.mr.startPrint(filename);
    return this.refresh();
  }

  async pause() {
    await this.run('PEN_UP').catch(() => {});
    await this.mr.pausePrint();
    return this.refresh();
  }

  async resume() { await this.mr.resumePrint(); return this.refresh(); }

  async cancel() {
    await this.mr.cancelPrint();
    // Get the pen off the paper, but never drop the motors: that would erase
    // the hand-set Z reference and cost the whole setup.
    await this.run(['PEN_UP', 'M400']).catch(() => {});
    return this.refresh();
  }

  async estop() { return this.mr.emergencyStop(); }

  async console(n = 40) { return this.mr.gcodeStore(n); }
}

module.exports = { Machine, MoonrakerError };
