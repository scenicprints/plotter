// Traces a real image file end to end, through the same code the app uses.
// Needs Electron for image decoding, so run it as:
//
//     node_modules\.bin\electron test-trace-live.js "C:\path\to\drawing.png"
//
// Writes nothing and touches no machine. Prints what the Plot card would show.

const { app } = require('electron');
const path = require('path');
const { buildLayers, toGcode } = require('./src/core/pipeline');
const { traceImage } = require('./src/core/trace');
const { isRaster, loadBitmap, plannedWidthMm } = require('./src/main/raster');

const file = process.argv[2] || process.env.TRACE_FILE;

app.whenReady().then(() => {
  let code = 0;
  try {
    if (!file) throw new Error('give me an image path as the first argument');
    if (!isRaster(file)) throw new Error(`${path.basename(file)} is not a raster image`);

    const o = {
      paperW: 210, paperH: 297, margin: 10, fit: 'fit', autoRotate: true,
      simplify: 0.05, mergeTol: 0.1, minLen: 0.5, keepLayers: true,
      drawFeed: 3000, travelFeed: 9000, lift: 10, zUpFeed: 1800, zDownFeed: 900,
    };

    let t0 = Date.now();
    const bmp = loadBitmap(file, 2);
    const load = Date.now() - t0;
    const widthMm = plannedWidthMm(bmp.sourceWidth, bmp.sourceHeight, o);

    t0 = Date.now();
    const res = traceImage(bmp, { widthMm, upscale: bmp.scale, fills: true, hatch: true, channelOrder: 'bgra' });
    const traced = Date.now() - t0;

    const mm = widthMm / bmp.width;
    const paths = res.paths.map((p) => p.map((q) => [q[0] * mm, q[1] * mm]));

    t0 = Date.now();
    const r = buildLayers([{ name: 'trace', paths }], o);
    const built = Date.now() - t0;
    const gcode = toGcode(r.paths, r.options, { name: path.basename(file), time: r.stats.time });

    const s = res.stats;
    console.log(`\n  ${path.basename(file)}`);
    console.log(`  source        ${s.sourceWidth || bmp.sourceWidth}x${s.sourceHeight || bmp.sourceHeight}`
              + `  -> ${bmp.width}x${bmp.height} at ${bmp.scale}x`);
    console.log(`  threshold     ${s.threshold} (auto), ink ${s.inkPercent.toFixed(2)}%`);
    console.log(`  fills         ${s.filledPercent.toFixed(1)}% of ink`
              + `  | ${s.outline} outline + ${s.hatch} hatch, ${s.coreDropped} px of cores rejected`);
    console.log(`  raw paths     ${res.paths.length} (${s.centreline} centreline)`);
    console.log(`  after build   ${r.stats.paths} strokes`);
    console.log(`  size          ${r.stats.width.toFixed(1)} x ${r.stats.height.toFixed(1)} mm`
              + (r.stats.rotated ? '  (rotated)' : ''));
    console.log(`  draw / travel ${(r.stats.drawLen / 1000).toFixed(2)} m / ${(r.stats.travelLen / 1000).toFixed(2)} m`);
    console.log(`  estimate      ${r.stats.time}`);
    console.log(`  gcode         ${gcode.split('\n').length} lines`);
    console.log(`  timing        load ${load}ms, trace ${traced}ms, build ${built}ms`);

    if (r.stats.overflow) { console.log('  WARNING: overflows the margins'); code = 1; }
    if (!r.stats.paths) { console.log('  FAIL: nothing to plot'); code = 1; }
    console.log('');
  } catch (e) {
    console.log('  FAILED: ' + e.message);
    code = 1;
  }
  app.exit(code);
});
