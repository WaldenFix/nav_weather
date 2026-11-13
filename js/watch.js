// Storm watcher: rather than the storm itself, find a safe place to *watch* one from.
// A good viewing spot is dry with a clear view, 15–60 km from a strong storm, off to
// the side of where the storm is heading. By day the show is the cloud structure
// (best with the sun behind you); after dark it's the lightning.

import { haversine } from './route.js';
import { stormScore, stormLevel, compass, trackWind, nearBias, forecastDays } from './storm.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const GRID = 11;
const VARS = [
  'cape', 'lifted_index', 'weather_code', 'precipitation_probability', 'precipitation',
  'wind_gusts_10m', 'cloud_cover', 'cloud_cover_low', 'visibility', 'is_day',
  'wind_speed_500hPa', 'wind_direction_500hPa',
];
const MIN_VIEW_KM = 15;

const RING_KM = [20, 35, 50];
const RING_BEARINGS = 12;
const MAX_STORMS = 3;

// Two passes. 1: a coarse grid over the area finds where strong storms are likely and
// when. 2: rings of candidate spots 20–50 km around the strongest few storms are
// checked for a dry, clear view. Returns { cells, spots }: storm potential per grid
// point (for the map) and the best viewing spots, each paired with its storm.
export async function scanViewing(center, radiusKm, { origin = center, anchors = [], hours = 12, start = Date.now() / 1000 } = {}) {
  const days = forecastDays(start, hours);
  const points = await forecast(grid(center, radiusKm), days);
  const inWindow = (t) => t >= start - 1800 && t <= start + hours * 3600;

  // Storm potential at every grid point; keep each point's peak hour.
  const cells = points.map((p) => {
    const cell = { lat: p.lat, lon: p.lon, score: 0, maxGusts: 0, p };
    p.h.time.forEach((t, i) => {
      if (!inWindow(t)) return;
      trackWind(cell, p.h, i);
      const score = stormScore({
        cape: p.h.cape?.[i], li: p.h.lifted_index?.[i], code: p.h.weather_code[i],
        pop: p.h.precipitation_probability?.[i], gusts: p.h.wind_gusts_10m?.[i],
      });
      if (score > cell.score) Object.assign(cell, { score, i, time: t, level: stormLevel(score) });
    });
    return cell;
  });

  // The strongest few storms, spread apart, favouring ones near the anchors.
  const storms = [];
  const rank = (c) => nearBias(c, anchors, radiusKm);
  for (const c of [...cells].sort((a, b) => rank(b) - rank(a))) {
    if (storms.length === MAX_STORMS) break;
    if (c.score < 40) continue;
    if (storms.some((s) => haversine([s.lon, s.lat], [c.lon, c.lat]) < (radiusKm * 1000) / 4)) continue;
    // Storms drift roughly with the mid-level (500 hPa) wind; direction is "from".
    const from = c.p.h.wind_direction_500hPa?.[c.i];
    storms.push({ ...c, moveTo: from == null ? null : (from + 180) % 360, speed: c.p.h.wind_speed_500hPa?.[c.i] });
  }

  const spots = [];
  if (storms.length) {
    const rings = storms.flatMap((s) => RING_KM.flatMap((km) => Array.from({ length: RING_BEARINGS }, (_, b) => ({
      ...destination(s, (360 / RING_BEARINGS) * b, km),
      storm: s,
    }))));
    const viewers = await forecast(rings, days);
    for (const v of viewers) {
      const s = v.storm;
      const neighbours = viewers.filter((o) => o.storm === s);
      const view = viewScore(v, s, s.p, haversine([v.lon, v.lat], [s.lon, s.lat]) / 1000, neighbours);
      if (!view) continue;
      const dist = haversine([origin.lon, origin.lat], [v.lon, v.lat]);
      const eta = start + (dist * 1.25) / 25; // same rough drive-time guess as the chaser
      spots.push({ lat: v.lat, lon: v.lon, ...view, dist, eta, reachable: eta <= view.time + 1800 });
    }
  }

  return {
    cells: cells.map(({ p, i, ...c }) => c),
    spots: pickSpots(spots, (s) => nearBias(s, anchors, radiusKm)),
  };
}

// Attach hourly forecasts (`h`) and elevation to each point, in one request.
async function forecast(points, days) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(3)).join(','),
    longitude: points.map((p) => p.lon.toFixed(3)).join(','),
    hourly: VARS.join(','),
    timeformat: 'unixtime',
    timezone: 'GMT',
    forecast_days: days,
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`Storm scan failed (${res.status})`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];
  return points.map((p, k) => ({ ...p, h: list[k].hourly, elevation: list[k].elevation ?? 0 }));
}

