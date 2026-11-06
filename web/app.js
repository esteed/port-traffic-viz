'use strict';

// ---------------------------------------------------------------------------
// Scene geometry. World units are pixels along the isometric axes, so a 5-unit
// bar footprint is 5 px wide on screen at 1:1 zoom.
// ---------------------------------------------------------------------------
const W = 960, H = 810;               // scene size in px at 1:1
const C = Math.cos(Math.PI / 6), S = 0.5;
const OX = 478, OY = 74;              // screen position of world origin
const MAXH = 150;                     // tallest bar, px
const BX = 540, BY = 536;             // world origin of the 1–1024 block
const HI_COLS = 256, HI_ROWS = 252;   // 1025–65535 field: 2 px cells
const MIN_RATE = 100;                 // bits/s at the floor of the log scale
const RATE_WINDOW = 0.5;              // seconds of samples averaged into each rate
const PANEL_MS = 250;                 // redraw the list and header numbers 4 times a second
let windowTicks = 10;                 // RATE_WINDOW / tick length (20 ticks/s), set from /api/info
let lastPanel = 0;

const state = {
  side: 'both', proto: 'all', max: 1e9, zoom: 'actual', paused: false,
  mode: null, connected: false, services: {}, hover: null, pin: null, mouse: null,
};
const ports = new Map();              // port -> { c, hist, proc, rate, target, h }
const dts = [];                       // last windowTicks tick lengths
const dirHist = [];                   // last windowTicks [bytesIn, bytesOut]
let tickNo = 0;

const $ = id => document.getElementById(id);
const stage = $('stage'), cv = $('cv'), ctx = cv.getContext('2d'), tip = $('tip');

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
let T;
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  const base = { bg: v('--bg'), ink: v('--text'), ink2: v('--text-2'), muted: v('--muted'), font: v('--font'), hl: v('--highlight') };
  T = Object.assign(base, darkQuery.matches ? {
    floor: '#2C2C2A', gap: '#1E1E1D', check: 'rgba(255,255,255,0.04)', dyn: '#383836',
    grid: 'rgba(255,255,255,0.08)', sideL: '#232321', sideR: '#151514',
    // Light traffic blue, heavy traffic red, through violet (OKLCH: lightness, chroma, hue)
    stops: [[0.58, 0.17, 258], [0.56, 0.19, 285], [0.58, 0.22, 332], [0.62, 0.23, 374], [0.64, 0.23, 388]],
    shadeL: 0.22, shadeR: 0.38, lead: 'rgba(255,255,255,0.35)',
  } : {
    floor: '#F1EFE8', gap: '#D9D7CE', check: 'rgba(0,0,0,0.035)', dyn: '#E3E1D8',
    grid: 'rgba(0,0,0,0.07)', sideL: '#D3D1C7', sideR: '#B4B2A9',
    stops: [[0.62, 0.17, 258], [0.56, 0.19, 285], [0.56, 0.22, 332], [0.57, 0.23, 374], [0.56, 0.23, 388]],
    shadeL: 0.16, shadeR: 0.3, lead: 'rgba(0,0,0,0.35)',
  });
  T.lut = makeRamp(T.stops);
  $('swatches').innerHTML = [0.1, 0.3, 0.5, 0.7, 0.9].map(t => `<span style="background:${rgb(ramp(t))}"></span>`).join('');
  $('dyn-swatch').style.background = T.dyn;
}

// OKLCH -> sRGB 0-255, lowering chroma until the color fits in sRGB.
function oklch(L, C, h) {
  const hr = h * Math.PI / 180;
  for (; ; C = Math.max(0, C - 0.004)) {
    const a = C * Math.cos(hr), b = C * Math.sin(hr);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                 -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                 -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
    if (C === 0 || lin.every(x => x >= -1e-4 && x <= 1.0001)) {
      return lin.map(x => {
        x = Math.min(1, Math.max(0, x));
        return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
      });
    }
  }
}
// 256-step lookup table interpolated through evenly spaced OKLCH stops.
function makeRamp(stops) {
  const lut = [], n = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * n, k = Math.min(n - 1, Math.floor(t)), f = t - k;
    const [a, b] = [stops[k], stops[k + 1]];
    lut.push(oklch(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f));
  }
  return lut;
}
const ramp = t => T.lut[Math.max(0, Math.min(255, Math.round(t * 255)))];
const rgb = (c, k = 0) => `rgb(${Math.round(c[0] * (1 - k))},${Math.round(c[1] * (1 - k))},${Math.round(c[2] * (1 - k))})`;

