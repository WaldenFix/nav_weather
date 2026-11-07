// Hourly forecasts from Open-Meteo (https://open-meteo.com): open-source, no API key,
// built on national weather service models (NOAA, DWD, Météo-France, ECMWF, ...).

import { describe, severity } from './wmo.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const VARS = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation',
  'precipitation_probability',
  'snowfall',
  'weather_code',
  'wind_speed_10m',
  'wind_gusts_10m',
  'visibility',
];

// Fetch hourly series for many points in one request. Returns one series per point:
// { time: [unix seconds], temperature_2m: [...], ... }
export async function fetchForecasts(points, hoursNeeded) {
  const days = Math.min(16, Math.max(1, Math.ceil(hoursNeeded / 24) + 1));
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(3)).join(','),
    longitude: points.map((p) => p.lon.toFixed(3)).join(','),
    hourly: VARS.join(','),
    timeformat: 'unixtime',
    timezone: 'GMT',
    forecast_days: String(days),
    wind_speed_unit: 'kmh',
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.reason || `Weather request failed (${res.status})`);
  }
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];
  return list.map((d) => d.hourly);
}

// Conditions in a series at a given unix time (seconds), interpolating numbers
// between the surrounding hours and taking the nearest hour's weather code.
export function conditionsAt(series, t) {
  const times = series.time;
  if (t <= times[0]) return pick(series, 0, 0, 0);
  const last = times.length - 1;
  if (t >= times[last]) return t - times[last] > 3600 ? null : pick(series, last, last, 0);
  let i = 0;
  while (times[i + 1] <= t) i++;
  const f = (t - times[i]) / (times[i + 1] - times[i]);
  return pick(series, i, i + 1, f);
}

function pick(s, a, b, f) {
  const lerp = (key) => {
    const va = s[key]?.[a];
    const vb = s[key]?.[b];
    if (va == null) return vb ?? null;
    if (vb == null) return va;
    return va + (vb - va) * f;
  };
  // Precipitation & weather code are reported for the hour *ending* at time[i],
  // so the hour we're inside of is described by index b.
  const code = s.weather_code[f > 0 ? b : a];
  const c = {
    temp: lerp('temperature_2m'),
    feels: lerp('apparent_temperature'),
    precip: s.precipitation[f > 0 ? b : a],
    pop: lerp('precipitation_probability'),
    snowfall: s.snowfall?.[f > 0 ? b : a] ?? 0,
    wind: lerp('wind_speed_10m'),
    gusts: lerp('wind_gusts_10m'),
    visibility: lerp('visibility') ?? Infinity,
    code,
  };
  Object.assign(c, describe(code));
  c.severity = severity(c);
  return c;
}

// How much longer a stretch takes in this weather (travel-time multiplier).
// Based on the US FHWA Road Weather Management figures for freeway speed drops:
// light rain 2–13%, heavy rain 3–16%, light snow 3–13%, heavy snow 5–40%,
// low visibility 10–12% (more in dense fog). Ice is treated like heavy snow.
export function slowdown(wx) {
  if (!wx) return 1;
  const code = wx.code;
  let f = 1;
  if ([56, 57, 66, 67].includes(code)) f = 1.6; // freezing drizzle / rain
  else if ([75, 86].includes(code) || wx.snowfall >= 1) f = 1.6; // heavy snow
  else if ([71, 73, 77, 85].includes(code) || wx.snowfall > 0) f = 1.25;
  else if (wx.precip >= 4) f = 1.15;
  else if (wx.precip >= 1) f = 1.1;
  else if (wx.precip > 0.1) f = 1.05;
  if (wx.visibility < 200) f = Math.max(f, 1.4);
  else if (wx.visibility < 1000) f = Math.max(f, 1.12);
  if (wx.gusts >= 90) f = Math.max(f, 1.15);
  else if (wx.gusts >= 60) f = Math.max(f, 1.05);
  return f;
}

// Weather at each sample point for a given departure time (unix seconds).
// Each stretch is slowed down by the weather at its start, so a snowy pass pushes
// back the arrival time (and so the forecast) for everything after it.
// `delay` is the extra time (s) the weather has added by that point.
export function alongRoute(samples, forecasts, departAt) {
  const out = [];
  let eta = departAt;
  let delay = 0;
  samples.forEach((p, i) => {
    if (i > 0) {
      const base = p.time - samples[i - 1].time;
      const extra = base * (slowdown(out[i - 1].wx) - 1);
      eta += base + extra;
      delay += extra;
    }
    out.push({ ...p, eta, delay, wx: conditionsAt(forecasts[i], eta) });
  });
  return out;
}

// A single number per departure time: lower is a better drive.
export function routeScore(samples, forecasts, departAt) {
  let score = 0;
  for (const p of alongRoute(samples, forecasts, departAt)) {
    if (!p.wx) return Infinity;
    // Severity dominates; rain chance only breaks ties between otherwise equal trips.
    score += p.wx.severity ** 2 + (p.wx.pop ?? 0) / 1000;
  }
  return score;
}
