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
const STATS_SECONDS = 0.25;           // the header numbers redraw 4 times a second
const LIST_SECONDS = 1;               // the busiest-ports list redraws once a second
const RATES = [20, 10, 5, 2, 1];      // samples a second the server can be set to
const MAX_ZOOM = 16;
const LEGEND_H = 34;                  // room left under the scene for the legend
const OWN = [255, 255, 255];          // this app's own traffic is drawn white

let tick = 0.05;                      // seconds between samples (the server says)
let windowTicks = 10, statsEvery = 5, listEvery = 20;
let statsIn = 0, listIn = 0;          // samples until the next redraw of each
let rateRestored = false;

const state = {
  side: 'both', proto: 'all', max: 1e9, paused: false, hideOwn: false,
  mode: null, connected: false, services: {}, hover: null, pins: [], mouse: null,
};
// port -> { c, hist, proc, rate, base, own, target, btarget, h, hb }
// base is traffic this app didn't cause, own is traffic it did, and rate is
// what's shown: base plus own, unless own traffic is hidden.
const ports = new Map();
const dts = [];                       // last windowTicks sample lengths
const dirHist = [];                   // last windowTicks [in, out, own in, own out]
let tickNo = 0;

const $ = id => document.getElementById(id);
const stage = $('stage'), cv = $('cv'), ctx = cv.getContext('2d'), tip = $('tip');

// Settings that survive a restart. Storage can be off; then they just don't.
const PREF = 'portTraffic.';
function loadPref(k) { try { return JSON.parse(localStorage.getItem(PREF + k)); } catch { return null; } }
function savePref(k, v) { try { localStorage.setItem(PREF + k, JSON.stringify(v)); } catch { /* not kept */ } }

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
  return state.services[p] || (p >= 49152 ? 'ephemeral' : '');
}

