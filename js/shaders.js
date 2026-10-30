// GLSL sources for the forest raymarcher. Everything in the scene is a signed
// distance field: no meshes, no rasterised geometry. Each pixel marches a ray
// through terrain + trees, then marches again for shadows, AO, reflections,
// volumetric clouds and light shafts.

const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const SCENE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uCamPos, uCamFwd, uCamRight, uCamUp;
uniform float uFovT;
uniform sampler3D uNoise;
uniform highp sampler2D uLattice;

uniform vec3  uSunDir;
uniform vec3  uLightDir;
uniform vec3  uLightCol;
uniform float uFlash;

uniform int   uMaxSteps;
uniform float uDrawDist;
uniform float uStepFactor;
uniform int   uTerrainOct;
uniform int   uFoliageDetail;
uniform float uTreeDensity;
uniform int   uSPP;

uniform int   uShadows;
uniform int   uShadowSteps;
uniform float uShadowSharp;
uniform float uShadowDark;
uniform float uShadowDist;
uniform int   uCloudShadows;

uniform int   uAOSamples;
uniform float uAOStrength;
uniform float uAmbient;
uniform float uSSS;
uniform int   uReflections;
uniform int   uReflSteps;

uniform int   uCloudSteps;
uniform int   uCloudLightSteps;
uniform int   uGodRaySteps;
uniform float uGodRayStr;
uniform int   uPrecipLayers;

uniform float uCloudCover;
uniform float uCloudDensity;
uniform float uFog;
uniform float uRain;
uniform float uSnow;
uniform float uSnowCover;
uniform float uWet;
uniform float uWind;
uniform float uAutumn;
uniform float uStorm;

#define CELL 9.0
#define PI 3.14159265
#define CB 650.0
#define CT 1300.0
#define GEO_TOP 72.0

vec3 gAmb;
vec3 gBounce;

