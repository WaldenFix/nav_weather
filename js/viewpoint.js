// Viewpoints: will a summit or lookout be fogged in, above a sea of clouds, or
// clear with clouds rolling past? Answered hour by hour from the forecast's
// humidity at each pressure level (where the cloud layers are) compared with the
// spot's elevation, plus wind. Peaks and lookouts come from OpenStreetMap
// (Overpass); webcams from ALERTCalifornia's public camera list.

import { haversine } from './route.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const PHOTON = 'https://photon.komoot.io/api/';
const CAMERAS = 'https://cameras.alertcalifornia.org/public-camera-data/all_cameras-v3.json';
const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700];
const SATURATED = 94; // % relative humidity: inside cloud or fog
const HOURS = 36;
const MAX_KM = 30; // peaks searched within this of the crosshair
const MAX_SPOTS = 6;

// What you'd see from the spot. Order is best to worst for a timelapse.
export const VIEW_KINDS = {
  sea: { label: 'Above the clouds', score: 90 },
  rolling: { label: 'Clouds rolling over', score: 80 },
  skim: { label: 'Clouds just overhead', score: 70 },
  under: { label: 'Between cloud layers', score: 60 },
  clear: { label: 'Clear view', score: 50 },
  fog: { label: 'Fogged in', score: 10 },
  rain: { label: 'Rain', score: 5 },
};

// Peaks and lookouts near `center` with their forecasts: the highest peaks and the
// closest lookouts, at least 2.5 km apart, plus the crosshair itself.
export async function scanViews(center, radiusKm) {
  const km = Math.min(radiusKm, MAX_KM);
  const near = (p) => haversine([center.lon, center.lat], [p.lon, p.lat]);
  const found = (await Promise.all([fromOverpass(center, km), fromPhoton(center)])).flat()
    .filter((p) => near(p) <= km * 1000);

  // Thin to one per ~1.5 km, then forecast them all in one go (elevations come back too).
  const candidates = [];
  for (const p of found.sort((a, b) => (b.ele ?? 0) - (a.ele ?? 0))) {
    if (candidates.length >= 18) break;
    if (!candidates.some((c) => haversine([c.lon, c.lat], [p.lon, p.lat]) < 1500)) candidates.push(p);
  }
  const crosshair = { lat: center.lat, lon: center.lon, name: 'Crosshair', ele: null, kind: 'crosshair' };
  const spots = await viewForecast([crosshair, ...candidates]);

  const picked = [];
  const add = (s) => {
    if (picked.length < MAX_SPOTS && !picked.some((p) => haversine([p.lon, p.lat], [s.lon, s.lat]) < 2500)) picked.push(s);
  };
  const rest = spots.slice(1);
  rest.filter((s) => s.kind === 'peak').sort((a, b) => b.ele - a.ele).slice(0, 4).forEach(add);
  rest.filter((s) => s.kind === 'viewpoint').sort((a, b) => near(a) - near(b)).forEach(add);
  rest.sort((a, b) => b.ele - a.ele).forEach(add);
  if (!picked.some((p) => near(p) < 1500)) picked.push(spots[0]);
  return picked;
}

async function fromOverpass(center, km) {
  const at = `(around:${Math.round(km * 1000)},${center.lat.toFixed(4)},${center.lon.toFixed(4)})`;
  const query = `[out:json][timeout:8];(node["natural"="peak"]["name"]${at};node["tourism"="viewpoint"]["name"]${at};);out 200;`;
  try {
    const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(9000) });
    if (!res.ok) return [];
    return ((await res.json()).elements ?? []).map((n) => ({
      lat: n.lat,
      lon: n.lon,
      name: n.tags.name,
      ele: parseFloat(n.tags.ele) || null,
      kind: n.tags.natural === 'peak' ? 'peak' : 'viewpoint',
    }));
  } catch {
    return []; // Overpass is often busy; Photon below covers most named spots.
  }
}