function zoneName(p) {
  if (p <= 1023) return 'Well-known port';
  return p >= 49152 ? 'Ephemeral port' : 'Registered port';
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
const pinned = p => state.pins.includes(p);

function windowSpan() {
  return dts.reduce((a, b) => a + b, 0) || 1;
}

function recompute() {
  const span = windowSpan();
  for (const [p, e] of ports) {
    while (e.hist.length && e.hist[0].n <= tickNo - windowTicks) e.hist.shift();
    let base = 0, own = 0;
    for (const s of e.hist) {
      base += pick(s.v);
      if (s.o) own += pick(s.o);
    }
    e.base = base * 8 / span;
    e.own = own * 8 / span;
    e.rate = e.base + (state.hideOwn ? 0 : e.own);
    e.target = norm(e.rate) * MAXH;
    e.btarget = norm(e.base) * MAXH;
    if (!e.hist.length && e.h < 0.3 && !pinned(p)) ports.delete(p);
  }
}

function entry(p) {
  if (p < 1 || p > 65535) return null;
  let e = ports.get(p);
  if (!e) {
    e = { c: cellOf(p), hist: [], proc: '', rate: 0, base: 0, own: 0, target: 0, btarget: 0, h: 0, hb: 0 };
    ports.set(p, e);
  }
  return e;
}

// The server's sample length sets how many samples make up each average and
// how often the text redraws.
function setTick(t) {
  tick = t;
  windowTicks = Math.max(1, Math.round(RATE_WINDOW / t));
  statsEvery = Math.max(1, Math.round(STATS_SECONDS / t));
  listEvery = Math.max(1, Math.round(LIST_SECONDS / t));
  statsIn = Math.min(statsIn, statsEvery);
  listIn = Math.min(listIn, listEvery);
  $('ctl-rate').value = String(Math.round(1 / t));
}

function onTick(m) {
  if (m.t && m.t !== tick) setTick(m.t);
  if (state.paused) return;
  tickNo++;
  dts.push(m.dt);
  dirHist.push([m.in, m.out, m.si || 0, m.so || 0]);
  while (dts.length > windowTicks) { dts.shift(); dirHist.shift(); }
  for (const [p, tl, tr, ul, ur, proc] of m.p) {
    const e = entry(p);
    if (!e) continue;
    e.hist.push({ n: tickNo, v: [tl, tr, ul, ur], o: null });
    if (proc) e.proc = proc;
  }
  for (const [p, tl, tr, ul, ur] of m.s || []) {   // this app's own traffic
    const e = entry(p);
    if (!e) continue;
    const last = e.hist[e.hist.length - 1];
    if (last && last.n === tickNo) last.o = [tl, tr, ul, ur];
    else e.hist.push({ n: tickNo, v: [0, 0, 0, 0], o: [tl, tr, ul, ur] });
  }
  recompute();
  // Bars follow every sample; text redraws less often so it stays readable.
  if (--statsIn <= 0) {
    statsIn = statsEvery;
    renderStats();
    if (state.hover != null && state.mouse) showTip();
  }
  if (--listIn <= 0) {
    listIn = listEvery;
    renderTop();
  }
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------
// K is the zoom; offX/offY place the scene's top-left corner in the canvas.
let K = 1, dpr = 1, offX = 0, offY = 0, viewW = 0, viewH = 0, userView = false;
let layerBig = null, layerSmall = null, layersDirty = true, checkTile = null;

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

// A bar from height z0 up to h.
function box(g, x, y, s, h, col, z0 = 0) {
  poly(g, [[x, y + s, z0], [x + s, y + s, z0], [x + s, y + s, h], [x, y + s, h]], rgb(col, T.shadeL));
  poly(g, [[x + s, y, z0], [x + s, y + s, z0], [x + s, y + s, h], [x + s, y, h]], rgb(col, T.shadeR));
  poly(g, quad(x, y, s, s, h), rgb(col));
}

// Other traffic in color at the bottom, this app's own stacked on top in white.
function drawBar(g, e) {
  const c = e.c, hb = Math.min(e.hb, e.h);
  if (hb > 0.3) box(g, c.x, c.y, c.s, hb, ramp(hb / MAXH));
  if (e.h - hb > 0.3) box(g, c.x, c.y, c.s, e.h, OWN, hb > 0.3 ? hb : 0);
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

// The faint checkerboard on the big field, filled as a pattern laid onto the
// floor plane so it costs the same at any zoom. The tile is drawn 8x larger
// than one 2 px cell so it stays sharp when zoomed in.
function checker(g, x, y, w, d) {
  if (!checkTile) {
    checkTile = document.createElement('canvas');
    checkTile.width = checkTile.height = 32;
  }
  const t = checkTile.getContext('2d');
  t.clearRect(0, 0, 32, 32);
  t.fillStyle = T.check;
  t.fillRect(0, 0, 16, 16);
  t.fillRect(16, 16, 16, 16);
  const pat = g.createPattern(checkTile, 'repeat');
  pat.setTransform(new DOMMatrix().scale(1 / 8));
  g.save();
  g.transform(C, S, -C, S, OX, OY);   // world floor (x, y) -> scene
  g.fillStyle = pat;
  g.fillRect(x, y, w, d);
  g.restore();
}

// Printed along the front edge of the ephemeral band, like a label on the floor.
// Zoomed out it shrinks with the floor, so it never runs past the edge.
function ephemeralNote(g) {
  const [x, y] = proj(4, HI_ROWS * 2);
  const size = 12 * Math.min(1, K);
  g.save();
  g.translate(x, y);
  g.rotate(Math.atan2(S, C));   // the world x axis runs 30° below horizontal
  const dy = 5 / C + size * 0.85 / K;   // clear of the floor's 5 px edge
  const head = 'Ephemeral ports 49152–65535';
  font(g, size, 600);
  const w = g.measureText(head).width;
  text(g, head, 0, dy, size, T.ink2, 'left', 600);
  text(g, '  ·  Windows assigns them to outgoing connections', w, dy, size, T.muted);
  g.restore();
}

// Floors are static, so they're drawn into two layers whenever the view
// changes: the big field (behind everything) and the small block (in front of
// the big field's bars).
function buildLayers() {
  let g;
  [layerBig, g] = makeLayer();
  slab(g, 0, 0, HI_COLS * 2, HI_ROWS * 2, 5, T.floor);
  poly(g, quad(0, 376, 512, 128), T.dyn);          // rows from 49152 onward
  poly(g, quad(510, 374, 2, 2), T.dyn);            // 49152 is the last cell of row 187
  checker(g, 0, 0, HI_COLS * 2, HI_ROWS * 2);
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
  ephemeralNote(g);

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
}

// ---------------------------------------------------------------------------
// View: zoom with the mouse wheel, move by dragging
// ---------------------------------------------------------------------------
const startScale = () => Math.min(1, viewW / W, (viewH - LEGEND_H) / H);

function resetView() {
  K = startScale();
  offX = Math.round((viewW - W * K) / 2);
  offY = Math.max(0, Math.round((viewH - LEGEND_H - H * K) / 2));
  userView = false;
  layersDirty = true;
}

// Keep at least a corner of the scene on screen.
function clampView() {
  const m = 60;
  offX = Math.min(viewW - m, Math.max(m - W * K, offX));
  offY = Math.min(viewH - m, Math.max(m - H * K, offY));
}

function zoomAt(mx, my, f) {
  const k = Math.min(MAX_ZOOM, Math.max(startScale() / 2, K * f));
  if (k === K) return;
  offX = mx - (mx - offX) * k / K;   // keep the point under the mouse where it is
  offY = my - (my - offY) * k / K;
  K = k;
  clampView();
  userView = true;
  layersDirty = true;
}

function layout() {
  const r = stage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const oldW = viewW, oldH = viewH;
  viewW = r.width;
  viewH = r.height;
  dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  cv.style.width = r.width + 'px';
  cv.style.height = r.height + 'px';
  if (!userView || !oldW) {
    resetView();
  } else {   // keep what was in the middle in the middle
    offX += (viewW - oldW) / 2;
    offY += (viewH - oldH) / 2;
    clampView();
  }
  layersDirty = true;
}

let drag = null;
cv.addEventListener('mousedown', ev => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  drag = { x: ev.clientX, y: ev.clientY, ox: offX, oy: offY };
  cv.classList.add('dragging');
  state.hover = null;
  tip.hidden = true;
});
window.addEventListener('mousemove', ev => {
  if (!drag) return;
  offX = drag.ox + ev.clientX - drag.x;
  offY = drag.oy + ev.clientY - drag.y;
  clampView();
  userView = true;
  layersDirty = true;
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  drag = null;
  cv.classList.remove('dragging');
});
cv.addEventListener('wheel', ev => {
  ev.preventDefault();
  const r = cv.getBoundingClientRect();
  const dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaMode === 2 ? ev.deltaY * viewH : ev.deltaY;
  zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.pow(1.2, -dy / 100));   // 1.2x per notch
}, { passive: false });

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
  for (const p of state.pins) {
    const e = ports.get(p);
    if (e && !chosen.some(b => b.p === p)) chosen.push({ p, e });
  }
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
  for (const b of bars) if (!b.e.c.low) drawBar(ctx, b.e);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layerSmall, 0, 0);
  setScene(ctx);
  for (const b of bars) if (b.e.c.low) drawBar(ctx, b.e);

  for (const p of state.pins) drawHighlight(ctx, p, true);
  if (state.hover != null && !pinned(state.hover)) drawHighlight(ctx, state.hover, false);
  drawLabels(ctx, bars);
}