// ---------------------------------------------------------------- noise
uint ihash(uvec2 x){
  uvec2 q = 1103515245U * ((x >> 1U) ^ x.yx);
  return 1103515245U * (q.x ^ (q.y >> 3U));
}
float hashS(ivec2 i, uint s){
  return float(ihash(uvec2(i + 1048576) ^ uvec2(s * 0x9E3779B9U, s * 0x85EBCA6BU))) * (1.0 / 4294967296.0);
}
// Each texel of uLattice holds the 4 hashed corners of one lattice cell, so a
// value-noise octave is a single texelFetch (mirrored exactly on the CPU).
float noise2(vec2 p){
  vec2 fi = floor(p);
  vec2 f = p - fi;
  vec4 c = texelFetch(uLattice, ivec2(fi) & 255, 0);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(c.x, c.y, u.x), mix(c.z, c.w, u.x), u.y);
}
// smooth value noise via one hardware-filtered 3D texture fetch
float noise3(vec3 x){
  vec3 i = floor(x);
  vec3 f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(uNoise, (i + f + 0.5) / 64.0, 0.0).r;
}
float fbm3(vec3 p, int oct){
  float a = 0.0, b = 0.5;
  for(int i = 0; i < 8; i++){
    if(i >= oct) break;
    a += b * noise3(p);
    b *= 0.5;
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
  }
  return a;
}
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float HG(float mu, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}
float smin(float a, float b, float k){
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// ---------------------------------------------------------------- terrain
float pathX(float z){ return 28.0 * sin(z * 0.011) + 13.0 * sin(z * 0.027 + 1.3); }

float terrainH(vec2 p, int oct){
  vec2 q = p * 0.0028;
  float a = 0.0, b = 0.5;
  for(int i = 0; i < 14; i++){
    if(i >= oct) break;
    a += b * noise2(q);
    b *= 0.5;
    q = vec2(0.8 * q.x + 0.6 * q.y, -0.6 * q.x + 0.8 * q.y) * 2.02;
  }
  float h = (a - 0.45) * 85.0;
  float dp = abs(p.x - pathX(p.y));
  h -= 0.35 * smoothstep(3.0, 0.5, dp);
  return h;
}

vec3 terrainNormal(vec2 p, float t){
  float e = max(0.012, 0.0012 * t);
  int oct = clamp(uTerrainOct + 5 - int(t / 50.0), uTerrainOct, 13);
  float hx = terrainH(p + vec2(e, 0.0), oct) - terrainH(p - vec2(e, 0.0), oct);
  float hz = terrainH(p + vec2(0.0, e), oct) - terrainH(p - vec2(0.0, e), oct);
  return normalize(vec3(-hx, 2.0 * e, -hz));
}

// ---------------------------------------------------------------- trees
struct Tree { vec3 pos; float h; float r; float type; float seed; int kind; float rr; };

// One tree (or rock) per grid cell, fully contained inside the cell, so the
// distance to the cell border is a safe step bound for neighbouring trees.
Tree getTree(vec2 cell){
  Tree t;
  ivec2 ic = ivec2(cell);
  float h1 = hashS(ic, 1U), h2 = hashS(ic, 2U), h3 = hashS(ic, 3U), h4 = hashS(ic, 4U), h5 = hashS(ic, 5U);
  vec2 c = (cell + 0.5 + (vec2(h2, h3) - 0.5) * 0.22) * CELL;
  float dp = abs(c.x - pathX(c.y));
  t.seed = h5;
  t.type = step(0.62, h4);
  t.h = t.type < 0.5 ? mix(10.0, 19.0, h5) : mix(8.0, 13.0, h5);
  t.r = t.type < 0.5 ? min(t.h * 0.17, 2.7) : min(t.h * 0.22, 2.5);
  t.rr = 0.0;
  t.kind = 0;
  if(dp > 6.5 && h1 < uTreeDensity) t.kind = 1;
  else if(dp > 2.8 && h4 < 0.28){ t.kind = 2; t.rr = mix(0.5, 1.5, h5); }
  t.pos = vec3(c.x, 0.0, c.y);
  return t;
}

// cone with apex at origin opening downward to radius r at y = -h (exact SDF)
float sdConeY(vec3 p, float r, float h){
  vec2 q = vec2(r, -h);
  vec2 w = vec2(length(p.xz), p.y);
  vec2 a = w - q * clamp(dot(w, q) / dot(q, q), 0.0, 1.0);
  vec2 b = w - q * vec2(clamp(w.x / q.x, 0.0, 1.0), 1.0);
  float d = min(dot(a, a), dot(b, b));
  float s = max(-(w.x * q.y - w.y * q.x), -(w.y - q.y));
  return sqrt(d) * sign(s);
}

vec2 treeSDF(vec3 q, Tree tr, int detail){
  float hn = clamp(q.y / tr.h, 0.0, 1.0);
  float gust = sin(uTime * 1.3 + tr.seed * 40.0) + 0.5 * sin(uTime * 2.9 + tr.seed * 17.0);
  q.xz -= vec2(0.8, 0.6) * uWind * (0.22 + 0.12 * gust) * hn * hn;

  float tw = 0.16 + tr.h * 0.011;
  float trunkTop = tr.type < 0.5 ? tr.h * 0.88 : tr.h * 0.62;
  float dTrunk = max(length(q.xz) - tw * (1.0 - 0.55 * hn), max(q.y - trunkTop, -q.y - 1.0));

  float dLeaf;
  if(tr.type < 0.5){
    float y0 = tr.h * 0.22;
    float span = tr.h - y0;
    float bnd = max(length(q.xz) - tr.r - 0.5, max(y0 - 0.5 - q.y, q.y - tr.h - 0.5));
    dLeaf = bnd;
    if(bnd < 0.6){
      dLeaf = 1e5;
      for(int i = 0; i < 5; i++){
        float f = float(i) / 5.0;
        float bot = y0 + span * f * 0.8;
        float top = (i == 4) ? tr.h : bot + span * 0.4;
        float r = tr.r * (1.0 - f * 0.78);
        dLeaf = min(dLeaf, sdConeY(q - vec3(0.0, top, 0.0), r, top - bot));
      }
    }
  } else {
    float a = tr.seed * 6.2831;
    float ca = cos(a), sa = sin(a);
    vec3 r = vec3(ca * q.x - sa * q.z, q.y, sa * q.x + ca * q.z);
    float R = tr.r;
    float cy = tr.h * 0.62;
    float d1 = length(r - vec3(0.0, cy, 0.0)) - R;
    float d2 = length(r - vec3(0.42 * R, cy + 0.35 * R, 0.15 * R)) - 0.62 * R;
    float d3 = length(r - vec3(-0.36 * R, cy + 0.42 * R, -0.25 * R)) - 0.6 * R;
    float d4 = length(r - vec3(0.05 * R, cy - 0.3 * R, -0.42 * R)) - 0.58 * R;
    dLeaf = smin(smin(d1, d2, 0.8), smin(d3, d4, 0.8), 0.8);
  }

  if(detail > 0 && dLeaf < 0.8){
    vec3 nq = q + tr.seed * 17.0 + vec3(uTime * 0.25 * uWind, 0.0, 0.0);
    float amp = tr.type < 0.5 ? 1.0 : 1.3;
    float n = (noise3(nq * 1.7) - 0.5) * 0.7;
    if(detail > 1) n += (noise3(nq * 4.3) - 0.5) * 0.3;
    if(detail > 2) n += (noise3(nq * 10.7) - 0.5) * 0.12;
    dLeaf += n * amp;
  }
  return dTrunk < dLeaf ? vec2(dTrunk, 2.0) : vec2(dLeaf, tr.type < 0.5 ? 3.0 : 4.0);
}

float rockSDF(vec3 q, float r, float seed, int detail){
  float d = (length(q / vec3(r * 1.2, r * 0.7, r)) - 1.0) * r * 0.7;
  if(d < 0.6){
    d += (noise3(q * 1.3 + seed * 31.0) - 0.5) * 0.35 * r;
    if(detail > 1) d += (noise3(q * 4.1) - 0.5) * 0.12;
  }
  return d;
}

// Consecutive march steps mostly stay in one cell, so the tree (and the
// terrain height under it) is cached between map() calls.
Tree gTree;
vec2 gCell = vec2(1e9);
Tree cellTree(vec2 cell){
  if(cell != gCell){
    gCell = cell;
    gTree = getTree(cell);
    if(gTree.kind == 1) gTree.pos.y = terrainH(gTree.pos.xz, uTerrainOct) - 0.4;
    else if(gTree.kind == 2) gTree.pos.y = terrainH(gTree.pos.xz, uTerrainOct) - gTree.rr * 0.25;
  }
  return gTree;
}

// x: surface distance, y: material, z: 1 when inside the tree layer (the ray
// step must then also stop at the cell border, see cellExit)
// materials: 1 terrain, 2 bark, 3 pine needles, 4 broadleaf, 5 rock
vec3 map(vec3 p, int detail){
  float hp = terrainH(p.xz, uTerrainOct);
  float above = p.y - hp;
  float dS = above * 0.6;
  float mat = 1.0;
  if(above > 25.0) return vec3(dS, mat, 0.0);

  Tree tr = cellTree(floor(p.xz / CELL));
  if(tr.kind == 1){
    vec2 d = treeSDF(p - tr.pos, tr, detail);
    if(d.x < dS){ dS = d.x; mat = d.y; }
  } else if(tr.kind == 2){
    float d = rockSDF(p - tr.pos, tr.rr, tr.seed, detail);
    if(d < dS){ dS = d; mat = 5.0; }
  }
  return vec3(dS, mat, 1.0);
}

// Distance along the ray to the border of the current tree cell. Trees never
// cross their cell, so inside a cell only its own tree needs to be considered.
float cellExit(vec2 p, vec2 d){
  vec2 c = floor(p / CELL) * CELL;
  vec2 b = c + step(0.0, d) * CELL;
  vec2 t = abs(b - p) / max(abs(d), vec2(1e-6));
  return min(t.x, t.y) + 0.015;
}

float castRay(vec3 ro, vec3 rd, int maxSteps, float maxT, int detail, out float mat){
  float t = 0.02;
  mat = 1.0;
  for(int i = 0; i < 2048; i++){
    if(i >= maxSteps) break;
    vec3 p = ro + rd * t;
    if(p.y > GEO_TOP && rd.y >= 0.0) return -1.0;
    vec3 h = map(p, detail);
    mat = h.y;
    if(h.x < 0.0006 * t + 0.0015) return t;
    float st = h.x * uStepFactor;
    if(h.z > 0.5) st = min(st, cellExit(p.xz, rd.xz));
    t += st;
    if(t > maxT) return -1.0;
  }
  // out of steps: accept the closest point rather than punching a sky hole
  return t;
}

vec3 calcNormal(vec3 p, float t, int detail){
  float e = max(0.0015, 0.0005 * t);
  const vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * map(p + k.xyy * e, detail).x +
                   k.yyx * map(p + k.yyx * e, detail).x +
                   k.yxy * map(p + k.yxy * e, detail).x +
                   k.xxx * map(p + k.xxx * e, detail).x);
}

