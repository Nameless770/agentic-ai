/*
 * Claude Buddy - the pixel-art Claude character.
 *
 * Shared by the floating mascot window, the chat window and the icon
 * generator script, so it is written as a tiny UMD module with no
 * dependencies.
 *
 * The character lives on a 16 x 10 grid of square "logical pixels":
 *
 *     ..############..      body: 12 x 8 block
 *     ..############..
 *     ..##O######O##..      eyes: two 1 x 2 slits
 *     ..##O######O##..
 *     ################      arms: 2 x 2 nubs on each side
 *     ################
 *     ..############..
 *     ..############..
 *     ...#.#....#.#...      legs: four 1 x 2 stubs
 *     ...#.#....#.#...
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuddySprite = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 16;
  const H = 10;

  const COLORS = {
    body: '#D97757',
    eye: '#1F1E1D',
  };

  const BODY = { x: 2, y: 0, w: 12, h: 8 };
  const EYES = [{ x: 4, y: 2 }, { x: 11, y: 2 }];
  const ARMS = [{ x: 0, y: 4 }, { x: 14, y: 4 }];
  const LEGS = [3, 5, 10, 12];

  // Claude's "thinking" glyphs, played forwards then backwards.
  const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /**
   * Draw the buddy onto a 2D canvas context, in device pixels.
   *
   * @param ctx  CanvasRenderingContext2D
   * @param ox   left edge of the 16 x 10 grid, in device pixels
   * @param oy   top edge of the grid, in device pixels
   * @param p    size of one logical pixel, in device pixels
   * @param pose optional:
   *   lookX, lookY  -1..1   where the eyes look
   *   blink         0..1    0 = open, 1 = closed
   *   squint        bool    happy, half-closed eyes
   *   armL, armR    0..2    how far each arm is raised (logical px)
   *   legs          [4]     extra length per leg (logical px, 0..1)
   */
  function draw(ctx, ox, oy, p, pose) {
    pose = pose || {};
    const R = Math.round;
    const rect = (x, y, w, h) => {
      const x0 = R(ox + x * p);
      const y0 = R(oy + y * p);
      const x1 = R(ox + (x + w) * p);
      const y1 = R(oy + (y + h) * p);
      if (x1 > x0 && y1 > y0) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    };

    ctx.fillStyle = COLORS.body;

    // Body
    rect(BODY.x, BODY.y, BODY.w, BODY.h);

    // Arms (raised by armL / armR)
    const lift = [clamp(pose.armL || 0, 0, 2), clamp(pose.armR || 0, 0, 2)];
    ARMS.forEach((a, i) => rect(a.x, a.y - lift[i], 2, 2));

    // Legs
    const legs = pose.legs || [0, 0, 0, 0];
    LEGS.forEach((x, i) => rect(x, 8, 1, 2 + clamp(legs[i] || 0, 0, 1)));

    // Eyes
    ctx.fillStyle = COLORS.eye;
    const lx = clamp(pose.lookX || 0, -1, 1) * 0.6;
    const ly = clamp(pose.lookY || 0, -1, 1) * 0.5;
    const blink = clamp(pose.blink || 0, 0, 1);
    let eyeH = 2 * (1 - blink);
    if (pose.squint) eyeH = Math.min(eyeH, 0.8);
    eyeH = Math.max(eyeH, 0.34);
    EYES.forEach((e) => {
      const top = e.y + ly + (2 - eyeH) * (pose.squint ? 0.5 : 1);
      rect(e.x + lx, top, 1, eyeH);
    });
  }

  /**
   * Render a static square icon as RGBA bytes (no canvas needed).
   * Used to build the tray / app icons.
   */
  function iconPixels(size) {
    const px = new Uint8ClampedArray(size * size * 4);
    // Whole-pixel scaling keeps the art crisp; fall back to fractional
    // scaling only when whole pixels would leave the icon too small.
    const whole = Math.floor(size / W);
    const p = whole >= 1 && (whole * W) / size >= 0.75 ? whole : (size * 0.92) / W;
    const ox = (size - W * p) / 2;
    const oy = (size - H * p) / 2;
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    let color = [0, 0, 0];
    const fake = {
      set fillStyle(v) { color = hex(v); },
      fillRect(x, y, w, h) {
        for (let yy = Math.max(0, y); yy < Math.min(size, y + h); yy++) {
          for (let xx = Math.max(0, x); xx < Math.min(size, x + w); xx++) {
            const i = (yy * size + xx) * 4;
            px[i] = color[0];
            px[i + 1] = color[1];
            px[i + 2] = color[2];
            px[i + 3] = 255;
          }
        }
      },
    };
    draw(fake, ox, oy, p, {});
    return px;
  }

  return { W, H, COLORS, SPINNER, draw, iconPixels };
});
