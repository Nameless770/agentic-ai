'use strict';

// The floating Claude character: idles, blinks, follows the mouse with its
// eyes, waves on hover, dangles when dragged, and shows what it's doing.

(() => {
  const S = window.BuddySprite;
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  const UNIT = 5; // CSS px per sprite pixel
  const SHADOW_SPACE = 14; // CSS px under the sprite for the shadow
  const SLEEP_AFTER = 60000; // ms without mouse movement

  let dpr = 1;
  let state = 'idle'; // idle | thinking | talking | error
  let unread = false;
  let dragging = false;
  let pressed = false;
  let hover = false;
  let hit = false;
  let cursor = { x: -9999, y: -9999 };
  let lastMove = performance.now();
  const look = { x: 0, y: 0 };
  let blinkStart = -1;
  let nextBlink = performance.now() + 2500;
  let lastFrame = 0;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  function layout() {
    const P = Math.max(1, Math.round(UNIT * dpr));
    const w = S.W * P;
    const h = S.H * P;
    return {
      P,
      w,
      h,
      ox: Math.round((canvas.width - w) / 2),
      baseY: canvas.height - h - Math.round(SHADOW_SPACE * dpr),
    };
  }

  function bubbleKind(sleeping) {
    if (state === 'thinking') return 'spinner';
    if (state === 'talking') return 'typing';
    if (state === 'error') return 'error';
    if (unread) return 'unread';
    if (sleeping) return 'zzz';
    return null;
  }

  // Is a point (CSS px, relative to the window) over the character?
  function isInside(x, y) {
    const L = layout();
    const left = L.ox / dpr - 6;
    const right = (L.ox + L.w) / dpr + 6;
    const top = bubbleKind(false) ? 2 : L.baseY / dpr - 8;
    const bottom = (L.baseY + L.h) / dpr + 8;
    return x >= left && x <= right && y >= top && y <= bottom;
  }

  function updateHit(x, y) {
    if (dragging) return;
    const inside = isInside(x, y);
    hover = inside;
    canvas.classList.toggle('hot', inside);
    if (inside !== hit) {
      hit = inside;
      window.buddy.setHit(inside);
    }
  }

  // ---------------------------------------------------------- input

  window.buddy.on('mascot:cursor', (p) => {
    cursor = p;
    lastMove = performance.now();
    updateHit(p.x, p.y);
  });

  window.addEventListener('mousemove', (e) => {
    cursor = { x: e.clientX, y: e.clientY };
    lastMove = performance.now();
    updateHit(e.clientX, e.clientY);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !isInside(e.clientX, e.clientY)) return;
    canvas.setPointerCapture(e.pointerId);
    pressed = true;
    window.buddy.pointerDown();
  });

  const release = () => {
    if (!pressed) return;
    pressed = false;
    window.buddy.pointerUp();
  };
  canvas.addEventListener('pointerup', (e) => {
    if (e.button === 0) release();
  });
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('lostpointercapture', release);

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.buddy.openMenu();
  });

  window.buddy.on('mascot:drag', (on) => {
    dragging = on;
    canvas.classList.toggle('dragging', on);
    if (!on) updateHit(cursor.x, cursor.y);
  });

  window.buddy.on('mascot:state', (s) => {
    state = s.state || 'idle';
    unread = !!s.unread;
  });

  // ---------------------------------------------------------- drawing

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function withShadow(fn) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 4 * dpr;
    ctx.shadowOffsetY = 1 * dpr;
    fn();
    ctx.restore();
  }

  function drawBubble(kind, t, cx, bottom) {
    const d = dpr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (kind === 'spinner' || kind === 'error') {
      const r = 11 * d;
      const cy = bottom - r;
      withShadow(() => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
      });
      if (kind === 'spinner') {
        const glyph = S.SPINNER[Math.floor(t / 110) % S.SPINNER.length];
        ctx.fillStyle = S.COLORS.body;
        ctx.font = `bold ${15 * d}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
        ctx.fillText(glyph, cx, cy + 0.5 * d);
      } else {
        ctx.fillStyle = '#D9443A';
        ctx.font = `bold ${15 * d}px "Segoe UI", sans-serif`;
        ctx.fillText('!', cx, cy + 0.5 * d);
      }
      return;
    }

    if (kind === 'typing' || kind === 'unread') {
      const w = 32 * d;
      const h = 18 * d;
      const lift = kind === 'unread' ? Math.round(Math.abs(Math.sin(t / 380)) * 3 * d) : 0;
      const x = cx - w / 2;
      const y = bottom - h - 5 * d - lift;
      withShadow(() => {
        roundRect(x, y, w, h, 9 * d);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        // little tail pointing at the head
        ctx.beginPath();
        ctx.moveTo(cx - 4 * d, y + h - 1);
        ctx.lineTo(cx, y + h + 5 * d);
        ctx.lineTo(cx + 4 * d, y + h - 1);
        ctx.closePath();
        ctx.fill();
      });
      for (let i = 0; i < 3; i++) {
        let a = 1;
        let dy = 0;
        if (kind === 'typing') {
          const ph = (t / 260 - i * 0.6) % 3;
          a = 0.35 + 0.65 * Math.max(0, Math.sin(Math.max(0, Math.min(Math.PI, ph))));
          dy = -Math.max(0, Math.sin(Math.max(0, Math.min(Math.PI, ph)))) * 2 * d;
        }
        ctx.globalAlpha = a;
        ctx.fillStyle = kind === 'unread' ? S.COLORS.body : '#8A8880';
        ctx.beginPath();
        ctx.arc(cx + (i - 1) * 8 * d, y + h / 2 + dy, 2.4 * d, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }

    if (kind === 'zzz') {
      ctx.lineWidth = 2.5 * d;
      ctx.strokeStyle = 'rgba(31, 30, 29, 0.85)';
      ctx.fillStyle = '#FFFFFF';
      for (let i = 0; i < 3; i++) {
        const ph = (t / 1600 + i / 3) % 1;
        const size = (8 + ph * 6) * d;
        ctx.globalAlpha = Math.min(1, (1 - ph) * 1.6);
        ctx.font = `bold ${size}px "Segoe UI", sans-serif`;
        const x = cx + (14 + ph * 16) * d;
        const y = bottom - ph * 24 * d;
        ctx.strokeText('z', x, y);
        ctx.fillText('z', x, y);
      }
      ctx.globalAlpha = 1;
    }
  }

  function draw(t, sleeping) {
    const L = layout();
    const P = L.P;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const busy = state === 'thinking' || state === 'talking';

    // Float up and down.
    const freq = sleeping ? 0.2 : state === 'talking' ? 1.4 : state === 'thinking' ? 0.9 : 0.45;
    const amp = dragging ? 0 : sleeping ? 1 : busy ? 3 : 2.5;
    const wave = Math.sin((t / 1000) * Math.PI * 2 * freq);
    const lift = (hover && !dragging ? 3 : 0) + (dragging ? 6 : 0);
    const oy = L.baseY + Math.round(wave * amp * dpr) - Math.round(lift * dpr);

    // Soft shadow on whatever is behind.
    const height01 = (wave * amp + amp + lift) / 12; // 0 = low, 1 = high
    ctx.fillStyle = `rgba(0, 0, 0, ${0.24 - height01 * 0.1})`;
    ctx.beginPath();
    ctx.ellipse(
      canvas.width / 2,
      L.baseY + L.h + 7 * dpr,
      L.w * (0.4 - height01 * 0.08),
      3.2 * dpr,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    const pose = { lookX: 0, lookY: 0, blink: 0, squint: false, armL: 0, armR: 0, legs: [0, 0, 0, 0] };

    // Eyes: follow the mouse, or look up and around while thinking.
    let tx = 0;
    let ty = 0;
    if (state === 'thinking') {
      tx = Math.sin(t / 650) * 0.9;
      ty = -0.9;
    } else {
      const ex = canvas.width / dpr / 2;
      const ey = (oy + 3 * P) / dpr;
      const dx = cursor.x - ex;
      const dy = cursor.y - ey;
      const dist = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, dist / 140);
      tx = (dx / dist) * k;
      ty = (dy / dist) * k;
    }
    look.x += (tx - look.x) * 0.3;
    look.y += (ty - look.y) * 0.3;
    pose.lookX = look.x;
    pose.lookY = look.y;

    // Blink every few seconds.
    if (t > nextBlink) {
      blinkStart = t;
      nextBlink = t + 2200 + Math.random() * 4200;
    }
    const bt = t - blinkStart;
    if (blinkStart >= 0 && bt < 160) pose.blink = Math.sin((bt / 160) * Math.PI);
    if (sleeping) pose.blink = 1;
    if (unread && !busy && !dragging) pose.squint = true;

    // Arms and legs.
    if (dragging) {
      pose.armL = 2;
      pose.armR = 2;
      pose.legs = [0, 1, 2, 3].map((i) => (Math.sin(t / 60 + i * 1.7) > 0 ? 1 : 0));
    } else if (hover) {
      pose.armR = 1 + Math.sin(t / 70);
    } else if (state === 'talking') {
      const a = (Math.sin(t / 140) + 1) / 2;
      pose.armL = a;
      pose.armR = 1 - a;
    } else if (unread) {
      pose.armL = pose.armR = (Math.sin(t / 190) + 1) / 2;
    }

    S.draw(ctx, L.ox, oy, P, pose);

    const kind = bubbleKind(sleeping);
    if (kind) drawBubble(kind, t, canvas.width / 2, oy - 4 * dpr);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const sleeping =
      state === 'idle' && !unread && !hover && !dragging && now - lastMove > SLEEP_AFTER;
    const minGap = sleeping ? 90 : 30; // ~11 fps asleep, ~30 fps awake
    if (now - lastFrame < minGap) return;
    lastFrame = now;
    draw(now, sleeping);
  }
  requestAnimationFrame(frame);
})();