// ---------------------------------------------------------------- shadows / AO
float softShadow(vec3 ro, vec3 rd, int steps, float maxT, int detail){
  float res = 1.0;
  float t = 0.05;
  for(int i = 0; i < 512; i++){
    if(i >= steps) break;
    vec3 p = ro + rd * t;
    if(p.y > GEO_TOP) break;
    vec3 h = map(p, detail);
    res = min(res, uShadowSharp * h.x / t);
    float st = h.z > 0.5 ? min(h.x, cellExit(p.xz, rd.xz)) : h.x;
    t += clamp(st, 0.03, 4.0);
    if(res < 0.001 || t > maxT) break;
  }
  res = clamp(res, 0.0, 1.0);
  return res * res * (3.0 - 2.0 * res);
}

float calcAO(vec3 p, vec3 n){
  if(uAOSamples == 0) return 1.0;
  float occ = 0.0, sca = 1.0;
  float inv = 1.0 / float(max(uAOSamples - 1, 1));
  for(int i = 0; i < 32; i++){
    if(i >= uAOSamples) break;
    float f = float(i) * inv;
    float h = 0.04 + 2.6 * f * f;
    float d = map(p + n * h, 1).x;
    occ += max(h - d, 0.0) * sca;
    sca *= 0.78;
  }
  return clamp(1.0 - uAOStrength * occ * 0.45, 0.0, 1.0);
}

// ---------------------------------------------------------------- sky
vec3 skyColor(vec3 rd){
  float sy = uSunDir.y;
  float day = smoothstep(-0.12, 0.25, sy);
  vec3 zen = mix(vec3(0.003, 0.006, 0.018), vec3(0.09, 0.23, 0.6), day);
  vec3 hor = mix(vec3(0.01, 0.014, 0.028), vec3(0.55, 0.67, 0.84), day);
  float sd = max(dot(rd, uSunDir), 0.0);
  float sunset = smoothstep(0.32, 0.0, sy) * smoothstep(-0.18, 0.0, sy);
  hor = mix(hor, vec3(1.05, 0.42, 0.16), sunset * (0.3 + 0.7 * pow(sd, 2.5)));
  float y = clamp(rd.y, 0.0, 1.0);
  vec3 col = mix(hor, zen, pow(y, 0.5));
  col += vec3(1.0, 0.7, 0.45) * pow(sd, 10.0) * 0.5 * day;
  col += vec3(1.0, 0.6, 0.3) * pow(sd, 3.0) * 0.25 * sunset;
  if(rd.y < 0.0) col = mix(col, hor * 0.6, clamp(-rd.y * 3.0, 0.0, 1.0));
  vec3 grey = vec3(0.40, 0.43, 0.47) * mix(0.012, 0.9, day) * (1.0 - 0.55 * uStorm) * (0.8 + 0.2 * y);
  col = mix(col, grey, smoothstep(0.45, 1.0, uCloudCover));
  return col;
}

vec3 starField(vec3 rd){
  vec3 q = rd * 260.0;
  vec3 i = floor(q);
  vec3 f = q - i;
  float h = hashS(ivec2(i.xy) + ivec2(int(i.z) * 977, 0), 11U);
  float s = step(0.993, h) * smoothstep(0.35, 0.0, length(f - 0.5));
  return vec3(0.8, 0.85, 1.0) * s * (0.4 + 2.0 * fract(h * 91.7));
}