// Photon needs some text to match, so ask for the words peaks and lookouts are named with.
async function fromPhoton(center) {
  // One at a time: Photon turns away bursts of parallel requests.
  const asks = [
    ['mount', 'natural:peak'], ['peak', 'natural:peak'],
    ['point', 'tourism:viewpoint'], ['vista', 'tourism:viewpoint'], ['overlook', 'tourism:viewpoint'],
  ];
  const found = [];
  let down = false; // if Photon isn't answering, don't wait on the rest
  for (const [q, tag] of asks) {
    if (down) break;
    found.push(await ask(q, tag));
  }
  return found.flat().filter((p) => p.name);

  function ask(q, tag) {
    const params = new URLSearchParams({ q, lat: center.lat.toFixed(3), lon: center.lon.toFixed(3), zoom: '11', location_bias_scale: '0.1', limit: '10', osm_tag: tag });
    return fetch(`${PHOTON}?${params}`, { signal: AbortSignal.timeout(6000) })
      .then((r) => r.json())
      .then((d) => d.features.map((f) => ({
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        name: f.properties.name,
        ele: null,
        kind: tag === 'natural:peak' ? 'peak' : 'viewpoint',
      })))
      .catch(() => {
        down = true;
        return [];
      });
  }
}

// Hour-by-hour view for each spot: { ...spot, ele, hours: [{ time, kind, gusts, ... }] }.
export async function viewForecast(spots) {
  const vars = [
    'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'visibility', 'precipitation',
    'wind_gusts_10m', 'wind_direction_10m', 'relative_humidity_2m', 'is_day', 'temperature_2m',
    ...LEVELS.flatMap((l) => [`relative_humidity_${l}hPa`, `geopotential_height_${l}hPa`]),
    'wind_speed_925hPa', 'wind_speed_850hPa', 'wind_speed_700hPa',
  ];
  const params = new URLSearchParams({
    latitude: spots.map((s) => s.lat.toFixed(4)).join(','),
    longitude: spots.map((s) => s.lon.toFixed(4)).join(','),
    hourly: vars.join(','),
    daily: 'sunrise,sunset',
    timeformat: 'unixtime',
    timezone: 'GMT',
    forecast_days: '3',
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`Viewpoint forecast failed (${res.status})`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];
  const now = Date.now() / 1000;

  return spots.map((s, k) => {
    const h = list[k].hourly;
    const ele = s.ele ?? list[k].elevation ?? 0;
    const hours = [];
    h.time.forEach((t, i) => {
      if (t < now - 3600 || t > now + HOURS * 3600) return;
      hours.push(classify(h, i, ele));
    });
    // Next to fogged-in hours, clouds are moving on or off the summit: the timelapse moment.
    hours.forEach((x, i) => {
      if (x.kind === 'fog' || x.kind === 'rain') return;
      if (hours[i - 1]?.kind === 'fog' || hours[i + 1]?.kind === 'fog') {
        x.kind = 'rolling';
        x.score = Math.max(x.score, VIEW_KINDS.rolling.score - (x.day ? 0 : 10));
      }
    });
    return { ...s, ele, hours, sunrise: list[k].daily?.sunrise ?? [] };
  });
}

function classify(h, i, ele) {
  const levels = LEVELS
    .map((l) => ({ z: h[`geopotential_height_${l}hPa`]?.[i], rh: h[`relative_humidity_${l}hPa`]?.[i] }))
    .filter((x) => x.z != null && x.rh != null)
    .sort((a, b) => a.z - b.z);
  const rhAt = (z) => interp(levels, z, 'rh') ?? h.relative_humidity_2m[i];
  const windAt = (z) => interp([
    { z: h['geopotential_height_925hPa']?.[i], v: h.wind_speed_925hPa?.[i] },
    { z: h['geopotential_height_850hPa']?.[i], v: h.wind_speed_850hPa?.[i] },
    { z: h['geopotential_height_700hPa']?.[i], v: h.wind_speed_700hPa?.[i] },
  ].filter((x) => x.z != null && x.v != null), z, 'v');

  const rh = rhAt(ele);
  const below = levels.some((x) => x.z > 0 && x.z < ele - 100 && x.rh >= SATURATED);
  const above = levels.some((x) => x.z > ele + 150 && x.z < ele + 2500 && x.rh >= SATURATED) || (h.cloud_cover_mid[i] ?? 0) >= 70;
  const skim = rhAt(ele + 250) >= SATURATED;
  const precip = h.precipitation[i] ?? 0;
  const day = h.is_day[i] === 1;

  let kind;
  if (precip >= 0.5) kind = 'rain';
  else if (rh >= SATURATED) kind = 'fog';
  else if (below && !above) kind = 'sea';
  else if (below) kind = 'under';
  else if (skim) kind = 'skim';
  else kind = 'clear';

  let score = VIEW_KINDS[kind].score;
  // A clear view is better with some cloud in the sky to give it shape.
  if (kind === 'clear' && (h.cloud_cover[i] ?? 0) >= 25 && (h.cloud_cover[i] ?? 0) <= 75) score += 10;
  // In the dark only city lights glowing under a fog deck really show up.
  if (!day && kind !== 'sea') score -= 15;

  const level = windAt(ele);
  // The model's 10 m gusts are for the grid cell (often lower ground); on an exposed
  // summit the free-air wind is a better guide.
  const gusts = Math.max(h.wind_gusts_10m[i] ?? 0, level != null ? level * 1.25 : 0);
  return {
    time: h.time[i],
    kind,
    score: Math.max(0, score),
    day,
    gusts,
    windFrom: h.wind_direction_10m[i],
    temp: h.temperature_2m[i],
    lowCloud: h.cloud_cover_low[i],
    visibility: h.visibility[i],
    rh,
  };
}

function interp(points, z, key) {
  if (!points.length) return null;
  if (z <= points[0].z) return points[0][key];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    if (z <= b.z) return a[key] + ((b[key] - a[key]) * (z - a.z)) / Math.max(b.z - a.z, 1);
  }
  return points[points.length - 1][key];
}

