'use strict';

// Screen capture. Claude Buddy's own windows use content protection
// (WDA_EXCLUDEFROMCAPTURE), so they are invisible in these screenshots and
// the model sees exactly what is underneath them.

const { desktopCapturer } = require('electron');

// Longest side of the screenshot sent to the model. Vision models shrink big
// images themselves; "high" keeps small text readable, "low" is faster.
const MAX_EDGE = { high: 1920, low: 1280 };

/** Largest size <= (w, h) with the same aspect ratio whose longest side fits. */
function fitSize(w, h, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/**
 * Capture one display.
 * Returns { jpeg, thumb, width, height, takenAt }.
 */
async function captureDisplay(display, detail = 'high') {
  const maxEdge = MAX_EDGE[detail] || MAX_EDGE.high;
  const physW = Math.round(display.size.width * display.scaleFactor);
  const physH = Math.round(display.size.height * display.scaleFactor);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: fitSize(physW, physH, maxEdge),
  });
  if (!sources.length) throw new Error('No screen was available to capture.');

  const source = sources.find((s) => s.display_id && s.display_id === String(display.id)) || sources[0];

  let img = source.thumbnail;
  if (!img || img.isEmpty()) throw new Error('The screen capture came back empty.');

  // Thumbnails can come back slightly larger than asked for.
  let size = img.getSize();
  if (Math.max(size.width, size.height) > maxEdge) {
    img = img.resize({ ...fitSize(size.width, size.height, maxEdge), quality: 'best' });
    size = img.getSize();
  }

  return {
    jpeg: img.toJPEG(85),
    thumb: img.resize({ width: Math.min(480, size.width), quality: 'good' }).toJPEG(80),
    width: size.width,
    height: size.height,
    takenAt: new Date(),
  };
}

module.exports = { captureDisplay, fitSize, MAX_EDGE };
