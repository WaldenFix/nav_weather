// Official road reports from the Washington State DOT Traveler Information API
// (https://wsdot.wa.gov/traffic/api/): incidents, closures, construction and
// mountain pass conditions. Free, but needs an access code (register with an email
// address on that page). The API supports JSONP, so it works from a static site
// without a proxy server.

import { haversine } from './route.js';

const BASE = 'https://www.wsdot.wa.gov/Traffic/api/';
const ALERTS = 'HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson';
const PASSES = 'MountainPassConditions/MountainPassConditionsREST.svc/GetMountainPassConditionsAsJson';
const CACHE_MS = 5 * 60 * 1000;
const WA_BOUNDS = { south: 45.5, north: 49.1, west: -124.9, east: -116.8 };
const NEAR_ROUTE_M = 400;

let cache = null; // { code, at, data }

// Does the route pass through Washington State at all?
export function inWashington(route) {
  return route.coords.some(([lon, lat]) => lat >= WA_BOUNDS.south && lat <= WA_BOUNDS.north
    && lon >= WA_BOUNDS.west && lon <= WA_BOUNDS.east);
}

// Current alerts and pass conditions, cached for a few minutes.
export async function fetchWsdot(code) {
  if (cache && cache.code === code && Date.now() - cache.at < CACHE_MS) return cache.data;
  const [alerts, passes] = await Promise.all([
    jsonp(`${BASE}${ALERTS}?AccessCode=${encodeURIComponent(code)}`),
    jsonp(`${BASE}${PASSES}?AccessCode=${encodeURIComponent(code)}`),
  ]);
  const data = {
    alerts: (alerts ?? []).map((a) => ({
      id: a.AlertID,
      lat: a.StartRoadwayLocation?.Latitude,
      lon: a.StartRoadwayLocation?.Longitude,
      road: a.StartRoadwayLocation?.RoadName,
      category: a.EventCategory,
      priority: a.Priority,
      headline: a.HeadlineDescription,
      ends: wcfDate(a.EndTime),
    })).filter((a) => a.lat && a.lon),
    passes: (passes ?? []).map((p) => ({
      id: p.MountainPassId,
      name: p.MountainPassName,
      lat: p.Latitude,
      lon: p.Longitude,
      elevationFt: p.ElevationInFeet,
      road: p.RoadCondition,
      weather: p.WeatherCondition,
      tempF: p.TemperatureInFahrenheit,
      restrictions: [p.RestrictionOne, p.RestrictionTwo]
        .filter((r) => r?.RestrictionText)
        .map((r) => `${r.TravelDirection ? `${r.TravelDirection}: ` : ''}${r.RestrictionText}`),
      advisory: p.TravelAdvisoryActive,
      updated: wcfDate(p.DateUpdated),
    })).filter((p) => p.lat && p.lon),
  };
  cache = { code, at: Date.now(), data };
  return data;
}

// Reports within a few hundred metres of the route, with how far along the route
// each one is (`along`, metres), in driving order.
export function onRoute(items, route) {
  const { coords, cumDist } = route;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lon, lat] of coords) {
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
  }
  const pad = 0.01;
  const found = [];
  for (const item of items) {
    if (item.lat < minLat - pad || item.lat > maxLat + pad || item.lon < minLon - pad || item.lon > maxLon + pad) continue;
    let best = Infinity;
    let at = 0;
    for (let i = 0; i < coords.length; i++) {
      // Cheap reject before the exact distance.
      if (Math.abs(coords[i][1] - item.lat) > 0.01 || Math.abs(coords[i][0] - item.lon) > 0.015) continue;
      const d = haversine(coords[i], [item.lon, item.lat]);
      if (d < best) { best = d; at = cumDist[i]; }
    }
    if (best <= NEAR_ROUTE_M) found.push({ ...item, along: at });
  }
  return found.sort((a, b) => a.along - b.along);
}

// How serious a report is for driving: 3 = closure / chains, 2 = significant, 1 = minor.
export function reportSeverity(item) {
  const text = `${item.category ?? ''} ${item.headline ?? ''} ${(item.restrictions ?? []).join(' ')} ${item.road ?? ''}`.toLowerCase();
  if (/closed|closure|chains required/.test(text)) return 3;
  if (item.priority === 'Highest' || item.priority === 'High' || /collision|crash|chains|traction/.test(text)) return 2;
  return 1;
}

// WCF dates look like "/Date(928174800000-0700)/"; the number is UTC milliseconds.
function wcfDate(s) {
  const m = /\/Date\((-?\d+)/.exec(s ?? '');
  return m ? Number(m[1]) / 1000 : null;
}

let jsonpId = 0;
function jsonp(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const name = `__wsdot${Date.now()}_${jsonpId++}`;
    const script = document.createElement('script');
    const done = () => { delete window[name]; script.remove(); clearTimeout(timer); };
    const timer = setTimeout(() => { done(); reject(new Error('WSDOT did not respond (check the access code)')); }, timeoutMs);
    window[name] = (data) => { done(); resolve(data); };
    script.onerror = () => { done(); reject(new Error('WSDOT request failed (check the access code)')); };
    script.src = `${url}&callback=${name}`;
    document.head.append(script);
  });
}
