// Driving routes from an OSRM server (https://project-osrm.org).
// Default is the FOSSGIS-hosted OSRM instance; swap ROUTER for your own server.

const ROUTER = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
const MAX_OPTIONS = 4;
const MAX_SLOWDOWN = 1.5; // drop alternatives more than 50% slower than the fastest

async function request(points, extra = {}) {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    steps: 'true',
    annotations: 'duration,distance',
    ...extra,
  });
  const res = await fetch(`${ROUTER}${coords}?${params}`);
  if (!res.ok) throw new Error(`Routing failed (${res.status})`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(data.message || 'No route found between those places');
  }
  return data.routes.map(prepare);
}

// The fastest route through the given points (start, optional stops, destination).
export async function getRoute(points) {
  const [route] = await request(points);
  return route;
}

// Other reasonable ways to get there, e.g. I-40 instead of I-10. OSRM's own
// alternatives come first; if it finds none, we nudge the route sideways through
// points either side of the direct line. Can be slow on long trips.
export async function getAlternatives(from, to, known = []) {
  let found = [...known];
  const add = (routes) => { found = mergeRoutes(found, routes); };

  add(await request([from, to], { alternatives: '3' }).catch(() => []));
  if (found.length < 2 && haversine([from.lon, from.lat], [to.lon, to.lat]) > 80000) {
    const nudged = await Promise.allSettled(corridorPoints(from, to).map((via) => getRoute([from, via, to])));
    add(nudged.filter((r) => r.status === 'fulfilled').map((r) => r.value));
  }
  return found.filter((r) => !known.includes(r));
}

// Combine route lists, dropping near-duplicates and much slower options.
export function mergeRoutes(existing, incoming) {
  const all = [...existing];
  for (const r of incoming) {
    if (!all.some((a) => overlap(a, r) > 0.85)) all.push(r);
  }
  const fastest = Math.min(...all.map((r) => r.duration));
  return all
    .filter((r) => existing.includes(r) || r.duration <= fastest * MAX_SLOWDOWN)
    .sort((a, b) => a.duration - b.duration)
    .slice(0, MAX_OPTIONS);
}

// Points offset to each side of the trip's midpoint, perpendicular to the direct line.
function corridorPoints(from, to) {
  const midLat = (from.lat + to.lat) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  const dx = (to.lon - from.lon) * k;
  const dy = to.lat - from.lat;
  return [0.08, -0.08].map((f) => ({
    lat: midLat - dx * f,
    lon: (from.lon + to.lon) / 2 + (dy * f) / k,
  }));
}

// Share of b's path (on a ~2 km grid) that a also covers.
function overlap(a, b) {
  const ca = cells(a);
  const cb = cells(b);
  let shared = 0;
  for (const c of cb) if (ca.has(c)) shared++;
  return shared / Math.min(ca.size, cb.size);
}

function cells(route) {
  if (!route.cells) route.cells = new Set(route.coords.map(([lon, lat]) => `${Math.round(lat * 50)},${Math.round(lon * 50)}`));
  return route.cells;
}

// Adds cumulative distance (m) and time (s) for every vertex of the route line,
// plus each step's starting distance, so we can answer "when will I be here?".
function prepare(route) {
  const coords = route.geometry.coordinates;
  const durations = route.legs.flatMap((l) => l.annotation?.duration ?? []);
  const distances = route.legs.flatMap((l) => l.annotation?.distance ?? []);
  const cumDist = [0];
  const cumTime = [0];

  for (let i = 1; i < coords.length; i++) {
    const d = distances[i - 1] ?? haversine(coords[i - 1], coords[i]);
    cumDist.push(cumDist[i - 1] + d);
  }

  if (durations.length === coords.length - 1) {
    for (let i = 1; i < coords.length; i++) cumTime.push(cumTime[i - 1] + durations[i - 1]);
  } else {
    // No per-segment timing: spread total duration proportionally to distance.
    const total = cumDist[cumDist.length - 1] || 1;
    for (let i = 1; i < coords.length; i++) cumTime.push((cumDist[i] / total) * route.duration);
  }

  // Join the legs' steps; stops in the middle become a single "pass through" step.
  const lastLeg = route.legs.length - 1;
  const raw = route.legs.flatMap((leg, li) => leg.steps.filter((s) => {
    const t = s.maneuver.type;
    return !(li > 0 && t === 'depart');
  }).map((s) => (li < lastLeg && s.maneuver.type === 'arrive' ? { ...s, via: true } : s)));

  let along = 0;
  const steps = raw.map((s) => {
    const step = { ...s, startDist: along, text: s.via ? 'Continue through your stop' : instruction(s) };
    along += s.distance;
    return step;
  });

  return {
    coords,
    cumDist,
    cumTime,
    steps,
    roads: mainRoads(steps, route.distance),
    distance: route.distance,
    duration: route.duration,
  };
}

// The highways a route mostly uses, e.g. ["I 40", "US 287"].
function mainRoads(steps, total) {
  const byRoad = new Map();
  for (const s of steps) {
    const road = (s.ref || s.name || '').split(';')[0].trim();
    if (road) byRoad.set(road, (byRoad.get(road) ?? 0) + s.distance);
  }
  return [...byRoad.entries()]
    .filter(([, d]) => d > total * 0.08)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([road]) => road);
}

export function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Pick evenly spaced points along the route to fetch weather for.
export function samplePoints(route, maxPoints = 40) {
  const total = route.distance;
  const spacing = Math.max(8000, total / (maxPoints - 1));
  const out = [];
  let next = 0;
  for (let i = 0; i < route.coords.length; i++) {
    if (route.cumDist[i] >= next) {
      out.push({ index: i, lon: route.coords[i][0], lat: route.coords[i][1], dist: route.cumDist[i], time: route.cumTime[i] });
      next += spacing;
    }
  }
  const last = route.coords.length - 1;
  if (out[out.length - 1].index !== last) {
    out.push({ index: last, lon: route.coords[last][0], lat: route.coords[last][1], dist: route.cumDist[last], time: route.cumTime[last] });
  }
  return out;
}

const DIRECTIONS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

function instruction(step) {
  const { type, modifier, exit, bearing_after: bearing } = step.maneuver;
  const road = step.name || step.ref || '';
  const onto = road ? ` onto ${road}` : '';
  const mod = modifier ? modifier.replace('uturn', 'U-turn') : '';

  switch (type) {
    case 'depart':
      return `Head ${DIRECTIONS[Math.round(bearing / 45) % 8]}${road ? ` on ${road}` : ''}`;
    case 'arrive':
      return 'Arrive at your destination';
    case 'roundabout':
    case 'rotary':
      return `At the roundabout, take exit ${exit ?? ''}${onto}`.replace('  ', ' ');
    case 'merge':
      return `Merge${mod ? ` ${mod}` : ''}${onto}`;
    case 'on ramp':
      return `Take the ramp${mod ? ` on the ${mod}` : ''}${onto}`;
    case 'off ramp':
      return `Take the exit${mod ? ` on the ${mod}` : ''}${onto}`;
    case 'fork':
      return `Keep ${mod || 'straight'} at the fork${onto}`;
    case 'continue':
    case 'new name':
      return `Continue${mod && mod !== 'straight' ? ` ${mod}` : ''}${onto}`;
    case 'end of road':
      return `At the end of the road, turn ${mod}${onto}`;
    default:
      if (mod === 'straight') return `Continue straight${onto}`;
      if (mod === 'U-turn') return `Make a U-turn${onto}`;
      return `Turn ${mod}${onto}`;
  }
}
