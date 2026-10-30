(() => {
'use strict';

const $ = id => document.getElementById(id);
const canvas = $('c');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const { smoothstep } = World;

function fatal(msg) {
  $('loadMsg').textContent = 'Something went wrong';
  const spin = document.querySelector('#loading .spin');
  if (spin) spin.remove();
  const pre = document.createElement('pre');
  pre.textContent = msg;
  $('loading').appendChild(pre);
  $('loading').classList.remove('hidden');
}

const gl = canvas.getContext('webgl2', {
  antialias: false, alpha: false, depth: false, stencil: false,
  powerPreference: 'high-performance', preserveDrawingBuffer: false,
});
if (!gl) { fatal('WebGL2 is not available in this browser.'); return; }

const extCBF = gl.getExtension('EXT_color_buffer_float');
const extPar = gl.getExtension('KHR_parallel_shader_compile');
const extTimer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
$('gpu').textContent = gpuName;
$('gpu').title = gpuName;

// ------------------------------------------------------------------ state
const STORE_KEY = 'forestrt.settings.v1';
const HIST_KEY = 'forestrt.history.v1';
const S = Object.assign({}, DEFAULTS);
let firstRun = true;
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  if (saved) firstRun = false;
  if (saved) for (const k in DEFAULTS) if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) S[k] = saved[k];
} catch (e) { /* storage unavailable */ }

let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) {} }, 300);
}

// weather target (wt) and the interpolated current weather (wx)
const wt = Object.assign({ dayCycle: 0, autumn: 0 }, WEATHER.clear);
const wx = Object.assign({}, wt);
let weatherName = 'clear';

const cam = { pos: [0, 0, 0], yaw: 0, pitch: 0, vel: [0, 0, 0], bob: 0 };

// ------------------------------------------------------------------ GL setup
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}
function createProgram(fsSrc) {
  const vs = compile(gl.VERTEX_SHADER, FULLSCREEN_VS);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  return { p, vs, fs, u: null };
}
function programReady(prog) {
  return !extPar || gl.getProgramParameter(prog.p, extPar.COMPLETION_STATUS_KHR);
}
function finalizeProgram(prog, name) {
  if (!gl.getProgramParameter(prog.p, gl.LINK_STATUS)) {
    const log = gl.getShaderInfoLog(prog.fs) || gl.getShaderInfoLog(prog.vs) || gl.getProgramInfoLog(prog.p);
    throw new Error(name + ' shader failed to compile:\n' + log);
  }
  prog.u = {};
  const n = gl.getProgramParameter(prog.p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog.p, i);
    prog.u[info.name] = { loc: gl.getUniformLocation(prog.p, info.name), type: info.type };
  }
}
function set(prog, name, v) {
  const u = prog.u[name];
  if (!u) return;
  switch (u.type) {
    case gl.FLOAT: gl.uniform1f(u.loc, v); break;
    case gl.FLOAT_VEC2: gl.uniform2f(u.loc, v[0], v[1]); break;
    case gl.FLOAT_VEC3: gl.uniform3f(u.loc, v[0], v[1], v[2]); break;
    default: gl.uniform1i(u.loc, typeof v === 'boolean' ? (v ? 1 : 0) : Math.round(v));
  }
}

const P = {
  scene: createProgram(SCENE_FS),
  down: createProgram(DOWN_FS),
  blur: createProgram(BLUR_FS),
  comp: createProgram(COMPOSITE_FS),
};

const vao = gl.createVertexArray();

// 64^3 tileable random volume. Sampled with smoothstepped coordinates it gives
// C1-smooth value noise in a single fetch (clouds, foliage, bark, ground).
function makeNoiseTexture() {
  const N = 64;
  const data = new Uint8Array(N * N * N);
  let s = 0x2F6E2B1;
  for (let i = 0; i < data.length; i++) {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    data[i] = ((t ^ (t >>> 14)) >>> 0) & 255;
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, N, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  return tex;
}
const noiseTex = makeNoiseTexture();

function makeLatticeTexture() {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 256, 0, gl.RGBA, gl.FLOAT, World.lattice);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return tex;
}
const latticeTex = makeLatticeTexture();

let hdr = !!extCBF;
function makeTarget(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok && hdr) {
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
    hdr = false;
    return makeTarget(w, h);
  }
  return { tex, fbo, w, h };
}
function freeTarget(t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); } }