// ---------------------------------------------------------------------------
// Ports, rates, formatting
// ---------------------------------------------------------------------------
function cellOf(p) {
  if (p <= 1024) {
    const i = p - 1;
    return { x: BX + (i % 32) * 5, y: BY + Math.floor(i / 32) * 5, s: 5, low: true };
  }
  const i = p - 1025;
  return { x: (i % HI_COLS) * 2, y: Math.floor(i / HI_COLS) * 2, s: 2, low: false };
}

function svcName(p) {
  return state.services[p] || (p >= 49152 ? 'dynamic' : '');
}

function zoneName(p) {
  if (p <= 1023) return 'Well-known';
  if (p === 1024) return 'Registered';
  return p >= 49152 ? 'Dynamic' : 'Registered';
}

// Pick the bytes that match the current filters out of [tcpL, tcpR, udpL, udpR].
function pick(v) {
  const tcp = state.proto !== 'udp', udp = state.proto !== 'tcp';
  const local = state.side !== 'remote', remote = state.side !== 'local';
  return (tcp && local ? v[0] : 0) + (tcp && remote ? v[1] : 0) + (udp && local ? v[2] : 0) + (udp && remote ? v[3] : 0);
}

function norm(rate) {
  if (rate <= 0) return 0;
  const t = Math.log10(rate / MIN_RATE) / Math.log10(state.max / MIN_RATE);
  return Math.min(1, Math.max(0.03, t));   // any traffic gets at least a stub
}