function ease(h, target, dt) {
  const tau = target > h ? 0.12 : 0.45;   // rise fast, fall slower
  h += (target - h) * (1 - Math.exp(-dt / tau));
  return Math.abs(target - h) < 0.05 ? target : h;
}

let lastFrame = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - lastFrame) / 1000);
  lastFrame = t;
  if ((window.devicePixelRatio || 1) !== dpr) layout();
  if (layersDirty) {
    layersDirty = false;
    buildLayers();
  }
  for (const e of ports.values()) {
    e.h = ease(e.h, e.target, dt);
    e.hb = ease(e.hb, e.btarget, dt);
  }
  draw();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Hover and tooltip
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
  if (p == null || drag) { tip.hidden = true; return; }
  const e = ports.get(p);
  const name = svcName(p);
  const span = windowSpan(), r = b => fmtRate(b * 8 / span);
  let html = `<div class="head"><span class="port">${p}</span>${name ? ' · ' + esc(name) : ''}</div>`;
  if (e && e.rate > 0) {
    let tcp = 0, udp = 0, loc = 0, rem = 0;
    for (const s of e.hist) {
      for (const v of s.o && !state.hideOwn ? [s.v, s.o] : [s.v]) {
        tcp += v[0] + v[1]; udp += v[2] + v[3];
        loc += v[0] + v[2]; rem += v[1] + v[3];
      }
    }
    html += `<div>${fmtRate(e.rate)}</div>`;
    if (e.proc) html += `<div class="sub">${esc(e.proc)}</div>`;
    html += `<div class="faint">TCP ${r(tcp)} · UDP ${r(udp)}</div>`;
    html += `<div class="faint">As local port ${r(loc)} · as remote ${r(rem)}</div>`;
  }
  if (e && e.own > 0) {
    html += `<div class="faint"><span class="sw own"></span>This app's own traffic ${fmtRate(e.own)}${state.hideOwn ? ' (hidden)' : ''}</div>`;
  }
  if (!e || (e.rate <= 0 && e.own <= 0)) {
    html += `<div class="faint">No traffic in the last ${+windowSpan().toFixed(1)} s</div>`;
  }
  html += `<div class="faint">${zoneName(p)}</div>`;
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
  state.hover = drag ? null : portAt(ev);
  showTip();
});
cv.addEventListener('mouseleave', () => { state.hover = null; state.mouse = null; tip.hidden = true; });