const RT = { scene: null, b1a: null, b1b: null, b2a: null, b2b: null };
function ensureTargets(w, h) {
  if (RT.scene && RT.scene.w === w && RT.scene.h === h) return;
  for (const k in RT) freeTarget(RT[k]);
  RT.scene = makeTarget(w, h);
  const w1 = Math.max(1, Math.ceil(w / 4)), h1 = Math.max(1, Math.ceil(h / 4));
  const w2 = Math.max(1, Math.ceil(w / 16)), h2 = Math.max(1, Math.ceil(h / 16));
  RT.b1a = makeTarget(w1, h1); RT.b1b = makeTarget(w1, h1);
  RT.b2a = makeTarget(w2, h2); RT.b2b = makeTarget(w2, h2);
}
function bindTex(unit, tex, filter) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (filter) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  }
}
function drawTo(target) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
  gl.viewport(0, 0, target ? target.w : canvas.width, target ? target.h : canvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// GPU timer queries (where the browser exposes them)
const timer = { pending: [], gpuMs: null };
function timerBegin() {
  if (!extTimer) return null;
  const q = gl.createQuery();
  gl.beginQuery(extTimer.TIME_ELAPSED_EXT, q);
  return q;
}
function timerEnd(q) {
  if (!q) return;
  gl.endQuery(extTimer.TIME_ELAPSED_EXT);
  timer.pending.push(q);
}
function timerPoll() {
  if (!extTimer) return;
  const disjoint = gl.getParameter(extTimer.GPU_DISJOINT_EXT);
  while (timer.pending.length) {
    const q = timer.pending[0];
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
    if (!disjoint) timer.gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
    gl.deleteQuery(q);
    timer.pending.shift();
  }
}

// ------------------------------------------------------------------ sun / light
const light = { sunDir: [0, 1, 0], dir: [0, 1, 0], col: [1, 1, 1], storm: 0, autoEV: 1 };
function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

function updateLight(dt) {
  const ang = (wx.tod - 6) / 24 * Math.PI * 2;
  const s = norm3([Math.cos(ang) * 0.75, Math.sin(ang) * 0.9, 0.45]);
  const sy = s[1];
  const sunF = smoothstep(0, 0.1, sy);
  const moonF = smoothstep(0, -0.12, sy);
  const warm = smoothstep(0.0, 0.45, sy);
  const att = (1 - 0.88 * Math.pow(wx.cloudCover, 1.6)) * (1 - 0.35 * wx.lightning) * S.sunIntensity;
  let col;
  if (sy > 0) {
    col = [lerp(1.0, 1.0, warm), lerp(0.42, 0.93, warm), lerp(0.12, 0.85, warm)].map(v => v * 3.2 * sunF * att);
    light.dir = s;
  } else {
    col = [0.10, 0.13, 0.22].map(v => v * 0.6 * moonF * att);
    light.dir = [-s[0], -s[1], -s[2]];
  }
  light.sunDir = s;
  light.col = col;
  light.storm = clamp(wx.rain * 0.4 + wx.lightning * 0.6, 0, 1);

  const lum = 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2];
  const day = smoothstep(-0.12, 0.25, sy);
  const est = lum * 0.3 + day * 0.55 * (1 - 0.4 * wx.cloudCover) * (1 - 0.4 * light.storm) + 0.02;
  const target = clamp(Math.pow(1.35 / est, 0.75), 0.6, 6);
  light.autoEV = dt > 0 ? lerp(light.autoEV, target, 1 - Math.exp(-dt * 2)) : target;
}

// ------------------------------------------------------------------ lightning
let rand = Math.random;
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const bolt = { flash: 0, t: -1, next: 1, str: 1 };
function updateLightning(dt) {
  if (wx.lightning > 0.05) {
    bolt.next -= dt;
    if (bolt.next <= 0) {
      bolt.t = 0;
      bolt.str = 0.6 + rand() * 0.8;
      bolt.next = (2 + rand() * 7) / wx.lightning;
    }
  }
  bolt.flash = 0;
  if (bolt.t >= 0) {
    bolt.t += dt;
    const t = bolt.t;
    const f = t < 0.07 ? 1 : t < 0.14 ? 0.15 : t < 0.24 ? 0.85 : Math.exp(-(t - 0.24) * 9);
    bolt.flash = f * bolt.str * 1.6 * wx.lightning;
    if (t > 1.2) bolt.t = -1;
  }
}

// ------------------------------------------------------------------ weather
function setWeather(name, instant) {
  weatherName = name;
  const w = WEATHER[name];
  for (const k of WEATHER_KEYS) wt[k] = w[k];
  wt.tod = w.tod;
  if (instant) Object.assign(wx, wt);
  updateWeatherChips();
  syncUI();
}
function updateWeather(dt) {
  const k = 1 - Math.exp(-dt * 2.2);
  for (const key of WEATHER_KEYS) wx[key] += (wt[key] - wx[key]) * k;
  wx.autumn += (wt.autumn - wx.autumn) * k;
  if (wt.dayCycle > 0 && !bench.running) {
    wt.tod = (wt.tod + dt * wt.dayCycle) % 24;
    wx.tod = wt.tod;
  } else {
    let d = wt.tod - wx.tod;
    if (d > 12) d -= 24;
    if (d < -12) d += 24;
    wx.tod = (wx.tod + d * k + 24) % 24;
  }
}

// ------------------------------------------------------------------ camera
function groundAt(x, z) { return World.terrainH(x, z, S.terrainOct); }
function resetCamera() {
  const z = 60, x = World.pathX(z);
  cam.pos = [x, groundAt(x, z) + 1.7, z];
  cam.yaw = Math.atan2(World.pathX(z + 1) - x, 1);
  cam.pitch = 0.03;
  cam.vel = [0, 0, 0];
}
function camBasis() {
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const f = [Math.sin(cam.yaw) * cp, sp, Math.cos(cam.yaw) * cp];
  const r = norm3([-f[2], 0, f[0]]);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { f, r, u };
}