float cloudDens(vec3 p, int oct){
  float h = (p.y - CB) / (CT - CB);
  if(h < 0.0 || h > 1.0) return 0.0;
  vec3 q = p * 0.0011 + vec3(1.0, 0.1, 0.4) * uTime * (0.004 + 0.02 * uWind);
  float n = fbm3(q, oct);
  float shape = smoothstep(0.0, 0.1, h) * smoothstep(1.0, 0.35, h);
  float cov = mix(0.68, 0.22, uCloudCover);
  return smoothstep(cov, cov + 0.2, n * mix(0.65, 1.0, shape)) * shape * uCloudDensity;
}

vec4 renderClouds(vec3 ro, vec3 rd, float dither){
  if(rd.y < 0.015 || uCloudDensity <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float t0 = (CB - ro.y) / rd.y;
  float t1 = (CT - ro.y) / rd.y;
  float fade = exp(-t0 * 0.00012);
  vec3 amb = skyColor(vec3(0.0, 1.0, 0.0)) * 1.4 + uFlash * vec3(0.6, 0.65, 0.9) * 2.0;
  float mu = dot(rd, uLightDir);
  float ph = mix(HG(mu, 0.55), HG(mu, -0.25), 0.35) * 4.0 * PI;

  if(uCloudSteps == 0){
    vec3 p = ro + rd * (t0 + (t1 - t0) * 0.3);
    float d = cloudDens(vec3(p.x, CB + (CT - CB) * 0.3, p.z), 4);
    float a = 1.0 - exp(-d * 4.0);
    vec3 c = amb * 0.8 + uLightCol * 0.5 * ph;
    return vec4(c * a * fade, 1.0 - a * fade);
  }

  t1 = min(t1, t0 + 6000.0);
  float dt = (t1 - t0) / float(uCloudSteps);
  float t = t0 + dt * dither;
  vec3 acc = vec3(0.0);
  float T = 1.0;
  for(int i = 0; i < 256; i++){
    if(i >= uCloudSteps) break;
    vec3 p = ro + rd * t;
    float d = cloudDens(p, 5);
    if(d > 0.003){
      float hgt = (p.y - CB) / (CT - CB);
      float ext = d * 0.04;
      float lightT;
      if(uCloudLightSteps > 0){
        float ld = 0.0;
        for(int j = 0; j < 32; j++){
          if(j >= uCloudLightSteps) break;
          ld += cloudDens(p + uLightDir * (25.0 + 55.0 * float(j)), 3) * 55.0;
        }
        ld *= 0.04;
        lightT = max(exp(-ld), 0.6 * exp(-ld * 0.25));
      } else {
        lightT = exp(-d * 1.5);
      }
      float powder = 1.0 - exp(-ext * 120.0);
      vec3 S = uLightCol * lightT * ph * mix(0.5, 1.0, powder) + amb * (0.35 + 0.65 * hgt);
      float Tr = exp(-ext * dt);
      acc += T * S * (1.0 - Tr);
      T *= Tr;
      if(T < 0.01) break;
    }
    t += dt;
  }
  return vec4(acc * fade, mix(1.0, T, fade));
}

float cloudShadow(vec3 p){
  if(uCloudShadows == 0) return 1.0;
  float ly = max(uLightDir.y, 0.08);
  vec3 cp = p + uLightDir * ((CB + 200.0 - p.y) / ly);
  float d = cloudDens(cp, 3);
  return mix(1.0, exp(-d * 3.0), 0.85 * (1.0 - uCloudCover * 0.6));
}

// ---------------------------------------------------------------- fog
float expFog(float a, float b, vec3 ro, vec3 rd, float t){
  float base = a * exp(-ro.y * b);
  float k = rd.y * b;
  return abs(k * t) > 1e-4 ? base * (1.0 - exp(min(-k * t, 80.0))) / k : base * t;
}
float fogOD(vec3 ro, vec3 rd, float t){
  return expFog(uFog * exp(-8.0 * 0.035), 0.035, ro, rd, t) + expFog(0.00025, 0.0012, ro, rd, t);
}
vec3 fogColor(vec3 rd){
  vec3 c = skyColor(normalize(vec3(rd.x, 0.02, rd.z))) * 0.85;
  c += uFlash * vec3(0.5, 0.55, 0.8);
  if(uGodRaySteps == 0){
    float mu = max(dot(rd, uLightDir), 0.0);
    c += uLightCol * pow(mu, 6.0) * 0.25;
  }
  return c;
}

// Sunlight transmittance through tree crowns along a ray. Walks the tree grid
// cell by cell and tests analytic crown shapes (cone / sphere) with a little
// noise for leaf gaps: far cheaper than an SDF shadow march per shaft sample.
float crownVis(vec3 ro, vec3 rd){
  float vis = 1.0;
  float t = 0.0;
  for(int i = 0; i < 6; i++){
    vec3 p = ro + rd * t;
    if(p.y > GEO_TOP) break;
    float tExit = t + cellExit(p.xz, rd.xz);
    vec2 cell = floor(p.xz / CELL);
    ivec2 ic = ivec2(cell);
    if(hashS(ic, 1U) < uTreeDensity){
      Tree tr = getTree(cell);
      if(tr.kind == 1){
        float base = terrainH(tr.pos.xz, 3) - 0.4;
        float t1 = tExit;
        if(rd.y > 0.01) t1 = min(t1, (base + tr.h + 1.0 - ro.y) / rd.y);
        float leaf = 0.5 + 0.9 * noise3(p * 0.9 + tr.seed * 9.0);
        for(int j = 0; j < 2; j++){
          float ts = mix(t, t1, (float(j) + 0.5) * 0.5);
          vec3 q = ro + rd * ts - vec3(tr.pos.x, base, tr.pos.z);
          float dh = length(q.xz);
          float r = -1.0;
          if(tr.type < 0.5){
            float y0 = tr.h * 0.22;
            if(q.y > y0 && q.y < tr.h) r = tr.r * (1.0 - (q.y - y0) / (tr.h - y0)) * 1.05;
          } else {
            float dy = q.y - tr.h * 0.66;
            float R2 = tr.r * tr.r * 1.3 - dy * dy;
            if(R2 > 0.0) r = sqrt(R2);
          }
          if(r > 0.0) vis *= 1.0 - clamp(smoothstep(r + 0.3, r - 0.7, dh) * leaf, 0.0, 1.0) * 0.75;
        }
      }
    }
    t = tExit;
    if(t > 40.0 || vis < 0.03) break;
  }
  return vis;
}

vec3 godRays(vec3 ro, vec3 rd, float tEnd, float dither){
  if(uGodRaySteps == 0 || uGodRayStr <= 0.0 || max(uLightCol.r, uLightCol.g) < 0.04) return vec3(0.0);
  float maxD = min(tEnd, 120.0);
  float dt = maxD / float(uGodRaySteps);
  float mu = dot(rd, uLightDir);
  float ph = (HG(mu, 0.6) * 0.85 + 0.15 / (4.0 * PI)) * 4.0 * PI;
  float t = dt * dither;
  float acc = 0.0;
  for(int i = 0; i < 256; i++){
    if(i >= uGodRaySteps) break;
    vec3 p = ro + rd * t;
    float sigma = uFog * exp(-(p.y + 8.0) * 0.035) + 0.0025;
    acc += sigma * crownVis(p, uLightDir) * exp(-fogOD(ro, rd, t)) * dt;
    t += dt;
  }
  return uLightCol * acc * ph * 0.3 * uGodRayStr;
}

// ---------------------------------------------------------------- rain / snow
vec3 precipitation(vec3 rd, float sceneT){
  if(uPrecipLayers == 0 || (uRain < 0.01 && uSnow < 0.01)) return vec3(0.0);
  float az = atan(rd.x, rd.z);
  float hz = max(length(rd.xz), 0.08);
  float el = rd.y / hz;
  vec3 lightC = skyColor(vec3(0.0, 1.0, 0.0)) * 1.3 + uLightCol * 0.12 + uFlash * vec3(1.6);
  float pxA = 2.0 * uFovT / uRes.y;
  float accR = 0.0, accS = 0.0;
  for(int k = 0; k < 10; k++){
    if(k >= uPrecipLayers) break;
    float dist = 1.2 * pow(1.75, float(k));
    if(dist > sceneT) break;
    float pxm = dist * pxA;
    float xm = az * dist;
    float ym = el * dist;
    if(uRain > 0.01){
      float cw = 0.22;
      float slope = uWind * 0.3;
      float yy = ym + uTime * 9.0;
      float xx = xm + yy * slope;
      vec2 g = vec2(xx / cw, yy / 1.4);
      vec2 id = floor(g);
      vec2 f = g - id;
      float nC = floor(2.0 * PI * dist / cw);
      id.x = mod(id.x, nC);
      float h = hashS(ivec2(id) + ivec2(0, k * 7919), 9U);
      if(h < uRain * 0.6){
        float x0 = 0.2 + 0.6 * fract(h * 17.31);
        float y0 = fract(h * 31.7) * 0.5;
        float w = max(0.003, pxm * 0.7);
        float dx = abs(f.x - x0) * cw;
        float line = smoothstep(w, 0.0, dx) * min(1.0, 0.004 / w);
        float ly = (f.y - y0) * 1.4;
        float seg = smoothstep(0.0, 0.12, ly) * smoothstep(0.6, 0.25, ly);
        accR += line * seg * 0.55 / (1.0 + float(k) * 0.35);
      }
    }
    if(uSnow > 0.01){
      float cs = 0.5;
      float yy = ym + uTime * 1.1;
      float xx = xm + yy * uWind * 0.6;
      vec2 g = vec2(xx, yy) / cs;
      vec2 id = floor(g);
      vec2 f = g - id;
      float nC = floor(2.0 * PI * dist / cs);
      id.x = mod(id.x, nC);
      float h = hashS(ivec2(id) + ivec2(k * 3571, 0), 13U);
      if(h < uSnow * 0.8){
        vec2 c0 = vec2(0.2 + 0.6 * fract(h * 13.7), 0.2 + 0.6 * fract(h * 71.3));
        c0.x += sin(uTime * 1.3 + h * 40.0) * 0.12;
        float rad = max(0.012, pxm * 0.8);
        float r = length((f - c0) * cs);
        accS += smoothstep(rad, rad * 0.2, r) * min(1.0, 0.016 / rad) * 1.4 / (1.0 + float(k) * 0.25);
      }
    }
  }
  return lightC * (accR * 0.5 + accS);
}

// ---------------------------------------------------------------- shading
vec3 shadeSurface(vec3 p, vec3 n, vec3 rd, float mat, float t, bool primary, out float refl, out vec3 rn){
  vec3 L = uLightDir;
  vec3 alb = vec3(0.5);
  float rough = 0.85;
  float specW = 0.0;
  float sss = 0.0;
  float snowAmt = 0.0;
  refl = 0.0;
  rn = n;

  Tree tr = cellTree(floor(p.xz / CELL));
  float canopy = 0.0;
  if(tr.kind == 1){
    float base = tr.pos.y;
    float dd = length(p.xz - tr.pos.xz);
    canopy = smoothstep(tr.r * 1.6, tr.r * 0.3, dd) * (1.0 - smoothstep(base + tr.h * 0.4, base + tr.h, p.y));
  }

  if(mat < 1.5){
    float n1 = noise3(vec3(p.xz * 0.11, 0.5));
    float n2 = noise3(vec3(p.xz * 0.9, 3.5));
    float n3 = noise3(vec3(p.xz * 5.0, 7.5));
    vec3 grass = mix(vec3(0.06, 0.11, 0.025), vec3(0.16, 0.18, 0.045), n1);
    grass = mix(grass, vec3(0.2, 0.17, 0.07), smoothstep(0.6, 0.85, n2) * 0.6);
    grass *= 0.7 + 0.6 * n3;
    // close-range blade detail, faded out before it can alias
    float near = exp(-t * 0.06);
    if(near > 0.02){
      float g1 = noise3(vec3(p.x * 16.0, 1.3, p.z * 16.0));
      float g2 = noise3(vec3(p.x * 43.0, 5.1, p.z * 7.0));
      grass *= mix(1.0, 0.65 + 0.7 * (g1 * 0.55 + g2 * 0.45), near);
      n = normalize(n + vec3(g1 - 0.5, 0.0, g2 - 0.5) * 0.35 * near);
      rn = n;
    }
    vec3 litter = mix(vec3(0.1, 0.07, 0.035), vec3(0.17, 0.1, 0.035), n2);
    litter = mix(litter, mix(vec3(0.4, 0.12, 0.02), vec3(0.45, 0.3, 0.04), n3), uAutumn * smoothstep(0.3, 0.7, n2) * 0.8);
    litter *= 0.75 + 0.5 * n3;
    alb = mix(grass, litter, clamp(canopy * 1.3 + (n1 - 0.5) * 0.8, 0.0, 1.0));
    float dp = abs(p.x - pathX(p.z)) + (n2 - 0.5) * 1.4;
    float path = smoothstep(2.3, 1.2, dp);
    alb = mix(alb, vec3(0.16, 0.12, 0.085) * (0.75 + 0.5 * n3), path);
    alb = mix(alb, vec3(0.2, 0.19, 0.18) * (0.6 + 0.8 * n2), smoothstep(0.8, 0.62, n.y));
    snowAmt = uSnowCover * smoothstep(0.45, 0.8, n.y + (n2 - 0.5) * 0.35 - canopy * 0.25);
    float wet = uWet * (1.0 - snowAmt);
    float pud = wet * smoothstep(0.5, 0.58, n1 * 0.45 + n2 * 0.35 + path * 0.2) * smoothstep(0.94, 0.985, n.y);
    alb *= mix(1.0, 0.5, wet);
    rough = mix(0.9, 0.4, wet);
    specW = wet * 0.6;
    if(pud > 0.001){
      vec3 pn = vec3(0.0, 1.0, 0.0);
      if(uRain > 0.0){
        vec2 rp = p.xz * 3.0;
        float tt = uTime * 2.5;
        vec2 g = vec2(noise3(vec3(rp, tt)), noise3(vec3(rp + 17.0, tt))) - 0.5;
        pn = normalize(vec3(g.x * 0.3 * uRain, 1.0, g.y * 0.3 * uRain));
      }
      rn = normalize(mix(n, pn, pud));
      alb *= mix(1.0, 0.35, pud);
      rough = mix(rough, 0.03, pud);
      specW = mix(specW, 1.0, pud);
    }
    refl = wet * 0.15 + pud * 0.85;
  } else if(mat < 2.5){
    float b = noise3(vec3(p.x * 7.0, p.y * 0.7, p.z * 7.0));
    float b2 = noise3(p * 2.5);
    alb = vec3(0.12, 0.085, 0.06) * (0.45 + 0.9 * b) * (0.8 + 0.4 * b2);
    if(tr.type > 0.5) alb = mix(alb, vec3(0.2, 0.19, 0.17) * (0.6 + 0.6 * b), 0.5);
    float moss = smoothstep(0.2, 0.8, dot(n.xz, normalize(vec2(-0.7, 0.4))));
    alb = mix(alb, vec3(0.07, 0.11, 0.03), moss * 0.55 * (1.0 - uSnowCover));
    snowAmt = uSnowCover * smoothstep(0.35, 0.8, n.y);
    rough = 0.9;
    specW = uWet * 0.3;
    alb *= mix(1.0, 0.6, uWet);
  } else if(mat < 3.5){
    float v = noise3(p * 2.2);
    float v2 = noise3(p * 7.0);
    alb = vec3(0.022, 0.055, 0.028) * (0.55 + 0.9 * v) * (0.85 + 0.3 * tr.seed) * (0.8 + 0.4 * v2);
    sss = 0.55;
    rough = 0.6;
    specW = 0.15 + uWet * 0.4;
    snowAmt = uSnowCover * smoothstep(0.15, 0.6, n.y + (v - 0.5) * 0.5);
  } else if(mat < 4.5){
    float v = noise3(p * 1.8);
    float v2 = noise3(p * 6.0);
    vec3 green = mix(vec3(0.045, 0.1, 0.018), vec3(0.12, 0.17, 0.03), v);
    vec3 aut = mix(vec3(0.5, 0.1, 0.015), vec3(0.6, 0.38, 0.03), fract(tr.seed * 7.31));
    aut = mix(aut, vec3(0.32, 0.18, 0.03), v * 0.4);
    float a = clamp(uAutumn * (0.55 + 0.9 * fract(tr.seed * 3.17)) - (1.0 - v) * 0.15, 0.0, 1.0);
    alb = mix(green, aut, a) * (0.7 + 0.6 * v2);
    sss = 0.85;
    rough = 0.55;
    specW = 0.2 + uWet * 0.4;
    snowAmt = uSnowCover * smoothstep(0.35, 0.8, n.y) * 0.85;
  } else {
    float v = noise3(p * 1.4);
    float v2 = noise3(p * 5.0);
    alb = vec3(0.24, 0.23, 0.21) * (0.55 + 0.6 * v) * (0.85 + 0.3 * v2);
    alb = mix(alb, vec3(0.06, 0.1, 0.03), smoothstep(0.35, 0.85, n.y + (v - 0.5) * 0.4) * 0.75 * (1.0 - uSnowCover));
    snowAmt = uSnowCover * smoothstep(0.4, 0.8, n.y);
    alb *= mix(1.0, 0.55, uWet);
    rough = mix(0.75, 0.3, uWet);
    specW = 0.1 + uWet * 0.5;
    refl = uWet * 0.12;
  }
  if(snowAmt > 0.0){
    alb = mix(alb, vec3(0.82, 0.85, 0.9), snowAmt);
    rough = mix(rough, 0.5, snowAmt);
    specW = mix(specW, 0.25, snowAmt);
    sss = mix(sss, 0.25, snowAmt);
    refl *= 1.0 - snowAmt;
  }

  float ndl = dot(rn, L);
  float sh = 1.0;
  if(uShadows == 1 && (ndl > 0.0 || sss > 0.0) && dot(uLightCol, vec3(1.0)) > 0.001){
    int st = primary ? uShadowSteps : min(uShadowSteps, 24);
    sh = softShadow(p + n * 0.04, L, st, uShadowDist, min(uFoliageDetail, 2));
  }
  sh *= cloudShadow(p);
  float shadow = mix(1.0, sh, uShadowDark);
  float dif = sss > 0.0 ? clamp(ndl * 0.65 + 0.35, 0.0, 1.0) : max(ndl, 0.0);
  float ao = primary ? calcAO(p, n) : 0.75;
  float occl = ao * (1.0 - 0.5 * canopy);

  vec3 lin = uLightCol * dif * shadow;
  lin += gAmb * uAmbient * (0.6 + 0.4 * rn.y) * occl;
  lin += gBounce * (0.5 - 0.5 * rn.y) * occl;
  lin += uFlash * vec3(0.5, 0.55, 0.8) * (0.35 + 0.65 * clamp(rn.y, 0.0, 1.0)) * occl;
  vec3 col = alb * lin;

  if(sss > 0.0){
    float back = pow(clamp(dot(rd, L), 0.0, 1.0), 3.0);
    col += alb * uLightCol * (back * 2.5 + 0.15) * shadow * sss * uSSS;
  }
  if(specW > 0.0){
    vec3 hv = normalize(L - rd);
    float ndh = max(dot(rn, hv), 0.0);
    float a = rough * rough;
    float a2 = a * a;
    float dn = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dn * dn);
    float F = 0.04 + 0.96 * pow(1.0 - max(dot(-rd, hv), 0.0), 5.0);
    col += uLightCol * D * F * 0.25 * max(ndl, 0.0) * shadow * specW;
  }
  return col;
}

