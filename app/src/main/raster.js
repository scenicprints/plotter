'use strict';
// Loading raster artwork for the tracer.
//
// Electron decodes PNG/JPEG/BMP/WEBP itself, so there is no image library
// here and nothing to install. toBitmap() hands back BGRA on Windows, which
// is why trace.js takes a channel order rather than assuming RGBA.

const { nativeImage } = require('electron');

const RASTER_EXT = ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'];
const RASTER_RE = new RegExp(`\\.(${RASTER_EXT.join('|')})$`, 'i');

function isRaster(file) { return RASTER_RE.test(file || ''); }

// Upsampling before thinning is worth real quality: a 2px line has almost no
// room to have a middle, and the skeleton lands on whole pixels either way.
// At 2x the same line is 4px and the centre falls where it should.
// Capped so a huge scan cannot allocate the machine out of memory.
function loadBitmap(file, upscale = 2, maxPixels = 48e6) {
  let img = nativeImage.createFromPath(file);
  if (!img || img.isEmpty()) throw new Error('that image could not be read');
  const src = img.getSize();
  if (!src.width || !src.height) throw new Error('that image has no size');

  let k = Math.max(1, Math.min(4, Math.round(upscale)));
  while (k > 1 && src.width * src.height * k * k > maxPixels) k--;
  if (src.width * src.height > maxPixels) {
    throw new Error(`that image is ${src.width}x${src.height}, too large to trace`);
  }
  if (k > 1) {
    img = img.resize({ width: src.width * k, height: src.height * k, quality: 'best' });
  }
  const size = img.getSize();
  return {
    data: img.toBitmap(),
    width: size.width,
    height: size.height,
    scale: k,
    sourceWidth: src.width,
    sourceHeight: src.height,
  };
}

// How wide the drawing will actually end up on the card. The tracer's
// tolerances are in millimetres of finished plot, so it has to know this
// before it starts: "ignore strokes under 0.35 mm" is meaningless otherwise.
// Mirrors the fit and auto-rotate decision that pipeline.build makes later.
function plannedWidthMm(imgW, imgH, o) {
  const availW = Math.max(1, (o.paperW ?? 150) - 2 * (o.margin ?? 10));
  const availH = Math.max(1, (o.paperH ?? 100) - 2 * (o.margin ?? 10));
  if (o.fit !== 'fit') return imgW * (o.actualScale || 1);
  const straight = Math.min(availW / imgW, availH / imgH);
  const turned = Math.min(availW / imgH, availH / imgW);
  const s = o.autoRotate === false ? straight : Math.max(straight, turned);
  return imgW * s;
}

module.exports = { isRaster, loadBitmap, plannedWidthMm, RASTER_EXT };
