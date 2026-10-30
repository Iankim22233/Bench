// Graphics settings schema, quality presets and weather presets.

const pct = v => Math.round(v * 100) + '%';
const fx = n => v => Number(v).toFixed(n);

const QUALITY_KEYS = [
  'renderScale', 'spp', 'maxSteps', 'drawDist', 'stepFactor', 'terrainOct', 'foliageDetail',
  'shadows', 'shadowSteps', 'shadowDist', 'cloudShadows', 'aoSamples', 'reflections', 'reflSteps',
  'cloudSteps', 'cloudLightSteps', 'godRaySteps', 'precipLayers', 'bloom', 'dof',
];

const PRESETS = {
  low: {
    renderScale: 0.5, spp: 1, maxSteps: 110, drawDist: 260, stepFactor: 0.95, terrainOct: 4, foliageDetail: 0,
    shadows: true, shadowSteps: 16, shadowDist: 35, cloudShadows: false, aoSamples: 0, reflections: false, reflSteps: 32,
    cloudSteps: 0, cloudLightSteps: 0, godRaySteps: 0, precipLayers: 3, bloom: true, dof: false,
  },
  medium: {
    renderScale: 0.75, spp: 1, maxSteps: 180, drawDist: 400, stepFactor: 0.85, terrainOct: 5, foliageDetail: 1,
    shadows: true, shadowSteps: 28, shadowDist: 50, cloudShadows: true, aoSamples: 3, reflections: false, reflSteps: 48,
    cloudSteps: 24, cloudLightSteps: 2, godRaySteps: 0, precipLayers: 4, bloom: true, dof: false,
  },
  high: {
    renderScale: 1.0, spp: 1, maxSteps: 260, drawDist: 600, stepFactor: 0.8, terrainOct: 6, foliageDetail: 2,
    shadows: true, shadowSteps: 48, shadowDist: 70, cloudShadows: true, aoSamples: 5, reflections: true, reflSteps: 64,
    cloudSteps: 48, cloudLightSteps: 4, godRaySteps: 16, precipLayers: 5, bloom: true, dof: false,
  },
  ultra: {
    renderScale: 1.0, spp: 1, maxSteps: 360, drawDist: 850, stepFactor: 0.75, terrainOct: 7, foliageDetail: 3,
    shadows: true, shadowSteps: 80, shadowDist: 100, cloudShadows: true, aoSamples: 7, reflections: true, reflSteps: 96,
    cloudSteps: 72, cloudLightSteps: 6, godRaySteps: 32, precipLayers: 6, bloom: true, dof: false,
  },
  extreme: {
    renderScale: 1.25, spp: 2, maxSteps: 512, drawDist: 1200, stepFactor: 0.65, terrainOct: 8, foliageDetail: 3,
    shadows: true, shadowSteps: 128, shadowDist: 150, cloudShadows: true, aoSamples: 10, reflections: true, reflSteps: 160,
    cloudSteps: 128, cloudLightSteps: 10, godRaySteps: 64, precipLayers: 8, bloom: true, dof: false,
  },
};
const PRESET_LABELS = { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra', extreme: 'Extreme' };

const DEFAULTS = Object.assign({}, PRESETS.medium, {
  hidpi: false, fov: 70, upscale: 'linear',
  treeDensity: 0.72,
  shadowSharp: 18, shadowDark: 0.92,
  aoStrength: 1.0, sunIntensity: 1.0, ambient: 1.0, sss: 1.0,
  godRayStr: 1.0, fogMul: 1.0, autoExposure: true,
  exposure: 1.0, tonemap: 0, bloomStr: 0.55, bloomThresh: 1.2, contrast: 1.05, saturation: 1.1,
  vignette: 0.35, ca: 0.08, grain: 0.15, sharpen: 0.25, focus: 15, aperture: 0.5,
  walk: true, moveSpeed: 6, sensitivity: 1.0, invertY: false,
});

// Weather values are interpolated over ~1.5 s when switching presets.
const WEATHER = {
  clear:    { label: 'Clear',      tod: 11.0, cloudCover: 0.25, cloudDensity: 1.0, fog: 0.0008, rain: 0, snow: 0, snowCover: 0, wet: 0,    wind: 0.2,  lightning: 0 },
  golden:   { label: 'Golden hr',  tod: 18.4, cloudCover: 0.35, cloudDensity: 1.0, fog: 0.003,  rain: 0, snow: 0, snowCover: 0, wet: 0,    wind: 0.15, lightning: 0 },
  overcast: { label: 'Overcast',   tod: 12.5, cloudCover: 0.9,  cloudDensity: 1.0, fog: 0.005,  rain: 0, snow: 0, snowCover: 0, wet: 0.2,  wind: 0.4,  lightning: 0 },
  fog:      { label: 'Fog',        tod: 7.6,  cloudCover: 0.4,  cloudDensity: 0.8, fog: 0.024,  rain: 0, snow: 0, snowCover: 0, wet: 0.3,  wind: 0.05, lightning: 0 },
  rain:     { label: 'Rain',       tod: 14.0, cloudCover: 0.95, cloudDensity: 1.0, fog: 0.01,   rain: 0.8, snow: 0, snowCover: 0, wet: 1.0, wind: 0.6, lightning: 0 },
  storm:    { label: 'Storm',      tod: 16.0, cloudCover: 1.0,  cloudDensity: 1.2, fog: 0.014,  rain: 1.0, snow: 0, snowCover: 0, wet: 1.0, wind: 1.0, lightning: 1 },
  snow:     { label: 'Snow',       tod: 11.5, cloudCover: 0.85, cloudDensity: 1.0, fog: 0.012,  rain: 0, snow: 0.8, snowCover: 1.0, wet: 0, wind: 0.3, lightning: 0 },
  night:    { label: 'Night',      tod: 23.0, cloudCover: 0.2,  cloudDensity: 1.0, fog: 0.004,  rain: 0, snow: 0, snowCover: 0, wet: 0,    wind: 0.15, lightning: 0 },
};
const WEATHER_KEYS = ['cloudCover', 'cloudDensity', 'fog', 'rain', 'snow', 'snowCover', 'wet', 'wind', 'lightning'];

// UI schema. `obj: 'w'` binds to the weather target instead of graphics settings.
const SCHEMA = [
  { group: 'Weather & time', open: true, items: [
    { k: 'tod', obj: 'w', label: 'Time of day', min: 0, max: 24, step: 0.05,
      fmt: v => { const h = Math.floor(v) % 24, m = Math.floor((v % 1) * 60); return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); } },
    { k: 'dayCycle', obj: 'w', label: 'Day cycle speed', min: 0, max: 2, step: 0.01, fmt: v => v.toFixed(2) + ' h/s' },
    { k: 'cloudCover', obj: 'w', label: 'Cloud cover', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'cloudDensity', obj: 'w', label: 'Cloud density', min: 0, max: 2, step: 0.01, fmt: fx(2) },
    { k: 'fog', obj: 'w', label: 'Fog density', min: 0, max: 0.06, step: 0.0005, fmt: fx(4) },
    { k: 'rain', obj: 'w', label: 'Rain', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'snow', obj: 'w', label: 'Snowfall', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'snowCover', obj: 'w', label: 'Snow on ground', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'wet', obj: 'w', label: 'Wetness / puddles', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'wind', obj: 'w', label: 'Wind', min: 0, max: 1.5, step: 0.01, fmt: fx(2) },
    { k: 'lightning', obj: 'w', label: 'Lightning', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'autumn', obj: 'w', label: 'Autumn foliage', min: 0, max: 1, step: 0.01, fmt: pct },
  ]},
  { group: 'Display & resolution', items: [
    { k: 'renderScale', label: 'Render scale', min: 0.25, max: 2, step: 0.05, fmt: pct, hint: 'Internal resolution. >100% = supersampling' },
    { k: 'hidpi', type: 'toggle', label: 'HiDPI / Retina output' },
    { k: 'spp', label: 'Rays per pixel (SSAA)', min: 1, max: 4, step: 1, fmt: v => v + '×' },
    { k: 'upscale', type: 'select', label: 'Upscale filter', options: [['linear', 'Bilinear'], ['nearest', 'Nearest (pixelated)']] },
    { k: 'fov', label: 'Field of view', min: 40, max: 110, step: 1, fmt: v => v + '°' },
  ]},
  { group: 'Ray marching', items: [
    { k: 'maxSteps', label: 'Max primary ray steps', min: 32, max: 1024, step: 8, fmt: v => v },
    { k: 'drawDist', label: 'Draw distance', min: 100, max: 2000, step: 10, fmt: v => v + ' m' },
    { k: 'stepFactor', label: 'Step size', min: 0.35, max: 1.0, step: 0.05, fmt: fx(2), hint: 'Lower = more precise, slower' },
    { k: 'terrainOct', label: 'Terrain detail (octaves)', min: 2, max: 9, step: 1, fmt: v => v },
    { k: 'foliageDetail', label: 'Foliage detail', min: 0, max: 3, step: 1, fmt: v => ['Smooth', 'Low', 'High', 'Ultra'][v] },
    { k: 'treeDensity', label: 'Tree density', min: 0, max: 1, step: 0.01, fmt: pct },
  ]},
  { group: 'Shadows', items: [
    { k: 'shadows', type: 'toggle', label: 'Ray-traced shadows' },
    { k: 'shadowDark', label: 'Shadow darkness', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'shadowSharp', label: 'Shadow sharpness', min: 1, max: 128, step: 1, fmt: v => v, hint: 'Penumbra size: low = soft, high = crisp' },
    { k: 'shadowSteps', label: 'Shadow ray steps', min: 4, max: 256, step: 2, fmt: v => v },
    { k: 'shadowDist', label: 'Shadow distance', min: 10, max: 300, step: 5, fmt: v => v + ' m' },
    { k: 'cloudShadows', type: 'toggle', label: 'Cloud shadows' },
  ]},
  { group: 'Lighting', items: [
    { k: 'sunIntensity', label: 'Sun / moon intensity', min: 0, max: 3, step: 0.01, fmt: fx(2) },
    { k: 'ambient', label: 'Ambient (sky) light', min: 0, max: 3, step: 0.01, fmt: fx(2) },
    { k: 'aoSamples', label: 'Ambient occlusion samples', min: 0, max: 24, step: 1, fmt: v => v || 'Off' },
    { k: 'aoStrength', label: 'AO strength', min: 0, max: 3, step: 0.01, fmt: fx(2) },
    { k: 'sss', label: 'Leaf translucency', min: 0, max: 2, step: 0.01, fmt: fx(2) },
    { k: 'reflections', type: 'toggle', label: 'Ray-traced reflections' },
    { k: 'reflSteps', label: 'Reflection ray steps', min: 16, max: 384, step: 8, fmt: v => v },
  ]},
  { group: 'Atmosphere', items: [
    { k: 'cloudSteps', label: 'Volumetric cloud steps', min: 0, max: 256, step: 4, fmt: v => v || '2D' },
    { k: 'cloudLightSteps', label: 'Cloud light samples', min: 0, max: 24, step: 1, fmt: v => v },
    { k: 'godRaySteps', label: 'Volumetric light shafts', min: 0, max: 192, step: 4, fmt: v => v || 'Off' },
    { k: 'godRayStr', label: 'Light shaft intensity', min: 0, max: 4, step: 0.01, fmt: fx(2) },
    { k: 'fogMul', label: 'Fog multiplier', min: 0, max: 4, step: 0.01, fmt: fx(2) },
    { k: 'precipLayers', label: 'Rain/snow particle layers', min: 0, max: 10, step: 1, fmt: v => v || 'Off' },
  ]},
  { group: 'Camera & post', items: [
    { k: 'autoExposure', type: 'toggle', label: 'Auto exposure' },
    { k: 'exposure', label: 'Exposure', min: 0.1, max: 5, step: 0.01, fmt: fx(2) },
    { k: 'tonemap', type: 'select', label: 'Tone mapper', options: [[0, 'ACES'], [1, 'Filmic (Uncharted 2)'], [2, 'Reinhard'], [3, 'None (clip)']] },
    { k: 'bloom', type: 'toggle', label: 'Bloom' },
    { k: 'bloomStr', label: 'Bloom strength', min: 0, max: 2, step: 0.01, fmt: fx(2) },
    { k: 'bloomThresh', label: 'Bloom threshold', min: 0, max: 5, step: 0.05, fmt: fx(2) },
    { k: 'contrast', label: 'Contrast', min: 0.5, max: 1.6, step: 0.01, fmt: fx(2) },
    { k: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, fmt: fx(2) },
    { k: 'sharpen', label: 'Sharpen', min: 0, max: 1.5, step: 0.01, fmt: fx(2) },
    { k: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, fmt: fx(2) },
    { k: 'ca', label: 'Chromatic aberration', min: 0, max: 1.5, step: 0.01, fmt: fx(2) },
    { k: 'grain', label: 'Film grain', min: 0, max: 1, step: 0.01, fmt: fx(2) },
    { k: 'dof', type: 'toggle', label: 'Depth of field' },
    { k: 'focus', label: 'Focus distance', min: 1, max: 150, step: 0.5, fmt: v => v + ' m' },
    { k: 'aperture', label: 'Aperture (blur)', min: 0, max: 2, step: 0.01, fmt: fx(2) },
  ]},
  { group: 'Controls', items: [
    { k: 'walk', type: 'toggle', label: 'Walk mode (ground-locked)' },
    { k: 'moveSpeed', label: 'Move speed', min: 1, max: 60, step: 0.5, fmt: v => v + ' m/s' },
    { k: 'sensitivity', label: 'Mouse sensitivity', min: 0.1, max: 3, step: 0.05, fmt: fx(2) },
    { k: 'invertY', type: 'toggle', label: 'Invert mouse Y' },
  ]},
];
