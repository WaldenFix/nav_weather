// Storm chaser helpers: scan a grid around a point for thunderstorm potential
// (Open-Meteo instability + precipitation forecasts) and load active US severe
// weather warnings from the National Weather Service (api.weather.gov).

import { haversine } from './route.js';
import { describe } from './wmo.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const NWS = 'https://api.weather.gov/alerts/active';
const GRID = 9; // GRID x GRID points
const VARS = ['cape', 'lifted_index', 'weather_code', 'precipitation_probability', 'precipitation', 'wind_gusts_10m'];

export const STORM_EVENTS = [
  'Tornado Warning',
  'Severe Thunderstorm Warning',
  'Tornado Watch',
  'Severe Thunderstorm Watch',
  'Flash Flood Warning',
];

// 0–100 chance-of-something-worth-chasing for one hour at one spot.
export function stormScore({ cape, li, code, pop, gusts }) {
  let s = Math.min((cape ?? 0) / 3000, 1) * 40;
  if (li != null && li < 0) s += Math.min(-li / 8, 1) * 20;
  if (code >= 95) s += 25;
  else if (code === 82) s += 10;
  s += ((pop ?? 0) / 100) * 10;
  s += Math.min(Math.max((gusts ?? 0) - 40, 0) / 60, 1) * 5;
  return Math.round(s);
}

export function stormLevel(score) {
  if (score >= 65) return { label: 'High', sev: 3 };
  if (score >= 40) return { label: 'Moderate', sev: 2 };
  if (score >= 20) return { label: 'Marginal', sev: 1 };
  return { label: 'Low', sev: 0 };
}

// Days of forecast needed to cover `hours` from `start` (unix s).
export function forecastDays(start, hours) {
  return String(Math.min(7, Math.ceil((start + hours * 3600 - Date.now() / 1000) / 86400) + 1));
}

// Peak storm potential over the `hours` after `start` (when you leave; default now)
// at each point of a grid centred on `center`.
export async function scanStorms(center, radiusKm, hours = 12, start = Date.now() / 1000) {
  const points = [];
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((center.lat * Math.PI) / 180));
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      points.push({
        lat: center.lat - dLat + (2 * dLat * i) / (GRID - 1),
        lon: center.lon - dLon + (2 * dLon * j) / (GRID - 1),
      });
    }
  }

  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(3)).join(','),
    longitude: points.map((p) => p.lon.toFixed(3)).join(','),
    hourly: VARS.join(','),
    timeformat: 'unixtime',
    timezone: 'GMT',
    forecast_days: forecastDays(start, hours),
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`Storm scan failed (${res.status})`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];

  return list.map(({ hourly: h }, k) => {
    let best = { score: -1 };
    const wind = { maxGusts: 0 };
    h.time.forEach((t, i) => {
      if (t < start - 3600 || t > start + hours * 3600) return;
      trackWind(wind, h, i);
      const hour = {
        time: t,
        cape: h.cape?.[i],
        li: h.lifted_index?.[i],
        code: h.weather_code[i],
        pop: h.precipitation_probability?.[i],
        precip: h.precipitation?.[i],
        gusts: h.wind_gusts_10m?.[i],
      };
      hour.score = stormScore(hour);
      if (hour.score > best.score) best = hour;
    });
    return { ...points[k], ...best, ...wind, ...describe(best.code), level: stormLevel(best.score) };
  });
}

// Strongest gust in the window, so a windstorm with no thunder doesn't go unmentioned.
export function trackWind(wind, h, i) {
  const g = h.wind_gusts_10m?.[i] ?? 0;
  if (g > wind.maxGusts) Object.assign(wind, { maxGusts: g, gustTime: h.time[i] });
}

// When there's no thunderstorm to show: the windiest spot, if it's a real windstorm
// (gusts of 60+ km/h / ~37 mph). Returns null on an ordinary day.
export function windstorm(cells) {
  const top = cells.reduce((a, c) => ((c.maxGusts ?? 0) > (a?.maxGusts ?? 0) ? c : a), null);
  return top && top.maxGusts >= 60 ? top : null;
}

// Every active NWS alert (any type: wind, surf, flood, winter…) covering any of the
// given points. Used to show what else is going on when there are no thunderstorms.
export async function fetchLocalAlerts(points) {
  const results = await Promise.allSettled(points.map((p) =>
    fetch(`${NWS}?point=${p.lat.toFixed(3)},${p.lon.toFixed(3)}`, { headers: { Accept: 'application/geo+json' } })
      .then((r) => (r.ok ? r.json() : { features: [] }))));
  const byId = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const f of r.value.features ?? []) byId.set(f.id, { event: f.properties.event, area: f.properties.areaDesc });
  }
  return [...byId.values()];
}

// A score nudged towards the places that matter to the driver (GPS position, start,
// destination): up to 30% off for things a whole scan-radius away from all of them.
export function nearBias(c, anchors, radiusKm) {
  if (!anchors?.length) return c.score;
  const km = Math.min(...anchors.map((a) => haversine([a.lon, a.lat], [c.lon, c.lat]))) / 1000;
  return c.score * (1 - 0.3 * Math.min(km / radiusKm, 1));
}

// The strongest cells, spread out so the list isn't five neighbours of one storm.
// Targets you can plausibly reach before the peak are listed first, and ones near
// the anchors (you, your start, your destination) are favoured.
export function pickTargets(cells, origin, radiusKm, { count = 5, anchors = [], start = Date.now() / 1000 } = {}) {
  const minGap = (radiusKm * 1000) / 3;
  const picked = [];
  const rank = (c) => nearBias(c, anchors, radiusKm);
  for (const c of [...cells].sort((a, b) => rank(b) - rank(a))) {
    if (c.score < 20) continue;
    if (picked.some((p) => haversine([p.lon, p.lat], [c.lon, c.lat]) < minGap)) continue;
    const dist = haversine([origin.lon, origin.lat], [c.lon, c.lat]);
    // Rough drive time: roads are ~25% longer than a straight line, at ~90 km/h.
    const eta = start + (dist * 1.25) / 25;
    picked.push({ ...c, dist, eta, reachable: eta <= c.time + 1800, bearing: compass(origin, c) });
    if (picked.length === count) break;
  }
  return picked.sort((a, b) => b.reachable - a.reachable || rank(b) - rank(a));
}

export function compass(a, b) {
  const y = Math.sin(((b.lon - a.lon) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180);
  const x = Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180)
    - Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lon - a.lon) * Math.PI) / 180);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

// Active NWS tornado / severe thunderstorm / flash flood alerts (US only).
// Warnings come with storm-based polygons for the map; watches are issued by
// county zone without geometry, so they're only returned in `alerts`.
export async function fetchWarnings() {
  const params = new URLSearchParams({ status: 'actual', event: STORM_EVENTS.join(',') });
  const res = await fetch(`${NWS}?${params}`, { headers: { Accept: 'application/geo+json' } });
  if (!res.ok) throw new Error(`NWS alerts unavailable (${res.status})`);
  const data = await res.json();
  const alerts = data.features.map((f) => ({
    type: 'Feature',
    geometry: f.geometry,
    properties: {
      event: f.properties.event,
      headline: f.properties.headline ?? f.properties.event,
      area: f.properties.areaDesc,
      ends: f.properties.ends ?? f.properties.expires,
      kind: f.properties.event.includes('Tornado') ? 'tornado' : f.properties.event.includes('Flood') ? 'flood' : 'severe',
    },
  }));
  return {
    alerts,
    polygons: { type: 'FeatureCollection', features: alerts.filter((f) => f.geometry) },
  };
}
