/* ==========================================================================
   Portfolio v2. Vanilla JS, no dependencies. Every animation is short,
   time-based (performance.now), runs once, and is skipped under
   prefers-reduced-motion.
   ========================================================================== */

"use strict";

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */
const root = document.documentElement;
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const reduced = () => reducedQuery.matches;
const hasIO = "IntersectionObserver" in window;

function cssVar(name) {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

function currentTheme() {
  return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/* --------------------------------------------------------------------------
   Dithered blue glow: radial/edge falloff thresholded with an ordered Bayer
   4x4 matrix at 2px cells, drawn in --blue-bright on transparent. Generated
   once per theme and cached; exposed as CSS custom properties.
   -------------------------------------------------------------------------- */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const glowCache = {};

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** shape(u, v) returns density in [0, 1] for normalized coordinates. */
function ditherTexture(w, h, rgb, shape) {
  const cell = 2;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / cell);
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / cell);
      // Sample at the cell centre so every 2px cell is uniform.
      const d = shape((cx * cell + 1) / w, (cy * cell + 1) / h);
      const threshold = (BAYER4[(cy % 4) * 4 + (cx % 4)] + 0.5) / 16;
      if (d > threshold) {
        const i = (y * w + x) * 4;
        img.data[i] = rgb[0];
        img.data[i + 1] = rgb[1];
        img.data[i + 2] = rgb[2];
        img.data[i + 3] = 235;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function buildGlows() {
  const theme = currentTheme();
  if (!glowCache[theme]) {
    const rgb = hexToRgb(cssVar("--blue-bright") || "#5B8CFF");
    try {
      const radial = ditherTexture(640, 640, rgb, (u, v) => {
        const d = Math.hypot(u - 0.5, v - 0.5) * 2;
        return d >= 1 ? 0 : Math.pow(1 - d, 1.7) * 0.85;
      });
      const edge = ditherTexture(800, 320, rgb, (u, v) => {
        const side = Math.pow(Math.sin(Math.PI * u), 0.6);
        return Math.pow(v, 2) * side * 0.9;
      });
      glowCache[theme] = { radial, edge };
    } catch (e) {
      return; // canvas unavailable: the page works without the texture
    }
  }
  root.style.setProperty("--dither-radial", 'url("' + glowCache[theme].radial + '")');
  root.style.setProperty("--dither-edge", 'url("' + glowCache[theme].edge + '")');
}

/* --------------------------------------------------------------------------
   Hero silk ribbon: 3 twisting particle sheets splatted into a float
   accumulation buffer, tone-mapped through a density -> colour ramp (deep
   blue -> violet -> near-white core) with a cheap glow pass. Seeded points,
   typed arrays, no per-frame allocations; the loop runs only while the hero
   is visible and the tab is active.
   -------------------------------------------------------------------------- */
const silkRedraws = [];

/* Glowing silk ribbon on a canvas. cfg: scope (pointer area), blocks(add, addText)
   to mark text that dims the ribbon, cy(h, small) for the ribbon centre, gain, seed. */
function initSilk(canvas, cfg) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const hero = cfg.scope || canvas.parentElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const NR = 3, KN = 600, PAD = 10, FEATHER = 30, MARGIN = 16, CELL = 6, LUTN = 1024;
  const TAU = 6.2832;

  function prng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let w = 0, h = 0, dpr = 1, bs = 1, bw = 0, bh = 0, N = 0, PR = 0;
  let wGain = 0.19, cx = 0, cy = 0, Sx = 100, Hh = 0.38, Aa = 0.07, ys = 0.6, bandY0 = 0, fadeL = 150, fadeR = 170;
  const RW = [1, 0.75, 0.3], HWS = [1, 0.85, 1.18];
  let dark = true, baseRgb = [47, 95, 224];
  let pu, pv, pwt, pj, acc, img, px32, off, offCtx, g1, g1Ctx, g2, g2Ctx, g3, g3Ctx;
  const lut = new Uint32Array(LUTN);
  // centreline tables per ribbon (KN knots)
  const T_Y = new Float32Array(NR * KN), T_Z = new Float32Array(NR * KN), T_C = new Float32Array(NR * KN);
  const T_S = new Float32Array(NR * KN), T_H = new Float32Array(NR * KN);
  let blocks = [], blockSig = "", mask = null, mw = 0, mh = 0;
  let clock = 3, running = false, inView = false, raf = 0, last = 0;
  let prevR0 = 0, prevR1 = -1;
  const ptr = { x: -9999, y: -9999, on: false, sx: -9999, sy: -9999, k: 0 };
  let msAvg = 0;

  /* ---------- text exclusion (density multiplier under text) ---------- */
  function collectBlocks() {
    const cr = canvas.getBoundingClientRect();
    const out = [];
    function add(r, m0) {
      if (r.width < 1 || r.height < 1) return;
      out.push({ m0: m0, x0: r.left - cr.left - PAD, y0: r.top - cr.top - PAD, x1: r.right - cr.left + PAD, y1: r.bottom - cr.top + PAD });
    }
    function addText(el, m0) {
      if (!el || !document.createRange) return;
      const rg = document.createRange();
      rg.selectNodeContents(el);
      const rs = rg.getClientRects();
      for (let i = 0; i < rs.length; i++) add(rs[i], m0);
    }
    cfg.blocks(add, addText);
    return out;
  }

  function buildMask() {
    mw = Math.ceil(w / CELL); mh = Math.ceil(h / CELL);
    mask = new Float32Array(mw * mh);
    for (let j = 0; j < mh; j++) {
      for (let i = 0; i < mw; i++) {
        const x = (i + 0.5) * CELL, y = (j + 0.5) * CELL;
        let m = 1;
        for (let q = 0; q < blocks.length; q++) {
          const b = blocks[q];
          const dx = Math.max(b.x0 - x, 0, x - b.x1), dy = Math.max(b.y0 - y, 0, y - b.y1);
          const v = b.m0 + (1 - b.m0) * Math.min(1, Math.sqrt(dx * dx + dy * dy) / FEATHER);
          if (v < m) m = v;
        }
        mask[j * mw + i] = m;
      }
    }
  }

  /* ---------- colour ramp: accumulated density -> RGBA ---------- */
  function mixc(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function buildLut() {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--blue").trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(v);
    if (m) { const n = parseInt(m[1], 16); baseRgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    dark = currentTheme() === "dark";
    const b = baseRgb, W = [255, 255, 255];
    let stops, alphas;
    if (dark) {
      stops = [mixc(b, [0, 0, 0], 0.5), mixc(b, [110, 100, 255], 0.3), mixc(b, [139, 112, 255], 0.75), [196, 176, 255], [250, 247, 255]];
      alphas = [0.0, 0.5, 0.85, 1, 1];
    } else {
      stops = [mixc(b, W, 0.55), mixc(b, W, 0.25), b, mixc(b, [0, 0, 0], 0.15), mixc(b, [0, 0, 0], 0.35)];
      alphas = [0.0, 0.3, 0.6, 0.8, 0.9];
    }
    const pos = [0, 0.28, 0.52, 0.8, 0.97];
    for (let i = 0; i < LUTN; i++) {
      const d = i / 128;
      const t = 1 - Math.exp(-1.6 * Math.pow(d, 0.75));
      let s = 0; while (s < 3 && t > pos[s + 1]) s++;
      const f = Math.max(0, Math.min(1, (t - pos[s]) / (pos[s + 1] - pos[s])));
      const c = mixc(stops[s], stops[s + 1], f), a = alphas[s] + (alphas[s + 1] - alphas[s]) * f;
      lut[i] = ((Math.round(a * 255) << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0;
    }
  }

  /* ---------- geometry ---------- */
  function build() {
    const rand = prng(cfg.seed || 4242);
    pu = new Float32Array(N); pv = new Float32Array(N); pwt = new Float32Array(N); pj = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      pj[i] = i < N * 0.42 ? 0 : i < N * 0.84 ? 1 : 2;
      pu[i] = rand();
      const r = rand() * 2 - 1;
      pv[i] = Math.sign(r) * Math.pow(Math.abs(r), 0.85); // slightly denser toward the edges
      pwt[i] = 0.85 + 0.3 * Math.pow(Math.abs(pv[i]), 3);
    }
  }

  function tables(t) {
    const om = TAU / 13;
    for (let j = 0; j < NR; j++) {
      const p = j * 2.1, dir = j % 2 ? -1 : 1;
      for (let q = 0; q < KN; q++) {
        const u = q / (KN - 1), o = j * KN + q;
        const yc = (j - 1) * 0.1 + Aa * Math.sin(TAU * 0.75 * u + p + om * t) + 0.5 * Aa * Math.sin(TAU * 1.6 * u + 1.3 * p - 0.7 * om * t);
        const zc = 0.18 * Math.sin(TAU * 0.9 * u + 1.3 * p + 0.8 * om * t) - 0.14 * (j === 2 ? 1 : 0);
        const th = dir * TAU * 0.85 * u + 0.9 * Math.sin(TAU * 0.5 * u + p + 0.4 * om * t) + 0.3 * om * t * dir;
        const env = 0.3 + 0.7 * Math.pow(Math.sin(Math.PI * u), 0.7);
        const hw = Hh * HWS[j] * (0.8 + 0.2 * Math.sin(TAU * 0.8 * u + p)) * env;
        T_Y[o] = yc; T_Z[o] = zc; T_C[o] = Math.cos(th) * hw; T_S[o] = Math.sin(th) * hw; T_H[o] = Math.pow(Math.sin(Math.PI * u), 0.8);
      }
    }
  }

  function frameWork() {
    tables(clock);
    // smoothed pointer influence
    ptr.k += ((ptr.on && !reduced ? 1 : 0) - ptr.k) * 0.08;
    if (ptr.on) { if (ptr.sx < -999) { ptr.sx = ptr.x; ptr.sy = ptr.y; } ptr.sx += (ptr.x - ptr.sx) * 0.25; ptr.sy += (ptr.y - ptr.sy) * 0.25; }
    const pk = ptr.k, pxs = ptr.sx, pys = ptr.sy;
    const sweepT = (clock * 0.07) % 1.3 - 0.15;
    const inv = 1 / bs;
    let r0 = bh, r1 = -1;
    const Kn = KN - 1;
    for (let i = 0; i < N; i++) {
      const jj = pj[i], j = jj;
      const fu = pu[i] * Kn, k0 = fu | 0, f = fu - k0, o = jj * KN + k0;
      const v = pv[i];
      const yc = T_Y[o] + (T_Y[o + 1] - T_Y[o]) * f, zc = T_Z[o] + (T_Z[o + 1] - T_Z[o]) * f;
      const cc = T_C[o] + (T_C[o + 1] - T_C[o]) * f, ss = T_S[o] + (T_S[o + 1] - T_S[o]) * f;
      const en = T_H[o] + (T_H[o + 1] - T_H[o]) * f;
      const y = yc + cc * v, z = zc + ss * v;
      const pf = 1 / (1 - 0.5 * z);
      const u = pu[i];
      let sx = cx + (-1 + 2 * u) * Sx * pf, sy = cy + y * Sx * pf * ys;
      if (pk > 0.01) {
        const dx = sx - pxs, dy = sy - pys, d2 = dx * dx + dy * dy;
        if (d2 < 22500 && d2 > 0.01) {
          const d = Math.sqrt(d2), q = 1 - d / 150;
          const push = q * q * 46 * pk;
          sx += dx / d * push; sy += dy / d * push;
        }
      }
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) continue;
      const fxb = sx * inv, fyb = (sy - bandY0) * inv;
      if (fyb < 0 || fyb >= bh - 1) continue;
      let wt = pwt[i] * en * RW[jj] * (0.75 + 0.5 * (z + 0.35) / 0.7);
      let e1 = sx / fadeL; if (e1 > 1) e1 = 1; let e2 = (w - sx) / fadeR; if (e2 > 1) e2 = 1; let e3 = (h - sy) / 60; if (e3 > 1) e3 = 1;
      wt *= (e1 * e1 * (3 - 2 * e1)) * (e2 * e2 * (3 - 2 * e2)) * (e3 * e3 * (3 - 2 * e3)) / (bs * bs);
      const sd = (u - (sweepT + j * 0.17)) * 16;
      wt *= 1 + 1.8 / (1 + sd * sd);
      wt *= mask[((sy / CELL) | 0) * mw + ((sx / CELL) | 0)] * wGain;
      const ix = fxb | 0, iy = fyb | 0, ax = fxb - ix, ay = fyb - iy;
      const a0 = iy * bw + ix;
      acc[a0] += (1 - ax) * (1 - ay) * wt; acc[a0 + 1] += ax * (1 - ay) * wt;
      acc[a0 + bw] += (1 - ax) * ay * wt; acc[a0 + bw + 1] += ax * ay * wt;
      if (iy < r0) r0 = iy;
      if (iy > r1) r1 = iy;
    }
    // tone-map touched rows (union with previous frame so stale pixels clear)
    const a = Math.max(0, Math.min(r0, prevR0)), b = Math.min(bh - 1, Math.max(r1 + 1, prevR1));
    if (a > b) return;
    for (let i = a * bw, e = (b + 1) * bw; i < e; i++) {
      const d = acc[i];
      acc[i] = 0;
      if (d > 0.004) { const q = (d * 128) | 0; px32[i] = lut[q >= LUTN ? LUTN - 1 : q]; } else px32[i] = 0;
    }
    prevR0 = r0; prevR1 = r1 + 1;
    offCtx.putImageData(img, 0, 0, 0, a, bw, b - a + 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    const dw = bw * bs, dh = bh * bs;
    ctx.globalAlpha = 1;
    ctx.drawImage(off, 0, 0, bw, bh, 0, bandY0, dw, dh);
    // multi-scale bloom: 1/2, 1/4, 1/8 downsamples drawn back up, widest last
    g1Ctx.clearRect(0, 0, g1.width, g1.height);
    g1Ctx.drawImage(off, 0, 0, bw, bh, 0, 0, g1.width, g1.height);
    g2Ctx.clearRect(0, 0, g2.width, g2.height);
    g2Ctx.drawImage(g1, 0, 0, g1.width, g1.height, 0, 0, g2.width, g2.height);
    g3Ctx.clearRect(0, 0, g3.width, g3.height);
    g3Ctx.drawImage(g2, 0, 0, g2.width, g2.height, 0, 0, g3.width, g3.height);
    ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
    ctx.globalAlpha = dark ? 0.85 : 0.4;
    ctx.drawImage(g2, 0, 0, g2.width, g2.height, 0, bandY0, dw, dh);
    ctx.globalAlpha = dark ? 1 : 0.5;
    ctx.drawImage(g3, 0, 0, g3.width, g3.height, 0, bandY0, dw, dh);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  function draw() {
    const t0 = performance.now();
    frameWork();
    msAvg = msAvg * 0.95 + (performance.now() - t0) * 0.05;
  }

  function frame(ts) {
    raf = 0;
    if (!running) return;
    const dt = Math.min(0.1, last ? (ts - last) / 1000 : 0.016);
    last = ts; clock += dt;
    draw();
    raf = requestAnimationFrame(frame);
  }

  function sync() {
    const want = !reduced && inView && !document.hidden;
    if (want && !running) { running = true; last = 0; raf = requestAnimationFrame(frame); }
    else if (!want && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  }

  function render() {
    const rect = canvas.getBoundingClientRect();
    const nw = Math.round(rect.width), nh = Math.round(rect.height);
    if (nw < 10 || nh < 10) return;
    const nb = collectBlocks();
    const sig = nb.map((r) => Math.round(r.x0) + "," + Math.round(r.y0) + "," + Math.round(r.x1) + "," + Math.round(r.y1)).join("|");
    const sizeChanged = nw !== w || nh !== h || !acc;
    w = nw; h = nh;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const small = w < 600;
    Sx = (w - 2 * MARGIN) / 2;
    cx = w / 2;
    Hh = small ? 0.42 : 0.3; Aa = small ? 0.08 : 0.11; ys = small ? 0.7 : 0.78;
    fadeL = small ? 70 : 150; fadeR = small ? 70 : 170;
    cy = cfg.cy ? cfg.cy(h, small) : h - (small ? 100 : 90);
    const ext = (Hh * 1.2 + 1.5 * Aa) * Sx * ys * 1.3;
    const y0 = Math.floor(Math.max(0, cy - ext)), y1 = Math.ceil(Math.min(h, cy + ext));
    if (sizeChanged || y0 !== bandY0 || !off || off.height !== Math.ceil((y1 - y0) / bs) + 2) {
      bs = 1.6;
      bandY0 = y0;
      bw = Math.ceil(w / bs) + 2; bh = Math.ceil((y1 - y0) / bs) + 2;
      acc = new Float32Array(bw * bh);
      img = ctx.createImageData(bw, bh); px32 = new Uint32Array(img.data.buffer);
      off = document.createElement("canvas"); off.width = bw; off.height = bh; offCtx = off.getContext("2d");
      g1 = document.createElement("canvas"); g1.width = Math.ceil(bw / 2); g1.height = Math.ceil(bh / 2); g1Ctx = g1.getContext("2d");
      g2 = document.createElement("canvas"); g2.width = Math.ceil(bw / 4); g2.height = Math.ceil(bh / 4); g2Ctx = g2.getContext("2d");
      g3 = document.createElement("canvas"); g3.width = Math.ceil(bw / 8); g3.height = Math.ceil(bh / 8); g3Ctx = g3.getContext("2d");
      prevR0 = bh; prevR1 = -1;
      const n = Math.max(16000, Math.min(56000, Math.round((w * (y1 - y0)) / 2.2)));
      if (n !== N || !pu) { N = n; build(); }
    }
    if (sizeChanged || sig !== blockSig) { blocks = nb; blockSig = sig; buildMask(); }
    buildLut();
    wGain = 0.19 * (small ? 0.6 : 1) * (dark ? 1 : 1.4) * (cfg.gain || 1);
    if (reduced || !running) {
      prevR0 = 0; prevR1 = bh - 1; // full clear of any stale pixels
      draw();
    }
    canvas.classList.add("is-ready");
  }

  silkRedraws.push(render);
  render();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
  setTimeout(() => render(), 1500); // after the intro animation settles
  if ("ResizeObserver" in window) new ResizeObserver(() => render()).observe(canvas);
  else window.addEventListener("resize", () => render());

  if (!reduced) {
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => { inView = entries[0].isIntersecting; sync(); }).observe(canvas);
    } else inView = true;
    document.addEventListener("visibilitychange", sync);
    hero.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      const r = canvas.getBoundingClientRect();
      ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top;
      ptr.on = ptr.x >= 0 && ptr.y >= 0 && ptr.x <= r.width && ptr.y <= r.height;
    });
    hero.addEventListener("pointerleave", () => { ptr.on = false; });
    sync();
  }
}

function initSilks() {
  const heroCanvas = document.querySelector(".hero-silk");
  initSilk(heroCanvas, {
    scope: heroCanvas && heroCanvas.closest(".hero"),
    blocks(add, addText) {
      document.querySelectorAll(".hero__title .line__inner").forEach((el) => addText(el, 0.3));
      addText(document.querySelector(".hero__sub"), 0.2);
      document.querySelectorAll(".hero__cta .btn, .hero__cta .link-arrow, .hero__cta .icon-btn").forEach((el) => add(el.getBoundingClientRect(), 0.25));
      const mini = document.querySelector(".hero__mini");
      if (mini && mini.offsetParent !== null) add(mini.getBoundingClientRect(), 0.3);
    },
  });

  // Contact: a calmer ribbon centred on the heading, dimmed under every line of text
  const ctCanvas = document.querySelector(".contact-silk");
  const ctTitle = document.querySelector(".contact__title");
  if (!ctCanvas || !ctTitle) return;
  initSilk(ctCanvas, {
    scope: ctCanvas.closest(".contact"),
    seed: 9157,
    gain: 0.75,
    cy() {
      const c = ctCanvas.getBoundingClientRect(), t = ctTitle.getBoundingClientRect();
      return t.top + t.height * 0.55 - c.top;
    },
    blocks(add, addText) {
      addText(ctTitle, 0.35);
      addText(document.querySelector(".contact__sub"), 0.2);
      document.querySelectorAll(".contact__actions .btn").forEach((el) => add(el.getBoundingClientRect(), 0.2));
    },
  });
}

/* --------------------------------------------------------------------------
   Theme toggle (persisted, 250ms colour transition only)
   -------------------------------------------------------------------------- */
function applyTheme(theme, persist) {
  root.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.setAttribute("aria-pressed", String(theme === "dark"));
  if (persist) {
    try { localStorage.setItem("theme", theme); } catch (e) { /* storage unavailable */ }
  }
  buildGlows();
  silkRedraws.forEach((f) => f());
}

function initTheme() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.setAttribute("aria-pressed", String(currentTheme() === "dark"));
  let timer = null;
  btn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    if (!reduced()) {
      root.classList.add("theme-anim");
      clearTimeout(timer);
      timer = setTimeout(() => root.classList.remove("theme-anim"), 320);
    }
    applyTheme(next, true);
  });
  // Follow the OS only while the visitor has not chosen explicitly.
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onOs = (e) => {
    let stored = null;
    try { stored = localStorage.getItem("theme"); } catch (err) { /* ignore */ }
    if (!stored) applyTheme(e.matches ? "dark" : "light", false);
  };
  if (mq.addEventListener) mq.addEventListener("change", onOs);
}