function fmtRate(bps) {
  for (const [unit, div] of [['Gb/s', 1e9], ['Mb/s', 1e6], ['kb/s', 1e3]]) {
    if (bps >= div) {
      const v = bps / div;
      return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${unit}`;
    }
  }
  return `${Math.round(bps)} b/s`;
}

const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function windowSpan() {
  return dts.reduce((a, b) => a + b, 0) || 1;
}

function recompute() {
  const span = windowSpan();
  for (const [p, e] of ports) {
    while (e.hist.length && e.hist[0].n <= tickNo - windowTicks) e.hist.shift();
    let bytes = 0;
    for (const s of e.hist) bytes += pick(s.v);
    e.rate = bytes * 8 / span;
    e.target = norm(e.rate) * MAXH;
    if (!e.hist.length && e.h < 0.3 && state.pin !== p) ports.delete(p);
  }
}

function onTick(m) {
  if (state.paused) return;
  tickNo++;
  dts.push(m.dt);
  dirHist.push([m.in, m.out]);
  while (dts.length > windowTicks) { dts.shift(); dirHist.shift(); }
  for (const [p, tl, tr, ul, ur, proc] of m.p) {
    if (p < 1 || p > 65535) continue;
    let e = ports.get(p);
    if (!e) {
      e = { c: cellOf(p), hist: [], proc: '', rate: 0, target: 0, h: 0 };
      ports.set(p, e);
    }
    e.hist.push({ n: tickNo, v: [tl, tr, ul, ur] });
    if (proc) e.proc = proc;
  }
  recompute();
  // Bars follow every tick; text redraws less often so it stays readable.
  const now = performance.now();
  if (now - lastPanel >= PANEL_MS) {
    lastPanel = now;
    renderStats();
    renderTop();
    if (state.hover != null && state.mouse) showTip();
  }
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------
let K = 1, dpr = 1, offX = 0, offY = 0, layerBig = null, layerSmall = null;

const proj = (x, y, z = 0) => [OX + (x - y) * C, OY + (x + y) * S - z];
const quad = (x, y, w, d, z = 0) => [[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z]];

function path(g, pts) {
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = proj(pts[i][0], pts[i][1], pts[i][2] || 0);
    if (i) g.lineTo(a, b); else g.moveTo(a, b);
  }
  g.closePath();
}
function poly(g, pts, fill) { g.beginPath(); path(g, pts); g.fillStyle = fill; g.fill(); }
function outline(g, pts, stroke, width) { g.beginPath(); path(g, pts); g.strokeStyle = stroke; g.lineWidth = width / K; g.stroke(); }

function slab(g, x, y, w, d, t, top) {
  poly(g, [[x, y + d, 0], [x + w, y + d, 0], [x + w, y + d, -t], [x, y + d, -t]], T.sideL);
  poly(g, [[x + w, y, 0], [x + w, y + d, 0], [x + w, y + d, -t], [x + w, y, -t]], T.sideR);
  poly(g, quad(x, y, w, d), top);
}

function box(g, x, y, s, h, col) {
  poly(g, [[x, y + s, 0], [x + s, y + s, 0], [x + s, y + s, h], [x, y + s, h]], rgb(col, T.shadeL));
  poly(g, [[x + s, y, 0], [x + s, y + s, 0], [x + s, y + s, h], [x + s, y, h]], rgb(col, T.shadeR));
  poly(g, quad(x, y, s, s, h), rgb(col));
}

// Text sizes are in screen px, so labels stay readable at any zoom.
function font(g, size, weight = 400) { g.font = `${weight} ${size / K}px ${T.font}`; }
function text(g, str, x, y, size, color, align = 'left', weight = 400, halo = false) {
  font(g, size, weight);
  g.textAlign = align;
  g.textBaseline = 'middle';
  if (halo) {   // background-colored outline keeps labels readable over bars and grid text
    g.lineJoin = 'round';
    g.lineWidth = 4 / K;
    g.strokeStyle = T.bg;
    g.strokeText(str, x, y);
  }
  g.fillStyle = color;
  g.fillText(str, x, y);
}

function setScene(g) { g.setTransform(K * dpr, 0, 0, K * dpr, offX * dpr, offY * dpr); }

function makeLayer() {
  const c = document.createElement('canvas');
  c.width = cv.width;
  c.height = cv.height;
  const g = c.getContext('2d');
  setScene(g);
  return [c, g];
}

// Floors are static, so they're drawn once per resize into two layers: the big
// field (behind everything) and the small block (in front of the big field's bars).
function buildLayers() {
  let g;
  [layerBig, g] = makeLayer();
  slab(g, 0, 0, HI_COLS * 2, HI_ROWS * 2, 5, T.floor);
  poly(g, quad(0, 376, 512, 128), T.dyn);          // rows from 49152 onward
  poly(g, quad(510, 374, 2, 2), T.dyn);            // 49152 is the last cell of row 187
  g.beginPath();
  for (let r = 0; r < HI_ROWS; r++) {
    for (let c = r & 1; c < HI_COLS; c += 2) path(g, quad(c * 2, r * 2, 2, 2));
  }
  g.fillStyle = T.check;
  g.fill();
  g.beginPath();
  for (let k = 32; k < 512; k += 32) { const a = proj(k, 0), b = proj(k, 504); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
  for (let k = 32; k < 504; k += 32) { const a = proj(0, k), b = proj(512, k); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
  g.strokeStyle = T.grid;
  g.lineWidth = 1 / K;
  g.stroke();
  for (const r of [0, 32, 64, 96, 128, 160, 188]) {
    const dyn = r === 188;
    const [a, b] = proj(0, dyn ? 376 : r * 2 + 1);
    text(g, dyn ? '49152' : String(1025 + 256 * r), a - 8 / K, b, 11, dyn ? T.ink2 : T.muted, 'right', dyn ? 600 : 400);
  }
  text(g, 'Ports 1025–65535', 24, 34, 13, T.ink, 'left', 600);
  text(g, '256 × 252 grid · 2 px bars', 24, 34 + 19 / K, 12, T.muted);

  [layerSmall, g] = makeLayer();
  slab(g, BX, BY, 160, 160, 5, T.gap);
  g.beginPath();
  for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++) path(g, quad(BX + c * 5 + 0.5, BY + r * 5 + 0.5, 4, 4));
  g.fillStyle = T.floor;
  g.fill();
  let [a, b] = proj(BX, BY + 2.5);
  text(g, '1', a - 8 / K, b, 11, T.muted, 'right');
  [a, b] = proj(BX + 160, BY + 160);
  text(g, '1024', a, b + 5 + 12 / K, 11, T.muted, 'center');
  text(g, 'Ports 1–1024', OX + 190, OY + 618, 13, T.ink, 'left', 600);
  text(g, '32 × 32 grid · 5 px bars', OX + 190, OY + 618 + 19 / K, 12, T.muted);
}

function layout() {
  const r = stage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  dpr = window.devicePixelRatio || 1;
  const fit = Math.min(r.width / W, (r.height - 34) / H);   // leave room for the legend
  K = state.zoom === 'fit' ? fit : Math.min(1, fit);
  offX = Math.round((r.width - W * K) / 2);
  offY = Math.max(0, Math.round((r.height - 34 - H * K) / 2));
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  cv.style.width = r.width + 'px';
  cv.style.height = r.height + 'px';
  buildLayers();
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------
function label(g, p, e, x, y, align) {
  const head = `${p} ${svcName(p)}`.trim(), tail = `  ${fmtRate(e.rate)}`;
  font(g, 12, 600);
  const w1 = g.measureText(head).width;
  font(g, 12);
  const w2 = g.measureText(tail).width;
  const x0 = align === 'center' ? x - (w1 + w2) / 2 : x;
  text(g, head, x0, y, 12, T.ink, 'left', 600, true);
  text(g, tail, x0 + w1, y, 12, T.muted, 'left', 400, true);
  return [x0, w1 + w2];
}

function drawLabels(g, bars) {
  const chosen = bars.filter(b => b.e.h > 6).sort((a, b) => b.e.rate - a.e.rate).slice(0, 3);
  const pinned = state.pin != null && ports.get(state.pin);
  if (pinned && !chosen.some(b => b.p === state.pin)) chosen.push({ p: state.pin, e: pinned });
  const placed = [], hh = 18 / K;
  for (const b of chosen) {
    const c = b.e.c;
    const [tx, ty] = proj(c.x + c.s / 2, c.y + c.s / 2, b.e.h);
    font(g, 12, 600);
    const w = g.measureText(`${b.p} ${svcName(b.p)}  ${fmtRate(b.e.rate)}`).width + 8 / K;
    const x0 = tx - w / 2;
    let y = ty - 12 / K;
    while (placed.some(r => x0 < r[0] + r[2] && x0 + w > r[0] && y - hh / 2 < r[1] + r[3] && y + hh / 2 > r[1])) y -= hh;
    placed.push([x0, y - hh / 2, w, hh]);
    if (ty - y > 14 / K) {
      g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx, y + 7 / K);
      g.strokeStyle = T.lead; g.lineWidth = 1 / K; g.stroke();
    }
    label(g, b.p, b.e, tx, y, 'center');
  }
}

function drawHighlight(g, p, strong) {
  const e = ports.get(p), c = e ? e.c : cellOf(p);
  const w = strong ? 2 : 1.5;
  outline(g, quad(c.x, c.y, c.s, c.s), T.hl, w);
  if (e && e.h > 0.5) outline(g, quad(c.x, c.y, c.s, c.s, e.h), T.hl, w);
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!layerBig) return;
  const bars = [];
  for (const [p, e] of ports) if (e.h > 0.3) bars.push({ p, e, d: e.c.x + e.c.y });
  bars.sort((a, b) => a.d - b.d);   // back to front

  ctx.drawImage(layerBig, 0, 0);
  setScene(ctx);
  for (const b of bars) if (!b.e.c.low) box(ctx, b.e.c.x, b.e.c.y, b.e.c.s, b.e.h, ramp(b.e.h / MAXH));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layerSmall, 0, 0);
  setScene(ctx);
  for (const b of bars) if (b.e.c.low) box(ctx, b.e.c.x, b.e.c.y, b.e.c.s, b.e.h, ramp(b.e.h / MAXH));

  if (state.pin != null) drawHighlight(ctx, state.pin, true);
  if (state.hover != null && state.hover !== state.pin) drawHighlight(ctx, state.hover, false);
  drawLabels(ctx, bars);
}

let lastFrame = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - lastFrame) / 1000);
  lastFrame = t;
  if ((window.devicePixelRatio || 1) !== dpr) layout();
  for (const e of ports.values()) {
    const tau = e.target > e.h ? 0.12 : 0.45;   // rise fast, fall slower
    e.h += (e.target - e.h) * (1 - Math.exp(-dt / tau));
    if (Math.abs(e.target - e.h) < 0.05) e.h = e.target;
  }
  draw();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Hover, pin, tooltip
// ---------------------------------------------------------------------------
function floorPort(mx, my) {
  const a = (mx - OX) / C, b = (my - OY) / S;   // a = x − y, b = x + y
  const x = (a + b) / 2, y = (b - a) / 2;
  if (x >= BX && x < BX + 160 && y >= BY && y < BY + 160) {
    return 1 + Math.floor((y - BY) / 5) * 32 + Math.floor((x - BX) / 5);
  }
  if (x >= 0 && x < HI_COLS * 2 && y >= 0 && y < HI_ROWS * 2) {
    const p = 1025 + Math.floor(y / 2) * HI_COLS + Math.floor(x / 2);
    return p <= 65535 ? p : null;
  }
  return null;
}

function hitTest(mx, my) {
  const pad = 3 / K;
  let best = null;
  for (const [p, e] of ports) {
    if (e.h < 0.5) continue;
    const c = e.c;
    const x0 = proj(c.x, c.y + c.s)[0], x1 = proj(c.x + c.s, c.y)[0];
    const y0 = proj(c.x, c.y, e.h)[1], y1 = proj(c.x + c.s, c.y + c.s)[1];
    if (mx >= x0 - pad && mx <= x1 + pad && my >= y0 - pad && my <= y1 + pad) {
      const d = c.x + c.y;
      if (!best || d > best.d) best = { p, d };
    }
  }
  return best ? best.p : floorPort(mx, my);
}

function showTip() {
  const p = state.hover;
  if (p == null) { tip.hidden = true; return; }
  const e = ports.get(p);
  const name = svcName(p);
  let html = `<div class="head"><span class="port">${p}</span>${name ? ' · ' + esc(name) : ''}</div>`;
  if (e && e.rate > 0) {
    const span = windowSpan();
    let tcp = 0, udp = 0, loc = 0, rem = 0;
    for (const s of e.hist) {
      tcp += s.v[0] + s.v[1]; udp += s.v[2] + s.v[3];
      loc += s.v[0] + s.v[2]; rem += s.v[1] + s.v[3];
    }
    const r = b => fmtRate(b * 8 / span);
    html += `<div>${fmtRate(e.rate)}</div>`;
    if (e.proc) html += `<div class="sub">${esc(e.proc)}</div>`;
    html += `<div class="faint">TCP ${r(tcp)} · UDP ${r(udp)}</div>`;
    html += `<div class="faint">As local port ${r(loc)} · as remote ${r(rem)}</div>`;
  } else {
    html += `<div class="faint">No traffic in the last ${+windowSpan().toFixed(1)} s</div>`;
  }
  html += `<div class="faint">${zoneName(p)} · ${p <= 1024 ? 5 : 2} px cell</div>`;
  tip.innerHTML = html;
  tip.hidden = false;
  const sr = stage.getBoundingClientRect();
  let x = state.mouse[0] - sr.left + 14, y = state.mouse[1] - sr.top + 14;
  if (x + tip.offsetWidth > sr.width - 8) x -= tip.offsetWidth + 28;
  if (y + tip.offsetHeight > sr.height - 8) y -= tip.offsetHeight + 28;
  tip.style.left = Math.max(4, x) + 'px';
  tip.style.top = Math.max(4, y) + 'px';
}

function portAt(ev) {
  const r = cv.getBoundingClientRect();
  return hitTest((ev.clientX - r.left - offX) / K, (ev.clientY - r.top - offY) / K);
}
cv.addEventListener('mousemove', ev => {
  state.mouse = [ev.clientX, ev.clientY];
  state.hover = portAt(ev);
  cv.style.cursor = state.hover != null ? 'pointer' : 'default';
  showTip();
});
cv.addEventListener('mouseleave', () => { state.hover = null; state.mouse = null; tip.hidden = true; });
cv.addEventListener('click', ev => setPin(portAt(ev)));

function setPin(p) {
  state.pin = p == null || state.pin === p ? null : p;
  renderTop();
}

// ---------------------------------------------------------------------------
// Header stats and the busiest-ports list
// ---------------------------------------------------------------------------
function renderStats() {
  const span = windowSpan();
  let bin = 0, bout = 0;
  for (const [i, o] of dirHist) { bin += i; bout += o; }
  $('st-in').textContent = fmtRate(bin * 8 / span);
  $('st-out').textContent = fmtRate(bout * 8 / span);
  let n = 0;
  for (const e of ports.values()) if (e.rate > 0) n++;
  $('st-act').textContent = n.toLocaleString();
}

function renderTop() {
  const list = [...ports].filter(([, e]) => e.rate > 0).sort((a, b) => b[1].rate - a[1].rate).slice(0, 16);
  if (state.pin != null && !list.some(([p]) => p === state.pin)) {
    list.push([state.pin, ports.get(state.pin) || { rate: 0, proc: '' }]);
  }
  $('top').innerHTML = list.length ? list.map(([p, e]) => {
    const t = norm(e.rate);
    return `<li data-port="${p}" class="${state.pin === p ? 'pin' : ''}">` +
      `<span class="p">${p}</span>` +
      `<span class="n">${esc(svcName(p) || '—')}${e.proc ? `<small>${esc(e.proc)}</small>` : ''}</span>` +
      `<span class="r">${e.rate > 0 ? fmtRate(e.rate) : 'idle'}</span>` +
      `<span class="m"><i style="width:${(t * 100).toFixed(1)}%;background:${rgb(ramp(t))}"></i></span></li>`;
  }).join('') : `<li class="empty">${state.connected ? 'No traffic yet' : 'Waiting for the server…'}</li>`;
}

// mousedown, not click: the list is rebuilt between press and release often
// enough that a click would land on the list instead of the row.
$('top').addEventListener('mousedown', ev => {
  const li = ev.target.closest('li[data-port]');
  if (li) setPin(Number(li.dataset.port));
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function segmented(id, key) {
  const el = $(id);
  el.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-v]');
    if (!b) return;
    state[key] = b.dataset.v;
    for (const x of el.querySelectorAll('button')) x.classList.toggle('on', x === b);
    recompute();
    renderStats();
    renderTop();
  });
}
segmented('ctl-side', 'side');
segmented('ctl-proto', 'proto');

$('ctl-scale').addEventListener('change', ev => {
  state.max = Number(ev.target.value);
  $('scale-max').textContent = ev.target.selectedOptions[0].textContent;
  recompute();
  renderTop();
});

$('ctl-zoom').addEventListener('click', ev => {
  state.zoom = state.zoom === 'fit' ? 'actual' : 'fit';
  ev.target.textContent = state.zoom === 'fit' ? 'Actual pixels' : 'Fit to window';
  layout();
});

$('ctl-pause').addEventListener('click', ev => {
  state.paused = !state.paused;
  ev.target.textContent = state.paused ? 'Resume' : 'Pause';
  renderStatus();
});

function renderStatus() {
  const el = $('status');
  let cls = '', txt = 'Connecting…';
  if (!state.connected) { cls = 'down'; txt = state.mode ? 'Disconnected' : 'Connecting…'; }
  else if (state.paused) { cls = 'paused'; txt = 'Paused'; }
  else if (state.mode === 'demo') { cls = 'demo'; txt = 'Demo data'; }
  else { cls = 'live'; txt = 'Live'; }
  el.className = 'pill ' + cls;
  el.textContent = txt;
  el.title = state.mode === 'demo' ? 'Simulated traffic. Run server.py without --demo for live capture.' : '';
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function loadInfo() {
  try {
    const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
    state.mode = info.mode;
    state.services = info.services || {};
    if (info.tick > 0) windowTicks = Math.max(1, Math.round(RATE_WINDOW / info.tick));
    document.title = `Port traffic · ${info.host}`;
  } catch {
    // The stream's reconnect will retry; names just stay blank meanwhile.
  }
  renderStatus();
}

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => {
    state.connected = true;
    if (!state.mode) loadInfo();
    renderStatus();
  };
  es.onmessage = ev => onTick(JSON.parse(ev.data));
  es.onerror = () => { state.connected = false; renderStatus(); };
}

readTheme();
darkQuery.addEventListener('change', () => { readTheme(); buildLayers(); });
new ResizeObserver(layout).observe(stage);
layout();
loadInfo();
connect();
requestAnimationFrame(frame);