const keys = new Set();
const touch = { x: 0, y: 0, up: false, down: false };
function updateCamera(dt) {
  const fly = !S.walk;
  const fh = [Math.sin(cam.yaw), 0, Math.cos(cam.yaw)];
  const rh = [-fh[2], 0, fh[0]];
  const { f } = camBasis();
  const fwd = fly ? f : fh;
  const mv = [0, 0, 0];
  const add = (v, s) => { mv[0] += v[0] * s; mv[1] += v[1] * s; mv[2] += v[2] * s; };
  if (keys.has('KeyW') || keys.has('ArrowUp')) add(fwd, 1);
  if (keys.has('KeyS') || keys.has('ArrowDown')) add(fwd, -1);
  if (keys.has('KeyD') || keys.has('ArrowRight')) add(rh, 1);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) add(rh, -1);
  add(fwd, touch.y);
  add(rh, touch.x);
  if (fly && (keys.has('Space') || touch.up)) mv[1] += 1;
  if (fly && (keys.has('KeyC') || keys.has('ControlLeft') || touch.down)) mv[1] -= 1;
  const len = Math.hypot(mv[0], mv[1], mv[2]);
  // stick pushed to the rim sprints, like holding Shift
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') || Math.hypot(touch.x, touch.y) > 0.97;
  const speed = S.moveSpeed * (sprint ? 3.5 : 1) * Math.min(1, len);
  const target = len > 0 ? mv.map(v => v / len * speed) : [0, 0, 0];
  const k = 1 - Math.exp(-dt * 9);
  for (let i = 0; i < 3; i++) cam.vel[i] += (target[i] - cam.vel[i]) * k;
  for (let i = 0; i < 3; i++) cam.pos[i] += cam.vel[i] * dt;

  if (S.walk) {
    World.collide(cam.pos, S.treeDensity, 0.35);
    const hs = Math.hypot(cam.vel[0], cam.vel[2]);
    cam.bob += dt * hs * 1.6;
    const g = groundAt(cam.pos[0], cam.pos[2]) + 1.7 + Math.sin(cam.bob) * 0.035 * Math.min(1, hs / 4);
    cam.pos[1] += (g - cam.pos[1]) * (1 - Math.exp(-dt * 14));
  } else {
    cam.pos[1] = Math.max(cam.pos[1], groundAt(cam.pos[0], cam.pos[2]) + 0.6);
  }
}

// ------------------------------------------------------------------ benchmark
const BENCH = [
  { w: 'clear',  tod: 10.5, name: 'Clear morning',                 crane: false, autumn: 0 },
  { w: 'fog',    tod: 7.6,  name: 'Foggy dawn · volumetric light',  crane: true,  autumn: 0 },
  { w: 'storm',  tod: 16.0, name: 'Thunderstorm · rain & reflections', crane: false, autumn: 0 },
  { w: 'snow',   tod: 11.5, name: 'Snowfall',                      crane: true,  autumn: 0 },
  { w: 'golden', tod: 18.4, name: 'Golden hour · autumn',          crane: false, autumn: 0.8 },
];
const SCENE_DUR = 10, WARMUP = 2.5;
const bench = { running: false, t: 0, idx: -1, frames: [], perScene: [], saved: null };