/* --------------------------------------------------------------------------
   Nav: scrolled background, active section pill, mobile menu
   -------------------------------------------------------------------------- */
function initNav() {
  const nav = document.getElementById("nav");
  const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const links = Array.from(document.querySelectorAll("[data-nav]"));
  if (hasIO) {
    const setActive = (id) => links.forEach((a) => {
      const on = a.dataset.nav === id;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
    });
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(e.target.id); });
    }, { rootMargin: "-40% 0px -55% 0px" });
    links.forEach((a) => {
      const sec = document.getElementById(a.dataset.nav);
      if (sec) io.observe(sec);
    });
    // Clear the pill while on the hero.
    const top = document.getElementById("top");
    if (top) new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) setActive(""); });
    }, { rootMargin: "-40% 0px -55% 0px" }).observe(top);
  }

  const btn = document.getElementById("menu-btn");
  const menu = document.getElementById("menu");
  const setMenu = (open) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  btn.addEventListener("click", () => setMenu(menu.hidden));
  menu.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setMenu(false)));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { setMenu(false); btn.focus(); } });
  window.addEventListener("resize", () => { if (window.innerWidth > 760) setMenu(false); });
}

/* --------------------------------------------------------------------------
   Hero photo fallback (silhouette + caption when the photo is missing)
   -------------------------------------------------------------------------- */