vec3 render(vec3 ro, vec3 rd, float dither, out float depth){
  float mat;
  float t = castRay(ro, rd, uMaxSteps, uDrawDist, uFoliageDetail, mat);
  vec3 col;
  float tf;
  vec3 fc = fogColor(rd);
  if(t < 0.0){
    depth = 4000.0;
    col = skyColor(rd);
    float night = 1.0 - smoothstep(-0.15, 0.05, uSunDir.y);
    if(rd.y > 0.0){
      float clear = 1.0 - smoothstep(0.55, 1.0, uCloudCover);
      col += starField(rd) * night * clear;
      col += vec3(0.9, 0.93, 1.0) * smoothstep(0.99955, 0.9998, dot(rd, -uSunDir)) * 2.5 * night * clear;
      col += vec3(1.0, 0.92, 0.8) * smoothstep(0.99965, 0.99985, dot(rd, uSunDir)) * 60.0 * (1.0 - night) * clear;
      vec4 cl = renderClouds(ro, rd, dither);
      col = col * cl.a + cl.rgb;
    }
    tf = 1500.0;
  } else {
    depth = t;
    vec3 p = ro + rd * t;
    vec3 n = mat < 1.5 ? terrainNormal(p.xz, t) : calcNormal(p, t, uFoliageDetail);
    float refl;
    vec3 rn;
    col = shadeSurface(p, n, rd, mat, t, true, refl, rn);
    if(refl > 0.01){
      vec3 rr = reflect(rd, rn);
      float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(-rd, rn), 0.0, 1.0), 5.0);
      vec3 rc;
      if(uReflections == 1){
        float m2;
        vec3 ro2 = p + n * 0.06;
        float t2 = castRay(ro2, rr, uReflSteps, uDrawDist * 0.6, min(uFoliageDetail, 1), m2);
        if(t2 < 0.0){
          rc = skyColor(rr);
        } else {
          vec3 p2 = ro2 + rr * t2;
          vec3 n2 = m2 < 1.5 ? terrainNormal(p2.xz, t2 + t) : calcNormal(p2, t2 + t, 1);
          float r2;
          vec3 rn2;
          rc = shadeSurface(p2, n2, rr, m2, t2, false, r2, rn2);
          rc = mix(fogColor(rr), rc, exp(-fogOD(ro2, rr, t2)));
        }
      } else {
        rc = mix(gAmb * 0.12, skyColor(rr), 0.35);
      }
      col = mix(col, rc, clamp(refl * (0.15 + 0.85 * fres), 0.0, 1.0));
    }
    tf = t;
  }
  col = mix(fc, col, exp(-fogOD(ro, rd, tf)));
  if(t > 0.0) col = mix(col, fc, smoothstep(uDrawDist * 0.7, uDrawDist, t));
  col += godRays(ro, rd, t < 0.0 ? 200.0 : t, dither);
  col += precipitation(rd, t < 0.0 ? 1e4 : t);
  return col;
}