function startBenchmark() {
  if (!started) return;
  $('results').classList.add('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  bench.saved = { cam: JSON.parse(JSON.stringify(cam)), wt: Object.assign({}, wt), weatherName };
  bench.running = true;
  bench.t = -WARMUP;
  bench.idx = -1;
  bench.frames = [];
  bench.perScene = BENCH.map(() => []);
  rand = seededRandom(424242);
  bolt.t = -1; bolt.next = 1.5;
  keys.clear();
  $('benchBar').classList.remove('hidden');
  document.body.classList.add('benching');
  document.body.classList.remove('panel-open');
  touch.x = touch.y = 0; touch.up = touch.down = false;
  $('runBench').disabled = true;
}
function applyBenchScene(i) {
  const b = BENCH[i];
  bench.idx = i;
  setWeather(b.w, true);
  wt.tod = wx.tod = b.tod;
  wt.autumn = wx.autumn = b.autumn;
  wt.dayCycle = 0;
  syncUI();
}
function benchCamera() {
  const tt = Math.max(bench.t, 0);
  const z = 40 + tt * 5.5;
  const x = World.pathX(z);
  const u = (tt - bench.idx * SCENE_DUR) / SCENE_DUR;
  const crane = BENCH[bench.idx].crane ? Math.pow(Math.sin(Math.PI * clamp(u, 0, 1)), 2) * 26 : 0;
  cam.pos = [x, groundAt(x, z) + 1.9 + crane, z];
  const z2 = z + 16, x2 = World.pathX(z2);
  const y2 = groundAt(x2, z2) + 1.6;
  const dx = x2 - x, dy = y2 - cam.pos[1], dz = z2 - z;
  cam.yaw = Math.atan2(dx, dz) + Math.sin(tt * 0.4) * 0.12;
  cam.pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.9, 0.5);
}
function benchStep(dt, frameMs) {
  bench.t += dt;
  const total = BENCH.length * SCENE_DUR;
  const idx = clamp(Math.floor(Math.max(bench.t, 0) / SCENE_DUR), 0, BENCH.length - 1);
  if (idx !== bench.idx) applyBenchScene(idx);
  if (bench.t > 0 && frameMs != null) {
    bench.frames.push(frameMs);
    bench.perScene[idx].push(frameMs);
  }
  benchCamera();
  $('benchScene').textContent = bench.t < 0
    ? 'Warming up…'
    : `Scene ${idx + 1}/${BENCH.length} · ${BENCH[idx].name}`;
  $('benchProg').style.width = (clamp(bench.t / total, 0, 1) * 100).toFixed(1) + '%';
  if (bench.t >= total) finishBenchmark();
}
function stopBenchmark() {
  bench.running = false;
  rand = Math.random;
  $('benchBar').classList.add('hidden');
  document.body.classList.remove('benching');
  $('runBench').disabled = false;
  const s = bench.saved;
  if (s) {
    Object.assign(cam, s.cam);
    Object.assign(wt, s.wt);
    Object.assign(wx, s.wt);
    weatherName = s.weatherName;
    updateWeatherChips();
    syncUI();
  }
}
function fpsStats(ms) {
  const n = ms.length;
  if (!n) return { avg: 0, low1: 0, low01: 0, avgMs: 0, min: 0, max: 0 };
  const total = ms.reduce((a, b) => a + b, 0);
  const sorted = ms.slice().sort((a, b) => b - a);
  const worst = frac => {
    const c = Math.max(1, Math.ceil(n * frac));
    let s = 0;
    for (let i = 0; i < c; i++) s += sorted[i];
    return 1000 / (s / c);
  };
  return {
    avg: n / (total / 1000), low1: worst(0.01), low01: worst(0.001), avgMs: total / n,
    min: 1000 / sorted[0], max: 1000 / sorted[n - 1],
  };
}
function currentPresetName() {
  for (const k in PRESETS) if (QUALITY_KEYS.every(q => PRESETS[k][q] === S[q])) return PRESET_LABELS[k];
  return 'Custom';
}
function finishBenchmark() {
  const st = fpsStats(bench.frames);
  const per = bench.perScene.map(fpsStats);
  const frames = bench.frames.slice();
  stopBenchmark();
  const score = Math.round(st.avg * 100);
  const preset = currentPresetName();
  const res = `${RT.scene.w}×${RT.scene.h}`;

  $('rScore').innerHTML = `${score.toLocaleString()} <small>pts</small>`;
  $('rAvg').textContent = st.avg.toFixed(1);
  $('rLow1').textContent = st.low1.toFixed(1);
  $('rLow01').textContent = st.low01.toFixed(1);
  $('rMs').textContent = st.avgMs.toFixed(1) + ' ms';
  $('rScenes').innerHTML = BENCH.map((b, i) =>
    `<tr><td>${i + 1}. ${b.name}</td><td>${per[i].avg.toFixed(1)} fps · 1% ${per[i].low1.toFixed(1)}</td></tr>`).join('');
  $('rMeta').innerHTML =
    `Preset <b>${preset}</b> · render ${res} (${Math.round(S.renderScale * 100)}%, ${S.spp} ray/px) · ` +
    `${frames.length} frames · worst frame ${(1000 / st.min).toFixed(1)} ms<br>` +
    `${gpuName}<br>FPS is capped by your display refresh rate (vsync); scores near the cap mean the GPU has headroom.`;
  drawResultGraph(frames);

  let hist = [];
  try { hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) {}
  hist.unshift({ date: new Date().toISOString(), score, avg: +st.avg.toFixed(1), low1: +st.low1.toFixed(1), preset, res });
  hist = hist.slice(0, 8);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch (e) {}
  $('rHistory').innerHTML = hist.length > 1
    ? '<div style="color:var(--text);margin-bottom:4px">Recent runs</div>' + hist.map(h =>
      `<div><span>${new Date(h.date).toLocaleString()} · ${h.preset} · ${h.res}</span><span>${h.score} pts · ${h.avg} fps</span></div>`).join('')
    : '';

  lastResultText = `FOREST RT benchmark\nScore: ${score}\nAvg FPS: ${st.avg.toFixed(1)}  1% low: ${st.low1.toFixed(1)}  0.1% low: ${st.low01.toFixed(1)}\n` +
    `Avg frame time: ${st.avgMs.toFixed(2)} ms\nPreset: ${preset}  Render: ${res}  Rays/px: ${S.spp}\n` +
    BENCH.map((b, i) => `  ${b.name}: ${per[i].avg.toFixed(1)} fps`).join('\n') + `\nGPU: ${gpuName}`;
  $('results').classList.remove('hidden');
}
let lastResultText = '';