function initPortrait() {
  const box = document.getElementById("hero-panel");
  if (!box) return;
  const img = box.querySelector(".hero__photo");
  if (!img) return;
  const fail = () => box.classList.add("is-fallback");
  if (img.complete && img.naturalWidth === 0) fail();
  img.addEventListener("error", fail);
}

/* --------------------------------------------------------------------------
   Reveal on view (fade + 16px rise), also triggers line-draw animations
   -------------------------------------------------------------------------- */
function initReveal() {
  const targets = Array.from(document.querySelectorAll(".reveal"));
  if (reduced() || !hasIO) {
    targets.forEach((el) => el.classList.add("is-in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("is-in");
      io.unobserve(e.target);
    });
  }, { threshold: 0.15 });
  targets.forEach((el) => io.observe(el));
}

/* --------------------------------------------------------------------------
   Scene parallax: subtle mouse tilt on every .pm-stage[data-parallax]
   (desktop pointer only, no reduced motion). Each stage eases its own
   --tilt-x / --tilt-y (deg, max +-3.5); the scene CSS adds them to its camera.
   -------------------------------------------------------------------------- */
function initParallax() {
  if (!window.matchMedia("(pointer: fine)").matches) return;
  document.querySelectorAll(".pm-stage[data-parallax]").forEach((stage) => {
    let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    const tick = () => {
      cx += (tx - cx) * 0.12;
      cy += (ty - cy) * 0.12;
      if (Math.abs(tx - cx) < 0.01 && Math.abs(ty - cy) < 0.01) {
        cx = tx; cy = ty; raf = 0;
      } else {
        raf = requestAnimationFrame(tick);
      }
      stage.style.setProperty("--tilt-x", cx.toFixed(2) + "deg");
      stage.style.setProperty("--tilt-y", cy.toFixed(2) + "deg");
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
    stage.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse" || reduced()) return;
      const r = stage.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      tx = -ny * 3.5;
      ty = nx * 3.5;
      kick();
    });
    stage.addEventListener("pointerleave", () => { tx = 0; ty = 0; kick(); });
  });
}