// ---------------------------------------------------------------------------
// Header stats and the busiest-ports list
// ---------------------------------------------------------------------------
function renderStats() {
  const span = windowSpan();
  let bin = 0, bout = 0;
  for (const [i, o, oi, oo] of dirHist) {
    bin += state.hideOwn ? i - oi : i;
    bout += state.hideOwn ? o - oo : o;
  }
  $('st-in').textContent = fmtRate(bin * 8 / span);
  $('st-out').textContent = fmtRate(bout * 8 / span);
  let n = 0;
  for (const e of ports.values()) if (e.rate > 0) n++;
  $('st-act').textContent = n.toLocaleString();
}

function listRow(p, e) {
  const rate = e ? e.rate : 0;
  const t = norm(rate), tb = e && e.base > 0 ? Math.min(t, norm(e.base)) : 0;
  const who = e && e.proc ? e.proc : e && e.base <= 0 && e.own > 0 ? 'this app' : '';
  const ownBar = t - tb > 0.001 ? `<i class="own" style="width:${((t - tb) * 100).toFixed(1)}%"></i>` : '';
  return `<li data-port="${p}" class="${pinned(p) ? 'pin' : ''}">` +
    `<span class="p">${p}</span>` +
    `<span class="n">${esc(svcName(p) || '—')}${who ? `<small>${esc(who)}</small>` : ''}</span>` +
    `<span class="r">${rate > 0 ? fmtRate(rate) : 'idle'}</span>` +
    `<span class="m"><i style="width:${(tb * 100).toFixed(1)}%;background:${rgb(ramp(tb))}"></i>${ownBar}</span></li>`;
}

// Pinned ports first, in the order they were pinned, then the busiest others.
function renderTop() {
  const rest = [...ports].filter(([p, e]) => e.rate > 0 && !pinned(p))
    .sort((a, b) => b[1].rate - a[1].rate).slice(0, 16);
  const rows = state.pins.map(p => listRow(p, ports.get(p))).concat(rest.map(([p, e]) => listRow(p, e)));
  $('top').innerHTML = rows.length ? rows.join('')
    : `<li class="empty">${state.connected ? 'No traffic yet' : 'Waiting for the server…'}</li>`;
}

function togglePin(p) {
  const i = state.pins.indexOf(p);
  if (i >= 0) state.pins.splice(i, 1);
  else state.pins.push(p);
  renderTop();
}

// mousedown, not click: the list can be rebuilt between press and release,
// and then a click would land on the list instead of the row.
$('top').addEventListener('mousedown', ev => {
  const li = ev.target.closest('li[data-port]');
  if (li) togglePin(Number(li.dataset.port));
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function refresh() {
  recompute();
  renderStats();
  renderTop();
}

function segmented(id, key) {
  const el = $(id);
  el.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-v]');
    if (!b) return;
    state[key] = b.dataset.v;
    for (const x of el.querySelectorAll('button')) x.classList.toggle('on', x === b);
    refresh();
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

async function postRate(hz) {
  const res = await fetch('/api/rate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hz }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// The samples that arrive next carry the new rate and update the controls.
$('ctl-rate').addEventListener('change', async ev => {
  const hz = Number(ev.target.value);
  savePref('rate', hz);
  try {
    await postRate(hz);
  } catch {
    ev.target.value = String(Math.round(1 / tick));
  }
});

function renderOwn() {
  $('ctl-own').checked = state.hideOwn;
  $('own-text').textContent = state.hideOwn ? "This app's own traffic: hidden" : "This app's own traffic";
}
$('ctl-own').addEventListener('change', ev => {
  state.hideOwn = ev.target.checked;
  savePref('hideOwn', state.hideOwn);
  renderOwn();
  refresh();
});

$('ctl-zoom').addEventListener('click', resetView);

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
    if (info.tick > 0) setTick(info.tick);
    document.title = `Port traffic · ${info.host}`;
    // Put back the sample rate chosen last time.
    const want = loadPref('rate');
    if (!rateRestored && RATES.includes(want) && Math.round(1 / info.tick) !== want) {
      $('ctl-rate').value = String(want);
      postRate(want).catch(() => { $('ctl-rate').value = String(Math.round(1 / tick)); });
    }
    rateRestored = true;
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

state.hideOwn = loadPref('hideOwn') === true;
renderOwn();
readTheme();
darkQuery.addEventListener('change', () => { readTheme(); layersDirty = true; });
new ResizeObserver(layout).observe(stage);
layout();
loadInfo();
connect();
requestAnimationFrame(frame);