void main(){
  gAmb = skyColor(vec3(0.0, 1.0, 0.0)) * 0.6 + skyColor(normalize(vec3(uLightDir.x, 0.15, uLightDir.z))) * 0.4;
  gBounce = vec3(0.1, 0.12, 0.05) * dot(uLightCol, vec3(0.333)) * 0.25;
  vec2 fc = gl_FragCoord.xy;
  float dither = ign(fc);
  vec3 tot = vec3(0.0);
  float depth = 0.0;
  for(int s = 0; s < 4; s++){
    if(s >= uSPP) break;
    vec2 off = uSPP > 1 ? fract(vec2(0.5) + float(s) * vec2(0.7548776662, 0.5698402910)) - 0.5 : vec2(0.0);
    vec2 uv = (2.0 * (fc + off) - uRes) / uRes.y;
    vec3 rd = normalize(uCamFwd + uv.x * uFovT * uCamRight + uv.y * uFovT * uCamUp);
    float d;
    vec3 c = render(uCamPos, rd, fract(dither + float(s) * 0.618034), d);
    tot += c;
    if(s == 0) depth = d;
  }
  tot /= float(uSPP);
  if(any(isnan(tot)) || any(isinf(tot))) tot = vec3(0.0);
  fragColor = vec4(clamp(tot, 0.0, 300.0), depth);
}`;

const DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold;
void main(){
  vec3 c = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  if(uThreshold >= 0.0){
    float l = max(c.r, max(c.g, c.b));
    float k = max(l - uThreshold, 0.0);
    c *= k / max(l, 1e-4);
  }
  o = vec4(min(c, vec3(100.0)), 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uDir;
void main(){
  vec3 c = texture(uTex, vUv).rgb * 0.2270270270;
  c += (texture(uTex, vUv + uDir * 1.3846153846).rgb + texture(uTex, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
  c += (texture(uTex, vUv + uDir * 3.2307692308).rgb + texture(uTex, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
  o = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uScene, uBloom1, uBloom2;
uniform vec2 uSceneRes, uOutRes;
uniform float uExposure, uBloomStr, uContrast, uSat, uVignette, uCA, uGrain, uSharpen, uTime;
uniform float uFocus, uAperture;
uniform int uTonemap, uDof, uBloomOn;

vec3 aces(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 u2(vec3 x){
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float coc(float d){ return clamp(abs(d - uFocus) / max(d, 0.1) * uAperture, 0.0, 1.0) * 14.0; }

void main(){
  vec2 uv = vUv;
  vec2 px = 1.0 / uSceneRes;
  vec2 dir = uv - 0.5;
  vec3 col;
  if(uCA > 0.0){
    vec2 off = dir * uCA * 0.012;
    col = vec3(texture(uScene, uv + off).r, texture(uScene, uv).g, texture(uScene, uv - off).b);
  } else {
    col = texture(uScene, uv).rgb;
  }
  if(uSharpen > 0.0){
    vec3 nb = texture(uScene, uv + vec2(px.x, 0.0)).rgb + texture(uScene, uv - vec2(px.x, 0.0)).rgb
            + texture(uScene, uv + vec2(0.0, px.y)).rgb + texture(uScene, uv - vec2(0.0, px.y)).rgb;
    col = max(col + (col * 4.0 - nb) * uSharpen * 0.25, 0.0);
  }
  if(uDof == 1){
    float d = texture(uScene, uv).a;
    float c0 = coc(d);
    if(c0 > 0.5){
      vec3 acc = vec3(0.0);
      float ws = 0.0;
      for(int i = 0; i < 32; i++){
        float r = sqrt((float(i) + 0.5) / 32.0) * c0;
        float a = float(i) * 2.39996;
        vec4 s = texture(uScene, uv + vec2(cos(a), sin(a)) * r * px);
        float w = clamp(coc(s.a) - r + 1.0, 0.0, 1.0);
        acc += s.rgb * w;
        ws += w;
      }
      if(ws > 0.001) col = mix(col, acc / ws, smoothstep(0.5, 2.0, c0));
    }
  }
  if(uBloomOn == 1) col += (texture(uBloom1, uv).rgb + texture(uBloom2, uv).rgb * 1.3) * uBloomStr;
  col *= uExposure;
  if(uTonemap == 0) col = aces(col);
  else if(uTonemap == 1) col = clamp(u2(col * 2.0) / u2(vec3(11.2)), 0.0, 1.0);
  else if(uTonemap == 2) col = col / (1.0 + col);
  else col = clamp(col, 0.0, 1.0);
  col = pow(col, vec3(1.0 / 2.2));
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  col = (col - 0.5) * uContrast + 0.5;
  col *= 1.0 - uVignette * smoothstep(0.2, 0.9, length(dir * vec2(uOutRes.x / uOutRes.y, 1.0)));
  col += (hash(uv * uOutRes + fract(uTime * 7.13) * 100.0) - 0.5) * uGrain * 0.12;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