/* --------------------------------------------------------------------------
   Research illustrations: SMIL loops play only while on screen
   -------------------------------------------------------------------------- */
function initResearchArt() {
  const svgs = Array.from(document.querySelectorAll(".pub__art svg"));
  svgs.forEach((svg) => {
    if (typeof svg.pauseAnimations !== "function") return;
    svg.pauseAnimations();
    if (reduced()) { svg.setCurrentTime(parseFloat(svg.dataset.still) || 0); return; }
    if (!hasIO) { svg.unpauseAnimations(); return; }
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) svg.unpauseAnimations(); else svg.pauseAnimations();
    }, { threshold: 0.2 }).observe(svg);
  });
}

/* Copy-email button: clipboard API with a textarea fallback, brief "Copied" state */
function initCopyEmail() {
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    const label = btn.querySelector(".copy__label");
    const idle = label ? label.textContent : "";
    let timer = 0;
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copy;
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
        ta.remove();
      }
      if (!label) return;
      label.textContent = ok ? "Copied ✓" : "Press ⌘C";
      btn.classList.toggle("is-copied", ok);
      clearTimeout(timer);
      timer = setTimeout(() => { label.textContent = idle; btn.classList.remove("is-copied"); }, 2000);
    });
  });
}

/* --------------------------------------------------------------------------
   Init
   -------------------------------------------------------------------------- */
function init() {
  buildGlows();
  initTheme();
  initSilks();
  initNav();
  initPortrait();
  initReveal();
  initParallax();
  initResearchArt();
  initCopyEmail();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