// The hour nearest `t`, and the best hour from `t` on (within `windowH` hours).
export function hourAt(spot, t) {
  return spot.hours.reduce((a, x) => (Math.abs(x.time - t) < Math.abs(a.time - t) ? x : a), spot.hours[0]);
}

export function bestHour(spot, from, windowH = 24) {
  const pool = spot.hours.filter((x) => x.time >= from - 1800 && x.time <= from + windowH * 3600);
  return pool.reduce((a, x) => (x.score > a.score ? x : a), pool[0] ?? spot.hours[0]);
}

// ---------------------------------------------------------------- webcams

let cameras;
async function cameraList() {
  cameras ??= fetch(CAMERAS, { signal: AbortSignal.timeout(15000) })
    .then((r) => (r.ok ? r.json() : { features: [] }))
    .then((d) => d.features.map((f) => ({
      id: f.properties.id,
      name: f.properties.name,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      ele: f.geometry.coordinates[2],
      look: f.properties.az_current,
    })))
    .catch(() => { cameras = null; return []; });
  return cameras;
}

// Live webcams within `km` of a spot, closest first. Covers California (plus a few
// other western states) through ALERTCalifornia's fire-watch cameras.
export async function nearbyCams(spot, km = 20, max = 4) {
  const list = await cameraList();
  return list
    .map((c) => ({ ...c, dist: haversine([spot.lon, spot.lat], [c.lon, c.lat]) }))
    .filter((c) => c.dist <= km * 1000)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max)
    .map((c) => ({
      ...c,
      thumb: `https://cameras.alertcalifornia.org/public-camera-data/${c.id}/latest-thumb.jpg`,
      full: `https://cameras.alertcalifornia.org/public-camera-data/${c.id}/latest-frame.jpg`,
    }));
}