function viewScore(v, storm, sp, distKm, neighbours) {
  const h = v.h;
  const i = h.time.indexOf(storm.time);
  if (i < 0) return null;
  // You need to be dry and able to see out.
  if ((h.weather_code[i] ?? 0) >= 95) return null;
  if ((h.precipitation?.[i] ?? 0) > 0.3 || (h.precipitation_probability?.[i] ?? 0) > 50) return null;
  const lowCloud = h.cloud_cover_low?.[i] ?? 0;
  const visibility = h.visibility?.[i] ?? 20000;
  if (lowCloud > 80 || visibility < 5000) return null;

  const day = h.is_day?.[i] === 1;
  const t = h.time[i];
  const lookBearing = bearing(v, sp); // where you'd point the camera

  // Distance: close enough to fill the view, far enough to see the whole storm.
  const distF = distKm < 25 ? 0.75 + 0.25 * ((distKm - MIN_VIEW_KM) / 10) : distKm <= 40 ? 1 : 1 - 0.4 * ((distKm - 40) / 20);

  // Position relative to the storm's motion: beside it is best, in its path is bad.
  let sideF = 0.85;
  let heading = null;
  if (storm.moveTo != null) {
    heading = storm.moveTo;
    const fromStorm = bearing(sp, v);
    const off = angleDiff(fromStorm, storm.moveTo); // 0 = straight ahead of the storm
    if (off < 30) sideF = 0.35;
    else if (off < 60) sideF = 0.75;
    else if (off <= 130) sideF = 1;
    else sideF = 0.7; // behind it: safe, but you see the rainy back side
  }

  // Clear air between you and the storm matters most at night (lightning) and for
  // structure; by day it also helps to have the sun at your back.
  const clearF = 1 - (lowCloud / 100) * 0.5 - (day ? 0 : ((h.cloud_cover?.[i] ?? 0) / 100) * 0.3);
  const lightF = day ? 0.8 + 0.2 * Math.cos(rad(angleDiff(lookBearing, (sunAzimuth(v.lat, v.lon, t) + 180) % 360))) : 1;

  // A little higher than the surrounding area = a better view over trees and hills.
  const avgElev = neighbours.reduce((a, p) => a + p.elevation, 0) / (neighbours.length || 1);
  const highF = 1 + Math.min(Math.max((v.elevation - avgElev) / 300, 0), 0.1);

  // After dark, lightning is the show: weight towards strong instability.
  const cape = sp.h.cape?.[storm.i] ?? 0;
  const showF = day ? 1 : 0.85 + Math.min(cape / 2500, 1) * 0.15;

  const score = Math.round(Math.min(100, storm.score * distF * sideF * clearF * lightF * highF * showF));
  return {
    score,
    time: t,
    show: day ? 'structure' : 'lightning',
    stormScore: storm.score,
    stormLat: sp.lat,
    stormLon: sp.lon,
    stormKm: distKm,
    look: compass(v, sp),
    lookBearing,
    moving: heading == null ? null : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8],
    speedKmh: storm.speed,
    level: stormLevel(score),
  };
}

// Best spots at least 30 km apart (so you can get two sides of one storm),
// reachable-in-time first.
function pickSpots(spots, rank, count = 5) {
  const minGap = 30000;
  const picked = [];
  for (const s of spots.sort((a, b) => rank(b) - rank(a))) {
    if (s.score < 25) continue;
    if (picked.some((p) => haversine([p.lon, p.lat], [s.lon, s.lat]) < minGap)) continue;
    picked.push(s);
    if (picked.length === count) break;
  }
  return picked.sort((a, b) => b.reachable - a.reachable || rank(b) - rank(a));
}

export function grid(center, radiusKm, size = GRID) {
  const points = [];
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos(rad(center.lat)));
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      points.push({
        lat: center.lat - dLat + (2 * dLat * i) / (size - 1),
        lon: center.lon - dLon + (2 * dLon * j) / (size - 1),
      });
    }
  }
  return points;
}

// The point `km` away from `from` in direction `brg` (degrees from north).
function destination(from, brg, km) {
  const d = km / 6371;
  const lat1 = rad(from.lat);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(rad(brg)));
  const lon2 = rad(from.lon) + Math.atan2(Math.sin(rad(brg)) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lon: deg(lon2) };
}

function rad(d) { return (d * Math.PI) / 180; }
function deg(r) { return (r * 180) / Math.PI; }

function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Sun azimuth in degrees clockwise from north (low-precision solar position).
export function sunAzimuth(lat, lon, t) {
  const d = (t - 946728000) / 86400; // days since J2000.0
  const g = rad(357.529 + 0.98560028 * d);
  const q = 280.459 + 0.98564736 * d;
  const L = rad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const e = rad(23.439 - 0.00000036 * d);
  const ra = deg(Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15;
  const H = rad(gmst + lon - ra);
  const phi = rad(lat);
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return (deg(az) + 180 + 360) % 360;
}
