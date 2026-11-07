// Coastal storm watching: big surf and strong wind, like a Pacific Northwest blow.
// Wave forecasts come from the Open-Meteo Marine API; named lookouts (lighthouses,
// beach parks, beaches) from Photon / OpenStreetMap.

import { haversine } from './route.js';
import { stormLevel, nearBias } from './storm.js';
import { grid } from './watch.js';

const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const API = 'https://api.open-meteo.com/v1/forecast';
const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const MAX_SITES = 3;

// 0–100: how good the show is at one stretch of sea for one hour.
export function waveScore({ height, period, gusts, day, precip }) {
  let s = Math.min((height ?? 0) / 7, 1) * 50;
  s += Math.min(Math.max((period ?? 0) - 6, 0) / 10, 1) * 15;
  s += Math.min(Math.max((gusts ?? 0) - 30, 0) / 60, 1) * 25;
  if (day) s += 10;
  else s *= 0.5; // hard to see waves in the dark
  if ((precip ?? 0) > 4) s -= 5; // sheets of rain hide the view
  return Math.max(0, Math.round(s));
}

// Returns { cells, spots }: wave sites with their peak score (for the map) and the
// best lookouts on shore, each with when to be there and what to expect.
export async function scanCoast(center, radiusKm, { anchors = [], origin = center, hours = 36 } = {}) {
  // The marine API answers each point with the nearest sea grid cell, so a point on
  // land gets the sea just off the nearest coast: exactly where you'd stand to watch.
  // Points out at sea are skipped (nobody can watch waves 100 km offshore), as are
  // points so far inland that the "nearest coast" is a long way off.
  const pts = grid(center, radiusKm, 9);
  const [marine, elevation] = await Promise.all([getJSON(MARINE, pts, ['wave_height', 'wave_period']), elevations(pts)]);
  const sites = new Map();
  marine.forEach((m, k) => {
    if (!m?.hourly?.wave_height?.some((h) => h != null) || !(elevation[k] > 0)) return;
    if (haversine([pts[k].lon, pts[k].lat], [m.longitude, m.latitude]) > 80000) return;
    const key = `${m.latitude.toFixed(2)},${m.longitude.toFixed(2)}`;
    if (!sites.has(key)) sites.set(key, { lat: m.latitude, lon: m.longitude, sea: m.hourly });
  });
  if (!sites.size) return { cells: [], spots: [], noCoast: true };

  const list = [...sites.values()];
  const weather = await getJSON(API, list, ['wind_gusts_10m', 'wind_direction_10m', 'precipitation', 'is_day']);
  const now = Date.now() / 1000;
  for (const [k, site] of list.entries()) {
    const w = weather[k]?.hourly;
    // Coastal storms last hours to days, so aim for the best hour you can still
    // drive there for; fall back to the overall best if none is reachable.
    const reachBy = now + (haversine([origin.lon, origin.lat], [site.lon, site.lat]) * 1.25) / 25;
    let best = { score: -1 };
    let bestReachable = { score: -1 };
    site.sea.time.forEach((t, i) => {
      if (t < now - 1800 || t > now + hours * 3600 || !w) return;
      const j = w.time.indexOf(t);
      if (j < 0) return;
      const hour = {
        time: t,
        height: site.sea.wave_height[i],
        period: site.sea.wave_period[i],
        gusts: w.wind_gusts_10m[j],
        windFrom: w.wind_direction_10m[j],
        day: w.is_day[j] === 1,
        precip: w.precipitation[j],
      };
      hour.score = waveScore(hour);
      if (hour.score > best.score) best = hour;
      if (t >= reachBy - 1800 && hour.score > bestReachable.score) bestReachable = hour;
    });
    const pick = bestReachable.score >= 25 ? bestReachable : best;
    Object.assign(site, pick, { level: stormLevel(pick.score) });
  }

  // Strongest few stretches of coast, favouring ones near you / your trip.
  const picked = [];
  for (const s of [...list].sort((a, b) => nearBias(b, anchors, radiusKm) - nearBias(a, anchors, radiusKm))) {
    if (s.score < 25 || picked.length === MAX_SITES) break;
    if (picked.some((p) => haversine([p.lon, p.lat], [s.lon, s.lat]) < 40000)) continue;
    picked.push(s);
  }

  const spots = [];
  for (const s of picked) {
    const lookout = await findLookout(s).catch(() => null);
    const at = lookout ?? { lat: s.lat, lon: s.lon, name: await areaName(s) };
    const dist = haversine([origin.lon, origin.lat], [at.lon, at.lat]);
    const eta = now + (dist * 1.25) / 25;
    spots.push({
      ...at,
      show: 'waves',
      score: s.score,
      time: s.time,
      waveHeight: s.height,
      period: s.period,
      gusts: s.gusts,
      windFrom: s.windFrom,
      dist,
      eta,
      reachable: eta <= s.time + 1800,
      level: s.level,
    });
  }
  spots.sort((a, b) => b.reachable - a.reachable || nearBias(b, anchors, radiusKm) - nearBias(a, anchors, radiusKm));
  return { cells: list.map(({ sea, ...c }) => c), spots };
}

// The nearest named lighthouse, park or beach to a stretch of sea.
async function findLookout(site) {
  const kinds = [['lighthouse', 'man_made:lighthouse'], ['park', 'leisure:park'], ['beach', 'natural:beach']];
  const found = await Promise.all(kinds.map(([q, tag]) => {
    const params = new URLSearchParams({ q, lat: site.lat.toFixed(3), lon: site.lon.toFixed(3), zoom: '10', location_bias_scale: '0.1', limit: '6', osm_tag: tag });
    // Nice to have, not essential: give up quickly if the search service is slow.
    return fetch(`${PHOTON}?${params}`, { signal: AbortSignal.timeout(6000) })
      .then((r) => r.json()).then((d) => d.features).catch(() => []);
  }));
  const candidates = found.flat()
    .filter((f) => f.properties.name)
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      return { lat, lon, name: f.properties.name, d: haversine([site.lon, site.lat], [lon, lat]) };
    })
    .filter((c) => c.d < 25000)
    .sort((a, b) => a.d - b.d);
  const best = candidates[0];
  return best ? { lat: best.lat, lon: best.lon, name: best.name } : null;
}

// Fallback label when no named lookout is found, e.g. "Jefferson County coast",
// from OpenStreetMap's Nominatim. Its usage policy allows one request a second.
let lastNominatim = 0;
async function areaName(site) {
  const fallback = `Shore near ${site.lat.toFixed(2)}, ${site.lon.toFixed(2)}`;
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  try {
    const params = new URLSearchParams({ format: 'jsonv2', lat: site.lat.toFixed(3), lon: site.lon.toFixed(3), zoom: '10' });
    const res = await fetch(`${NOMINATIM}?${params}`, { signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    return data.name ? `${data.name} coast` : fallback;
  } catch {
    return fallback;
  }
}

// Ground height (m) for each point; the sea comes back as 0.
async function elevations(points) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(3)).join(','),
    longitude: points.map((p) => p.lon.toFixed(3)).join(','),
  });
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?${params}`);
  if (!res.ok) throw new Error(`Coastal scan failed (${res.status})`);
  return (await res.json()).elevation;
}

async function getJSON(base, points, vars) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(3)).join(','),
    longitude: points.map((p) => p.lon.toFixed(3)).join(','),
    hourly: vars.join(','),
    timeformat: 'unixtime',
    timezone: 'GMT',
    forecast_days: '3',
  });
  const res = await fetch(`${base}?${params}`);
  if (!res.ok) throw new Error(`Coastal scan failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}