function drawResultGraph(frames) {
  const c = $('resGraph');
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!frames.length) return;
  const fps = frames.map(ms => 1000 / ms);
  const sm = [];
  for (let i = 0; i < fps.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - 4); j <= Math.min(fps.length - 1, i + 4); j++) { s += fps[j]; n++; }
    sm.push(s / n);
  }
  const maxF = Math.max(30, ...sm) * 1.1;
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.font = '20px ui-monospace, Menlo, monospace';
  g.lineWidth = 1;
  for (const v of [30, 60, 120, 240]) {
    if (v > maxF) break;
    const y = H - v / maxF * H;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.fillText(v + ' fps', 8, y - 6);
  }
  let cum = 0;
  const total = frames.reduce((a, b) => a + b, 0);
  g.beginPath();
  for (let i = 0; i < sm.length; i++) {
    const x = cum / total * W;
    cum += frames[i];
    const y = H - sm[i] / maxF * H;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.strokeStyle = '#7fd99a';
  g.lineWidth = 3;
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 2;
  for (let i = 1; i < BENCH.length; i++) {
    const x = i / BENCH.length * W;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
}

// ------------------------------------------------------------------ UI
const ctl = {};
function updatePresetChips() {
  const name = currentPresetName();
  document.querySelectorAll('#presetChips .chip').forEach(b => b.classList.toggle('active', b.textContent === name));
}
function updateWeatherChips() {
  document.querySelectorAll('#weatherChips .chip').forEach(b => b.classList.toggle('active', b.dataset.w === weatherName));
}
function applyPreset(key) {
  Object.assign(S, PRESETS[key]);
  syncUI();
  updatePresetChips();
  saveSettings();
}
function objFor(item) { return item.obj === 'w' ? wt : S; }

function makeControl(item) {
  const div = document.createElement('div');
  div.className = 'ctl';
  const obj = () => objFor(item);
  let input, val = null;
  if (item.type === 'toggle') {
    const lab = document.createElement('label');
    lab.className = 'toggle';
    lab.innerHTML = `<span>${item.label}</span>`;
    input = document.createElement('input');
    input.type = 'checkbox';
    const sw = document.createElement('span');
    sw.className = 'sw';
    lab.append(input, sw);
    div.append(lab);
    input.addEventListener('change', () => { obj()[item.k] = input.checked; onControlChange(item); });
  } else if (item.type === 'select') {
    div.innerHTML = `<div class="lab"><span>${item.label}</span></div>`;
    input = document.createElement('select');
    for (const [v, l] of item.options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      input.append(o);
    }
    div.append(input);
    input.addEventListener('change', () => {
      const v = input.value;
      obj()[item.k] = typeof DEFAULTS[item.k] === 'number' ? Number(v) : v;
      onControlChange(item);
    });
  } else {
    const lab = document.createElement('div');
    lab.className = 'lab';
    const name = document.createElement('span');
    name.textContent = item.label;
    val = document.createElement('span');
    lab.append(name, val);
    input = document.createElement('input');
    input.type = 'range';
    input.min = item.min; input.max = item.max; input.step = item.step;
    div.append(lab, input);
    input.addEventListener('input', () => {
      obj()[item.k] = parseFloat(input.value);
      val.textContent = item.fmt(obj()[item.k]);
      onControlChange(item);
    });
  }
  if (item.hint) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = item.hint;
    div.append(h);
  }
  ctl[item.k] = { item, input, val };
  return div;
}
function syncControl(k) {
  const c = ctl[k];
  if (!c) return;
  const v = objFor(c.item)[k];
  if (c.item.type === 'toggle') c.input.checked = !!v;
  else if (c.item.type === 'select') c.input.value = String(v);
  else {
    if (document.activeElement !== c.input) c.input.value = v;
    c.val.textContent = c.item.fmt(v);
  }
}
function syncUI() { for (const k in ctl) syncControl(k); }

function onControlChange(item) {
  if (item.obj === 'w') {
    // direct manipulation applies instantly; preset buttons blend
    wx[item.k] = wt[item.k];
    if (WEATHER_KEYS.includes(item.k) || item.k === 'tod') {
      weatherName = null;
      updateWeatherChips();
    }
    return;
  }
  if (QUALITY_KEYS.includes(item.k)) updatePresetChips();
  if (item.k === 'walk') updateModeBtn();
  saveSettings();
}

function buildUI() {
  const pc = $('presetChips');
  for (const k in PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = PRESET_LABELS[k];
    b.onclick = () => applyPreset(k);
    pc.append(b);
  }
  const wc = $('weatherChips');
  for (const k in WEATHER) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.w = k;
    b.textContent = WEATHER[k].label;
    b.onclick = () => setWeather(k, false);
    wc.append(b);
  }
  const groups = $('groups');
  for (const g of SCHEMA) {
    const d = document.createElement('details');
    if (g.open) d.open = true;
    const s = document.createElement('summary');
    s.textContent = g.group;
    d.append(s);
    for (const item of g.items) d.append(makeControl(item));
    groups.append(d);
  }
  $('runBench').onclick = startBenchmark;
  $('shotBtn').onclick = () => { wantShot = true; };
  $('resetCam').onclick = resetCamera;
  $('rClose').onclick = () => $('results').classList.add('hidden');
  $('rAgain').onclick = startBenchmark;
  $('rCopy').onclick = () => {
    const done = () => {
      $('rCopy').textContent = 'Copied ✓';
      setTimeout(() => { $('rCopy').textContent = 'Copy results'; }, 1500);
    };
    if (nativePost({ type: 'copy', text: lastResultText })) done();
    else navigator.clipboard?.writeText(lastResultText).then(done);
  };
  syncUI();
  updatePresetChips();
  updateWeatherChips();
}

let uiHidden = false;
function toggleUI() {
  uiHidden = !uiHidden;
  for (const id of ['panel', 'hud', 'help']) $(id).classList.toggle('hidden', uiHidden);
}

// The iOS app hosts this page in a WKWebView with a "native" message handler.
function nativePost(msg) {
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;
  if (!h) return false;
  h.postMessage(msg);
  return true;
}

// ------------------------------------------------------------------ input
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox'));
}
addEventListener('keydown', e => {
  if (isTyping(e)) return;
  if (e.code === 'Escape' && bench.running) { bench.saved && stopBenchmark(); return; }
  if (bench.running) return;
  keys.add(e.code);
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'KeyH') toggleUI();
  else if (e.code === 'KeyF') { S.walk = !S.walk; syncControl('walk'); updateModeBtn(); saveSettings(); }
  else if (e.code === 'KeyB') startBenchmark();
  else if (e.code === 'KeyP') wantShot = true;
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
canvas.addEventListener('click', () => {
  if (bench.running || isTouch) return;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  canvas.requestPointerLock?.();
});
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas || bench.running) return;
  const s = 0.0022 * S.sensitivity;
  cam.yaw -= e.movementX * s;
  cam.pitch = clamp(cam.pitch - e.movementY * s * (S.invertY ? -1 : 1), -1.5, 1.5);
});
canvas.addEventListener('wheel', e => {
  if (document.pointerLockElement !== canvas) return;
  S.moveSpeed = clamp(S.moveSpeed * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 60);
  syncControl('moveSpeed');
}, { passive: true });

// ------------------------------------------------------------------ touch
const isTouch = !!window.__FOREST_IOS__ || matchMedia('(pointer: coarse)').matches;
function setupTouch() {
  document.body.classList.add('touch');
  $('touch').classList.remove('hidden');

  // left: virtual joystick
  const stick = $('stick'), knob = $('knob');
  let stickId = null;
  const moveStick = e => {
    const r = stick.getBoundingClientRect();
    const R = r.width / 2;
    let dx = e.clientX - (r.left + R), dy = e.clientY - (r.top + R);
    const d = Math.hypot(dx, dy), max = R * 0.62;
    if (d > max) { dx *= max / d; dy *= max / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    touch.x = dx / max;
    touch.y = -dy / max;
  };
  const endStick = e => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    touch.x = touch.y = 0;
    knob.style.transform = '';
    stick.classList.remove('active');
  };
  stick.addEventListener('pointerdown', e => {
    stickId = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    stick.classList.add('active');
    moveStick(e);
    e.preventDefault();
  });
  stick.addEventListener('pointermove', e => { if (e.pointerId === stickId) moveStick(e); });
  stick.addEventListener('pointerup', endStick);
  stick.addEventListener('pointercancel', endStick);

  // right: hold-to-fly buttons (switch to fly mode on first press)
  const hold = (id, key) => {
    const b = $(id);
    const on = e => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      if (S.walk) { S.walk = false; syncControl('walk'); updateModeBtn(); saveSettings(); }
      touch[key] = true;
      b.classList.add('held');
    };
    const off = () => { touch[key] = false; b.classList.remove('held'); };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
    b.addEventListener('contextmenu', e => e.preventDefault());
  };
  hold('btnUp', 'up');
  hold('btnDown', 'down');

  // anywhere else on the canvas: drag to look (multi-touch safe)
  const looks = new Map();
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || bench.running) return;
    looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    const p = looks.get(e.pointerId);
    if (!p || bench.running) return;
    const s = 0.0045 * S.sensitivity;
    cam.yaw -= (e.clientX - p.x) * s;
    cam.pitch = clamp(cam.pitch - (e.clientY - p.y) * s * (S.invertY ? -1 : 1), -1.5, 1.5);
    p.x = e.clientX;
    p.y = e.clientY;
  });
  const endLook = e => looks.delete(e.pointerId);
  canvas.addEventListener('pointerup', endLook);
  canvas.addEventListener('pointercancel', endLook);

  // top bar
  $('btnMenu').onclick = () => document.body.classList.add('panel-open');
  $('panelClose').onclick = () => document.body.classList.remove('panel-open');
  $('btnHud').onclick = () => $('hud').classList.toggle('hidden');
  $('btnMode').onclick = () => { S.walk = !S.walk; syncControl('walk'); updateModeBtn(); saveSettings(); };
  updateModeBtn();
  document.addEventListener('gesturestart', e => e.preventDefault());
}
function updateModeBtn() {
  if (isTouch) $('btnMode').textContent = S.walk ? 'Walk' : 'Fly';
}

// ------------------------------------------------------------------ frame loop
const hud = { acc: 0, frames: 0, lastUpdate: 0, graph: new Float32Array(226), gi: 0 };
const graphCtx = $('graph').getContext('2d');
let wantShot = false;
let captureCb = null;
let slowFrames = 0;
const debug = { sync: false, px: new Uint8Array(4) };
let started = false;
const probe = { active: firstRun, frames: [], level: 0 };
let last = 0;
let simTime = 0;
let frameNo = 0;

function drawHudGraph() {
  const g = graphCtx, W = 452, H = 96;
  g.clearRect(0, 0, W, H);
  const n = hud.graph.length;
  let mx = 34;
  for (let i = 0; i < n; i++) mx = Math.max(mx, hud.graph[i]);
  mx = Math.min(mx * 1.1, 250);
  g.strokeStyle = 'rgba(255,255,255,0.1)';
  g.lineWidth = 1;
  for (const ms of [16.7, 33.3]) {
    const y = H - ms / mx * H;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  for (let i = 0; i < n; i++) {
    const v = hud.graph[(hud.gi + i) % n];
    if (!v) continue;
    const h = Math.min(H, v / mx * H);
    g.fillStyle = v > 33.4 ? '#f07a6a' : v > 16.8 ? '#f1b85b' : '#7fd99a';
    g.fillRect(i * 2, H - h, 1.6, h);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const rawMs = last ? now - last : null;
  last = now;
  const dt = rawMs == null ? 0 : Math.min(rawMs / 1000, 0.25);

  if (bench.running) {
    benchStep(dt, rawMs);
    if (!bench.running) return;
    simTime = 100 + Math.max(bench.t, 0);
  } else {
    simTime += dt;
    updateCamera(dt);
  }
  updateWeather(dt);
  updateLightning(dt);
  updateLight(dt);

  // sizes
  const dpr = S.hidpi ? (window.devicePixelRatio || 1) : 1;
  const W = Math.max(1, Math.floor(innerWidth * dpr)), H = Math.max(1, Math.floor(innerHeight * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const sw = Math.max(16, Math.round(W * S.renderScale)), sh = Math.max(16, Math.round(H * S.renderScale));
  ensureTargets(sw, sh);

  timerPoll();
  const q = timerBegin();
  gl.bindVertexArray(vao);

  // scene
  const sp = P.scene;
  gl.useProgram(sp.p);
  const b = camBasis();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_3D, noiseTex);
  set(sp, 'uNoise', 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, latticeTex);
  set(sp, 'uLattice', 1);
  set(sp, 'uRes', [sw, sh]);
  set(sp, 'uTime', simTime);
  set(sp, 'uCamPos', cam.pos);
  set(sp, 'uCamFwd', b.f);
  set(sp, 'uCamRight', b.r);
  set(sp, 'uCamUp', b.u);
  set(sp, 'uFovT', Math.tan(S.fov * Math.PI / 360));
  set(sp, 'uSunDir', light.sunDir);
  set(sp, 'uLightDir', light.dir);
  set(sp, 'uLightCol', light.col);
  set(sp, 'uFlash', bolt.flash);
  set(sp, 'uMaxSteps', S.maxSteps);
  set(sp, 'uDrawDist', S.drawDist);
  set(sp, 'uStepFactor', S.stepFactor);
  set(sp, 'uTerrainOct', S.terrainOct);
  set(sp, 'uFoliageDetail', S.foliageDetail);
  set(sp, 'uTreeDensity', S.treeDensity);
  set(sp, 'uSPP', S.spp);
  set(sp, 'uShadows', S.shadows);
  set(sp, 'uShadowSteps', S.shadowSteps);
  set(sp, 'uShadowSharp', S.shadowSharp);
  set(sp, 'uShadowDark', S.shadowDark);
  set(sp, 'uShadowDist', S.shadowDist);
  set(sp, 'uCloudShadows', S.cloudShadows);
  set(sp, 'uAOSamples', S.aoSamples);
  set(sp, 'uAOStrength', S.aoStrength);
  set(sp, 'uAmbient', S.ambient);
  set(sp, 'uSSS', S.sss);
  set(sp, 'uReflections', S.reflections);
  set(sp, 'uReflSteps', S.reflSteps);
  set(sp, 'uCloudSteps', S.cloudSteps);
  set(sp, 'uCloudLightSteps', S.cloudLightSteps);
  set(sp, 'uGodRaySteps', S.godRaySteps);
  set(sp, 'uGodRayStr', S.godRayStr);
  set(sp, 'uPrecipLayers', S.precipLayers);
  set(sp, 'uCloudCover', wx.cloudCover);
  set(sp, 'uCloudDensity', wx.cloudDensity);
  set(sp, 'uFog', wx.fog * S.fogMul);
  set(sp, 'uRain', wx.rain);
  set(sp, 'uSnow', wx.snow);
  set(sp, 'uSnowCover', wx.snowCover);
  set(sp, 'uWet', wx.wet);
  set(sp, 'uWind', wx.wind);
  set(sp, 'uAutumn', wx.autumn);
  set(sp, 'uStorm', light.storm);
  drawTo(RT.scene);

  // bloom: bright pass at 1/4, blur, then 1/16 and blur again
  if (S.bloom) {
    gl.useProgram(P.down.p);
    bindTex(0, RT.scene.tex, gl.LINEAR);
    set(P.down, 'uTex', 0);
    set(P.down, 'uTexel', [1 / RT.scene.w, 1 / RT.scene.h]);
    set(P.down, 'uThreshold', S.bloomThresh);
    drawTo(RT.b1a);
    gl.useProgram(P.blur.p);
    set(P.blur, 'uTex', 0);
    bindTex(0, RT.b1a.tex); set(P.blur, 'uDir', [1 / RT.b1a.w, 0]); drawTo(RT.b1b);
    bindTex(0, RT.b1b.tex); set(P.blur, 'uDir', [0, 1 / RT.b1a.h]); drawTo(RT.b1a);
    gl.useProgram(P.down.p);
    bindTex(0, RT.b1a.tex);
    set(P.down, 'uTexel', [1 / RT.b1a.w, 1 / RT.b1a.h]);
    set(P.down, 'uThreshold', -1);
    drawTo(RT.b2a);
    gl.useProgram(P.blur.p);
    bindTex(0, RT.b2a.tex); set(P.blur, 'uDir', [1 / RT.b2a.w, 0]); drawTo(RT.b2b);
    bindTex(0, RT.b2b.tex); set(P.blur, 'uDir', [0, 1 / RT.b2a.h]); drawTo(RT.b2a);
  }

  // composite
  const cp = P.comp;
  gl.useProgram(cp.p);
  bindTex(0, RT.scene.tex, S.upscale === 'nearest' ? gl.NEAREST : gl.LINEAR);
  bindTex(1, RT.b1a.tex);
  bindTex(2, RT.b2a.tex);
  set(cp, 'uScene', 0); set(cp, 'uBloom1', 1); set(cp, 'uBloom2', 2);
  set(cp, 'uSceneRes', [sw, sh]);
  set(cp, 'uOutRes', [W, H]);
  set(cp, 'uExposure', S.exposure * (S.autoExposure ? light.autoEV : 1));
  set(cp, 'uBloomOn', S.bloom);
  set(cp, 'uBloomStr', S.bloomStr);
  set(cp, 'uContrast', S.contrast);
  set(cp, 'uSat', S.saturation);
  set(cp, 'uVignette', S.vignette);
  set(cp, 'uCA', S.ca);
  set(cp, 'uGrain', S.grain);
  set(cp, 'uSharpen', S.sharpen);
  set(cp, 'uTime', simTime);
  set(cp, 'uTonemap', S.tonemap);
  set(cp, 'uDof', S.dof && hdr);
  set(cp, 'uFocus', S.focus);
  set(cp, 'uAperture', S.aperture);
  drawTo(null);
  timerEnd(q);
  if (debug.sync) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, debug.px);

  if (captureCb) {
    const cb = captureCb;
    captureCb = null;
    cb(canvas.toDataURL('image/jpeg', 0.88));
  }
  if (wantShot) {
    wantShot = false;
    if (nativePost({ type: 'shot', data: canvas.toDataURL('image/png') })) return;
    canvas.toBlob(blob => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `forest-rt-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  }

  // First launch: if the default preset is far too heavy for this GPU, step
  // down so the page stays responsive (and the browser doesn't kill the tab).
  if (probe.active && rawMs != null && !bench.running) {
    probe.frames.push(rawMs);
    if (probe.frames.length >= 12) {
      const avg = probe.frames.slice(4).reduce((a, b) => a + b, 0) / (probe.frames.length - 4);
      probe.frames = [];
      if (avg > 120 && probe.level === 0) { applyPreset('low'); probe.level = 1; }
      else if (avg > 120 && probe.level === 1) { S.renderScale = 0.35; syncUI(); saveSettings(); probe.active = false; }
      else probe.active = false;
    }
  }

  // Runaway settings (e.g. 200% scale + 4 rays/px on a laptop) can trip the
  // GPU watchdog and kill the tab; back off before that happens.
  // A single long gap (tab switch, compile hitch) doesn't count.
  slowFrames = rawMs > 2000 ? slowFrames + 1 : 0;
  if (slowFrames >= 3 && !bench.running && S.renderScale > 0.3) {
    slowFrames = 0;
    S.renderScale = Math.max(0.25, +(S.renderScale * 0.6).toFixed(2));
    syncControl('renderScale');
    updatePresetChips();
  }

  // HUD
  frameNo++;
  if (rawMs != null) {
    hud.acc += rawMs;
    hud.frames++;
    hud.graph[hud.gi] = rawMs;
    hud.gi = (hud.gi + 1) % hud.graph.length;
  }
  if (now - hud.lastUpdate > 250 && hud.frames) {
    const ms = hud.acc / hud.frames;
    $('fps').textContent = (1000 / ms).toFixed(ms > 100 ? 1 : 0);
    $('ms').textContent = ms.toFixed(2) + ' ms';
    $('gpums').textContent = timer.gpuMs != null ? timer.gpuMs.toFixed(2) + ' ms' : (extTimer ? '…' : 'n/a');
    $('res').textContent = `${sw}×${sh}${hdr ? '' : ' (LDR)'}`;
    $('rays').textContent = ((sw * sh * S.spp) / 1e6).toFixed(2) + ' M primary';
    $('pos').textContent = cam.pos.map(v => v.toFixed(0)).join(', ');
    if (wt.dayCycle > 0) syncControl('tod');
    drawHudGraph();
    hud.acc = 0; hud.frames = 0; hud.lastUpdate = now;
  }
}

// console access for tinkering: forestRT.S.maxSteps = 600, forestRT.setWeather('storm')
window.forestRT = { S, wt, wx, cam, setWeather, applyPreset, syncUI, timer, debug,
  capture: () => new Promise(r => { captureCb = r; }) };

// ------------------------------------------------------------------ boot
buildUI();
if (isTouch) setupTouch();
resetCamera();
updateLight(0);

const loadStart = performance.now();
function waitForShaders() {
  const progs = Object.values(P);
  if (!progs.every(programReady)) {
    $('loadMsg').textContent = `Compiling ray-marching shaders… ${((performance.now() - loadStart) / 1000).toFixed(1)} s`;
    requestAnimationFrame(waitForShaders);
    return;
  }
  try {
    for (const [name, prog] of Object.entries(P)) finalizeProgram(prog, name);
  } catch (err) {
    fatal(err.message);
    return;
  }
  started = true;
  $('loading').classList.add('hidden');
  requestAnimationFrame(frame);
}
requestAnimationFrame(waitForShaders);

})();
