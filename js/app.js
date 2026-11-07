import { search } from './geocode.js';
import { getRoute, getAlternatives, samplePoints, haversine } from './route.js';
import { fetchForecasts, alongRoute, conditionsAt, routeScore } from './weather.js';
import { SEVERITY_LABEL } from './wmo.js';
import { showRadar, hideRadar } from './radar.js';
import { Navigator } from './nav.js';
import { scanStorms, pickTargets, fetchWarnings, fetchLocalAlerts, windstorm, compass, STORM_EVENTS } from './storm.js';
import { scanViewing } from './watch.js';
import { scanCoast } from './coast.js';
import { fetchWsdot, inWashington, onRoute, reportSeverity } from './roads.js';

// OpenFreeMap: free, keyless vector tiles of OpenStreetMap (https://openfreemap.org).
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const MAX_DEPART_HOURS = 72;
const SEV_COLORS = ['#16a34a', '#ca8a04', '#ea580c', '#dc2626'];

const $ = (id) => document.getElementById(id);

const state = {
  from: null,
  via: null,
  to: null,
  // Route options, each { route, samples, forecasts }. The selected one is mirrored
  // into route / samples / forecasts below.
  options: [],
  selected: 0,
  route: null,
  samples: null,
  forecasts: null,
  planToken: 0,
  baseTime: now(),
  departOffset: 0,
  imperial: loadUnits(),
  markers: [],
  endpointMarkers: [],
  nav: null,
  meMarker: null,
  radarOn: false,
  chaser: false,
  watcher: false,
  watchKind: 'thunder', // storm watcher: 'thunder' or 'coast'
  gps: null, // last known device position
  roads: null, // WSDOT { alerts, passes } for the current plan
  roadError: null,
  roadMarkers: [],
  // GPS, start and destination bias searches and storm scans; see anchors().
  target: null, // storm target or viewing spot we're routing to; .kind is 'chase' or 'watch'
};

// Offline app shell + "Add to Home Screen" support. Skipped on plain http (except localhost).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------------------------------------------------------------- map

const map = new maplibregl.Map({
  container: 'map',
  style: MAP_STYLE,
  center: [-96, 38.5],
  zoom: 3.6,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

const mapReady = new Promise((resolve) => map.on('load', resolve));

mapReady.then(() => {
  // Storm layers sit lowest so routes draw on top of them.
  map.addSource('nws', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'nws-fill',
    type: 'fill',
    source: 'nws',
    paint: {
      'fill-color': ['match', ['get', 'kind'], 'tornado', '#dc2626', 'flood', '#16a34a', '#f59e0b'],
      'fill-opacity': 0.25,
    },
  });
  map.addLayer({
    id: 'nws-line',
    type: 'line',
    source: 'nws',
    paint: { 'line-color': ['match', ['get', 'kind'], 'tornado', '#dc2626', 'flood', '#16a34a', '#f59e0b'], 'line-width': 2 },
  });

  map.addSource('storm-grid', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'storm-grid',
    type: 'circle',
    source: 'storm-grid',
    filter: ['>=', ['get', 'score'], 20],
    paint: {
      'circle-color': ['step', ['get', 'score'], SEV_COLORS[1], 40, SEV_COLORS[2], 65, SEV_COLORS[3]],
      'circle-opacity': ['interpolate', ['linear'], ['get', 'score'], 20, 0.25, 100, 0.6],
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 4, 8, 8, 60],
      'circle-blur': 0.6,
    },
  });

  // Storm watcher: dashed sightline from each viewing spot to the storm it looks at.
  map.addSource('watch', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'watch-lines',
    type: 'line',
    source: 'watch',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#7c3aed', 'line-width': 2, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'watch-spots',
    type: 'circle',
    source: 'watch',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-color': '#7c3aed', 'circle-radius': 8, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
  });

  map.addSource('alts', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'alt-line',
    type: 'line',
    source: 'alts',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#64748b', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 4, 14, 9], 'line-opacity': 0.75 },
  });

  map.addSource('route', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1e293b', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 6, 14, 12], 'line-opacity': 0.55 },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'sev'], 0, SEV_COLORS[0], 1, SEV_COLORS[1], 2, SEV_COLORS[2], 3, SEV_COLORS[3], '#3b82f6'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 14, 8],
    },
  });

  // Tap a grey alternative to switch to it.
  map.on('click', 'alt-line', (e) => selectOption(e.features[0].properties.idx));
  map.on('mouseenter', 'alt-line', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'alt-line', () => { map.getCanvas().style.cursor = ''; });

  map.on('click', 'nws-fill', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup().setLngLat(e.lngLat).setText(p.headline).addTo(map);
  });
  map.on('click', 'watch-spots', (e) => {
    const spot = state.spots?.[e.features[0].properties.idx];
    if (spot) new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(spotCard(spot)).addTo(map);
  });
  map.on('click', 'storm-grid', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(stormCard(JSON.parse(p.cell))).addTo(map);
  });
});

// Right-click / long-press on the map to route to or from that spot.
map.on('contextmenu', (e) => {
  const { lng, lat } = e.lngLat;
  const label = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexWrap = 'wrap';
  wrap.style.gap = '6px';
  for (const [text, which] of [['Directions from here', 'from'], ['Go via here', 'via'], ['Directions to here', 'to']]) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = text;
    b.onclick = () => {
      popup.remove();
      setPlace(which, { lat, lon: lng, label });
      maybeRoute();
    };
    wrap.append(b);
  }
  const popup = new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setDOMContent(wrap).addTo(map);
});

// ---------------------------------------------------------------- search inputs

setupSearch('from');
setupSearch('via');
setupSearch('to');

function setupSearch(which) {
  const input = $(which);
  const list = $(`${which}-suggestions`);
  let timer;
  let controller;
  let results = [];
  let active = -1;

  const close = () => { list.replaceChildren(); results = []; active = -1; };

  const choose = (place) => {
    setPlace(which, place);
    close();
    maybeRoute();
  };

  input.addEventListener('input', () => {
    state[which] = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const bias = state.gps ?? state.from ?? state.to ?? mapCenter();
        results = await search(q, bias, controller.signal);
        active = -1;
        list.replaceChildren(...results.map((r, i) => {
          const li = document.createElement('li');
          li.setAttribute('role', 'option');
          li.textContent = r.title;
          if (r.detail) {
            const small = document.createElement('small');
            small.textContent = r.detail;
            li.append(small);
          }
          li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(results[i]); });
          return li;
        }));
      } catch (err) {
        if (err.name !== 'AbortError') showStatus(err.message, true);
      }
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      [...list.children].forEach((li, i) => li.classList.toggle('active', i === active));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 150));
}

function setPlace(which, place) {
  state[which] = place;
  $(which).value = place?.label ?? '';
  if (which === 'to' && state.target && (place?.lat !== state.target.lat || place?.lon !== state.target.lon)) state.target = null;
  drawEndpoints();
}

function mapCenter() {
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

$('locate').addEventListener('click', async () => {
  showStatus('Finding your location…');
  try {
    await useMyLocation();
    hideStatus();
    if (!state.to) map.flyTo({ center: [state.from.lon, state.from.lat], zoom: 12 });
    maybeRoute();
  } catch (err) {
    showStatus(`Couldn't get your location: ${err.message}`, true);
  }
});

async function useMyLocation() {
  const pos = await currentPosition();
  state.gps = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  setPlace('from', { ...state.gps, label: 'My location' });
}

$('swap').addEventListener('click', () => {
  const { from, to } = state;
  setPlace('from', to);
  setPlace('to', from);
  maybeRoute();
});

$('clear-via').addEventListener('click', () => {
  const had = state.via || $('via').value;
  setPlace('via', null);
  if (had) maybeRoute();
});

$('route-form').addEventListener('submit', (e) => {
  e.preventDefault();
  planRoute();
});

$('collapse').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

// ---------------------------------------------------------------- departure time

$('depart').max = MAX_DEPART_HOURS;
$('depart').addEventListener('input', () => {
  state.departOffset = Number($('depart').value);
  updateDepartLabel();
  if (state.forecasts) render();
});

function departAt() {
  return state.baseTime + state.departOffset * 3600;
}

function updateDepartLabel() {
  $('depart-label').textContent = state.departOffset === 0 ? 'now' : fmtDayTime(departAt());
}

// ---------------------------------------------------------------- units

$('toggle-units').addEventListener('click', () => {
  state.imperial = !state.imperial;
  try { localStorage.setItem('units', state.imperial ? 'imperial' : 'metric'); } catch {}
  updateUnitsChip();
  if (state.forecasts) render();
  if (state.chaser && state.targets) renderTargets();
  if (state.watcher && state.spots) renderSpots();
});
updateUnitsChip();

function loadUnits() {
  try {
    const saved = localStorage.getItem('units');
    if (saved) return saved === 'imperial';
  } catch {}
  return /^en-(US|LR|MM)$/i.test(navigator.language);
}

function updateUnitsChip() {
  $('toggle-units').textContent = state.imperial ? '°F · mi' : '°C · km';
}

// ---------------------------------------------------------------- radar

$('toggle-radar').addEventListener('click', () => (state.radarOn ? disableRadar() : enableRadar()));

async function enableRadar() {
  const btn = $('toggle-radar');
  await mapReady;
  try {
    const time = await showRadar(map);
    state.radarOn = true;
    $('radar-legend').hidden = false;
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = `Radar ${fmtTime(time.getTime() / 1000)}`;
  } catch (err) {
    showStatus(err.message, true);
  }
}

function disableRadar() {
  hideRadar(map);
  state.radarOn = false;
  $('radar-legend').hidden = true;
  $('toggle-radar').setAttribute('aria-pressed', 'false');
  $('toggle-radar').textContent = 'Radar';
}

// ---------------------------------------------------------------- routing + weather

function maybeRoute() {
  if (state.from && state.to) planRoute();
}

async function resolvePlace(which) {
  if (state[which]) return state[which];
  const q = $(which).value.trim();
  if (!q) return null;
  const [first] = await search(q, state.gps ?? state.from ?? state.to ?? mapCenter());
  if (!first) throw new Error(`Couldn't find "${q}"`);
  setPlace(which, first);
  return first;
}

// Fastest route first so there's something to look at quickly, then other
// options (I-40 vs I-10) are added as they arrive. A newer plan cancels older ones.
async function planRoute() {
  const token = ++state.planToken;
  const go = $('go');
  go.disabled = true;
  try {
    const from = await resolvePlace('from');
    const via = await resolvePlace('via');
    const to = await resolvePlace('to');
    if (!from || !to) throw new Error('Enter a start and a destination');

    showStatus('Finding the fastest route…');
    const route = await getRoute(via ? [from, via, to] : [from, to]);
    if (token !== state.planToken) return;

    showStatus('Getting forecasts along the route…');
    state.baseTime = now();
    const option = await buildOption(route);
    await mapReady;
    if (token !== state.planToken) return;
    hideStatus();
    state.options = [option];
    state.roads = null;
    state.roadError = null;
    selectOption(0);
    fitRoute();
    loadRoadReports(token);

    if (via) {
      $('alt-status').textContent = 'Clear the "Via" stop to compare other routes.';
    } else {
      findAlternatives(token, from, to);
    }
  } catch (err) {
    if (token === state.planToken) showStatus(err.message, true);
  } finally {
    if (token === state.planToken) go.disabled = false;
  }
}

async function buildOption(route) {
  const samples = samplePoints(route);
  const hours = MAX_DEPART_HOURS + route.duration / 3600 + 13;
  const forecasts = await fetchForecasts(samples, hours);
  return { route, samples, forecasts };
}

async function findAlternatives(token, from, to) {
  $('alt-status').textContent = 'Looking for other routes… (long trips can take up to a minute)';
  try {
    const routes = await getAlternatives(from, to, state.options.map((o) => o.route));
    if (token !== state.planToken) return;
    const built = await Promise.allSettled(routes.map(buildOption));
    if (token !== state.planToken) return;
    const current = state.route;
    state.options = [...state.options, ...built.filter((b) => b.status === 'fulfilled').map((b) => b.value)]
      .sort((a, b) => a.route.duration - b.route.duration);
    state.selected = state.options.findIndex((o) => o.route === current);
    $('alt-status').textContent = state.options.length > 1 ? 'Tap a route, or a grey line on the map, to switch.' : 'No other sensible routes found.';
    render();
  } catch {
    if (token === state.planToken) $('alt-status').textContent = 'Couldn\'t load alternative routes.';
  }
}

function selectOption(i) {
  const opt = state.options[i];
  if (!opt) return;
  state.selected = i;
  state.route = opt.route;
  state.samples = opt.samples;
  state.forecasts = opt.forecasts;
  render();
}

function fitRoute() {
  const b = new maplibregl.LngLatBounds();
  for (const o of state.options) o.route.coords.forEach((c) => b.extend(c));
  const wide = window.innerWidth > 700;
  const panel = $('panel').getBoundingClientRect();
  map.fitBounds(b, {
    padding: wide
      ? { top: 60, bottom: 60, left: Math.min(panel.right + 40, window.innerWidth * 0.6), right: 60 }
      : { top: 60, bottom: Math.min(panel.height + 30, window.innerHeight * 0.6), left: 30, right: 30 },
    duration: 800,
  });
}

function render() {
  const { route, samples, forecasts } = state;
  const t0 = departAt();
  const pts = alongRoute(samples, forecasts, t0);

  drawAlternatives();
  colorRoute(pts);
  drawWeatherMarkers(pts);
  renderOptions(t0);
  renderSummary(route, pts);
  renderIntercept(pts);
  renderRoadReports(pts);
  renderTimeline(pts);
  renderAlerts(pts);
  renderDestination(pts[pts.length - 1]);
  renderSteps(route);
  renderBestTime(t0);
  updateDepartLabel();
  $('results').hidden = false;
}

function drawAlternatives() {
  map.getSource('alts').setData({
    type: 'FeatureCollection',
    features: state.options
      .map((o, idx) => ({ type: 'Feature', properties: { idx }, geometry: { type: 'LineString', coordinates: o.route.coords } }))
      .filter((f) => f.properties.idx !== state.selected),
  });
}

// One card per route option, compared at the chosen departure time.
function renderOptions(t0) {
  const stats = state.options.map((o) => {
    const pts = alongRoute(o.samples, o.forecasts, t0);
    const sevs = pts.map((p) => p.wx?.severity ?? 0);
    const last = pts[pts.length - 1];
    return {
      time: last.eta - t0, // weather-adjusted drive time
      delay: last.delay,
      worst: Math.max(...sevs),
      rough: roughStretches(sevs),
      wet: sevs.filter((s) => s >= 1).length,
      score: routeScore(o.samples, o.forecasts, t0),
      storms: pts.filter((p) => p.wx?.code >= 95).length,
    };
  });
  const fastest = stats.reduce((best, s, i) => (s.time < stats[best].time ? i : best), 0);
  const calmest = stats.reduce((best, s, i) => (s.score < stats[best].score ? i : best), 0);
  const stormiest = stats.reduce((best, s, i) => (s.storms > stats[best].storms ? i : best), 0);

  $('route-options').replaceChildren(...state.options.map((o, i) => {
    const s = stats[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `route-option sev-${s.worst}${i === state.selected ? ' selected' : ''}`;

    const title = document.createElement('div');
    title.className = 'ro-title';
    title.textContent = o.route.roads.length ? `via ${o.route.roads.join(', ')}` : `Route ${i + 1}`;
    const tags = [];
    if (state.options.length > 1 && i === fastest) tags.push('Fastest');
    if (state.options.length > 1 && i === calmest && stats[calmest].score < stats[fastest].score - 0.5 && !state.chaser) tags.push('Calmest');
    if (state.chaser && stats[stormiest].storms > 0 && i === stormiest) tags.push('Most storms');
    for (const t of tags) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = t;
      title.append(tag);
    }

    const meta = document.createElement('div');
    meta.className = 'ro-meta';
    const extra = s.time - stats[fastest].time;
    meta.textContent = `${fmtDist(o.route.distance)} · ${fmtDuration(s.time)}${extra > 120 ? ` (+${fmtDuration(extra)})` : ''}`
      + (s.delay >= 300 ? ` · incl. ${fmtDuration(s.delay)} for weather` : '');

    const wx = document.createElement('div');
    wx.className = 'ro-wx';
    wx.textContent = s.rough
      ? `⚠️ ${s.rough} rough stretch${s.rough > 1 ? 'es' : ''} · worst: ${SEVERITY_LABEL[s.worst].toLowerCase()}`
      : s.wet ? '🌦️ Some light weather' : '👍 Good driving weather';
    if (s.storms) wx.textContent += ` · ⛈️ ${s.storms} storm point${s.storms > 1 ? 's' : ''}`;

    btn.append(title, meta, wx);
    btn.addEventListener('click', () => selectOption(i));
    return btn;
  }));
}

// ---------------------------------------------------------------- official road reports

function wsdotCode() {
  try { return localStorage.getItem('wsdotCode') ?? ''; } catch { return ''; }
}

$('wsdot-code').value = wsdotCode();
$('wsdot-save').addEventListener('click', () => {
  const code = $('wsdot-code').value.trim();
  try { localStorage.setItem('wsdotCode', code); } catch {}
  $('settings').open = false;
  if (state.route) {
    state.roads = null;
    state.roadError = null;
    render(); // shows "Loading…" or the add-a-code hint straight away
    loadRoadReports(state.planToken);
  }
});

async function loadRoadReports(token) {
  const code = wsdotCode();
  if (!code || !state.options.some((o) => inWashington(o.route))) return;
  try {
    const data = await fetchWsdot(code);
    if (token !== state.planToken) return;
    state.roads = data;
  } catch (err) {
    if (token !== state.planToken) return;
    state.roadError = err.message;
  }
  if (state.forecasts) render();
}

// WSDOT incidents, closures and mountain passes on the selected route, in driving
// order, with when you'll get there.
function renderRoadReports(pts) {
  state.roadMarkers.forEach((m) => m.remove());
  state.roadMarkers = [];
  const section = $('road-section');
  const list = $('road-reports');
  section.hidden = !inWashington(state.route);
  if (section.hidden) return;

  const item = (cls, text) => {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    return li;
  };
  if (!wsdotCode()) {
    list.replaceChildren(item('sev-1', 'Add a free WSDOT access code in Settings (bottom of this panel) to see closures, incidents and mountain pass conditions on this route.'));
    return;
  }
  if (state.roadError) {
    list.replaceChildren(item('sev-1', state.roadError));
    return;
  }
  if (!state.roads) {
    list.replaceChildren(item('', 'Loading WSDOT road reports…'));
    return;
  }

  const reports = [
    ...onRoute(state.roads.passes, state.route).map((p) => ({ ...p, kind: 'pass' })),
    ...onRoute(state.roads.alerts, state.route).map((a) => ({ ...a, kind: 'alert' })),
  ].sort((a, b) => a.along - b.along);
  if (!reports.length) {
    list.replaceChildren(item('ok', '✅ No WSDOT incidents, closures or pass restrictions on this route right now.'));
    return;
  }

  list.replaceChildren(...reports.map((r) => {
    const sev = reportSeverity(r);
    const when = `${fmtDist(r.along)} in, ~${fmtTime(etaAlong(pts, r.along))}`;
    const sentence = (s) => `${s.trim().replace(/\.+$/, '')}.`;
    const text = r.kind === 'pass'
      ? `⛰️ ${r.name}${r.elevationFt ? ` (${fmtElevation(r.elevationFt)})` : ''} · ${when}: `
        + [r.road || 'No road report', ...(r.restrictions.length ? r.restrictions : ['No restrictions'])].map(sentence).join(' ')
        + (r.tempF != null ? ` ${fmtTemp(((r.tempF - 32) * 5) / 9)} now.` : '')
      : `🚧 ${r.category || 'Alert'} · ${when}: ${truncate(r.headline ?? '', 160)}`;
    const el = document.createElement('div');
    el.className = `road-marker sev-${sev}`;
    el.textContent = r.kind === 'pass' ? '⛰️' : '🚧';
    const popup = new maplibregl.Popup({ offset: 12, maxWidth: '280px' }).setText(text);
    state.roadMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat]).setPopup(popup).addTo(map));
    return item(`sev-${sev}`, text);
  }));
}

// Weather-adjusted arrival time at a distance along the route.
function etaAlong(pts, along) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (along <= b.dist) return a.eta + ((b.eta - a.eta) * (along - a.dist)) / Math.max(b.dist - a.dist, 1);
  }
  return pts[pts.length - 1].eta;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Stretches of weather (runs of points rated minor or worse, as in the alerts list)
// that reach "caution" or worse somewhere.
function roughStretches(sevs) {
  let count = 0;
  let runWorst = -1;
  for (const s of [...sevs, 0]) {
    if (s >= 1) runWorst = Math.max(runWorst, s);
    else {
      if (runWorst >= 2) count++;
      runWorst = -1;
    }
  }
  return count;
}

function colorRoute(pts) {
  const features = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const sev = Math.max(a.wx?.severity ?? -1, b.wx?.severity ?? -1);
    features.push({
      type: 'Feature',
      properties: { sev },
      geometry: { type: 'LineString', coordinates: state.route.coords.slice(a.index, b.index + 1) },
    });
  }
  map.getSource('route').setData({ type: 'FeatureCollection', features });
}

function drawWeatherMarkers(pts) {
  state.markers.forEach((m) => m.remove());
  state.markers = [];
  // Keep the map readable: at most ~14 bubbles, always including the destination.
  const every = Math.max(1, Math.ceil(pts.length / 14));
  pts.forEach((p, i) => {
    if (!p.wx || (i % every !== 0 && i !== pts.length - 1)) return;
    const el = document.createElement('div');
    el.className = `wx-marker sev-${p.wx.severity}`;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = p.wx.icon;
    el.append(ic, fmtTemp(p.wx.temp));
    const popup = new maplibregl.Popup({ offset: 14 }).setDOMContent(detailCard(p));
    state.markers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).setPopup(popup).addTo(map));
  });
}

function detailCard(p) {
  const w = p.wx;
  const lines = [
    `${w.icon} ${w.label} · ${SEVERITY_LABEL[w.severity]}`,
    `${fmtDayTime(p.eta)} · ${fmtDist(p.dist)} in`,
    `${fmtTemp(w.temp)} (feels ${fmtTemp(w.feels)})`,
    `Precip ${fmtPrecip(w.precip)} · ${Math.round(w.pop ?? 0)}% chance`,
    `Wind ${fmtSpeed(w.wind)}, gusts ${fmtSpeed(w.gusts)}`,
  ];
  if (Number.isFinite(w.visibility) && w.visibility < 10000) lines.push(`Visibility ${fmtDist(w.visibility)}`);
  return card(lines);
}

function card(lines) {
  const div = document.createElement('div');
  lines.forEach((text, i) => {
    const el = document.createElement(i === 0 ? 'strong' : 'div');
    el.textContent = text;
    div.append(el);
  });
  return div;
}

// Drive time and arrival include the weather slow-down; the label says how much.
function renderSummary(route, pts) {
  const last = pts[pts.length - 1];
  const items = [
    [fmtDist(route.distance), 'distance'],
    [fmtDuration(last.eta - pts[0].eta), last.delay >= 60 ? `drive time (+${fmtDuration(last.delay)} weather)` : 'drive time'],
    [fmtTime(last.eta), 'arrival'],
  ];
  $('summary').replaceChildren(...items.map(([v, l]) => {
    const d = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = v;
    const s = document.createElement('span');
    s.textContent = l;
    d.append(b, s);
    return d;
  }));
}

function renderTimeline(pts) {
  $('timeline').replaceChildren(...pts.map((p) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `tl-cell sev-${p.wx?.severity ?? 0}`;
    cell.title = p.wx ? `${p.wx.label}, ${fmtTemp(p.wx.temp)} at ${fmtTime(p.eta)}` : 'Beyond forecast range';
    const icon = document.createElement('span');
    icon.className = 'tl-icon';
    icon.textContent = p.wx?.icon ?? '–';
    const temp = document.createElement('span');
    temp.textContent = p.wx ? fmtTemp(p.wx.temp) : '';
    const time = document.createElement('span');
    time.className = 'tl-time';
    time.textContent = fmtTime(p.eta, true);
    cell.append(icon, temp, time);
    cell.addEventListener('click', () => {
      map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 9) });
      if (p.wx) new maplibregl.Popup({ offset: 14 }).setLngLat([p.lon, p.lat]).setDOMContent(detailCard(p)).addTo(map);
    });
    return cell;
  }));
}

// Collapse consecutive bad-weather samples into stretches, e.g. "Rain from 40–65 mi".
function renderAlerts(pts) {
  const items = [];
  let run = null;
  const flush = () => { if (run) items.push(run); run = null; };
  for (const p of pts) {
    if (p.wx && p.wx.severity >= 1) {
      if (!run) run = { start: p, end: p, worst: p };
      run.end = p;
      if (p.wx.severity > run.worst.wx.severity || (p.wx.severity === run.worst.wx.severity && p.wx.precip > run.worst.wx.precip)) run.worst = p;
    } else {
      flush();
    }
  }
  flush();

  const lis = items.map(({ start, end, worst }) => {
    const li = document.createElement('li');
    li.className = `sev-${worst.wx.severity}`;
    const at = (p) => (p.dist < 100 ? 'the start' : fmtDist(p.dist));
    const where = start === end ? `around ${at(start)}` : `${start.dist < 100 ? 'from the start to' : `${fmtDist(start.dist)} –`} ${fmtDist(end.dist)}`;
    const when = start === end ? fmtTime(start.eta) : `${fmtTime(start.eta)} – ${fmtTime(end.eta)}`;
    const extra = [];
    if (worst.wx.precip >= 0.1) extra.push(`${fmtPrecip(worst.wx.precip)}/h`);
    if (worst.wx.gusts >= 45) extra.push(`gusts ${fmtSpeed(worst.wx.gusts)}`);
    if (worst.wx.visibility < 1000) extra.push(`visibility ${fmtDist(worst.wx.visibility)}`);
    li.textContent = `${worst.wx.icon} ${worst.wx.label} ${where} (${when})${extra.length ? ` · ${extra.join(', ')}` : ''}`;
    return li;
  });

  const icy = pts.find((p) => p.wx && p.wx.temp <= 1 && (p.wx.precip > 0 || p.wx.snowfall > 0));
  if (icy) {
    const li = document.createElement('li');
    li.className = 'sev-3';
    li.textContent = `🧊 Possible icy roads around ${fmtDist(icy.dist)} (${fmtTime(icy.eta)}): ${fmtTemp(icy.wx.temp)} with precipitation`;
    lis.unshift(li);
  }

  const missing = pts.filter((p) => !p.wx).length;
  if (missing) {
    const li = document.createElement('li');
    li.className = 'sev-1';
    li.textContent = `Forecast doesn't reach ${missing} later point${missing > 1 ? 's' : ''} on this trip.`;
    lis.push(li);
  }

  if (!lis.length) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = '👍 No significant weather expected along the way.';
    lis.push(li);
  }
  $('alerts').replaceChildren(...lis);
}

function renderDestination(last) {
  const box = $('dest');
  box.replaceChildren();
  if (!last.wx) {
    box.textContent = 'Arrival is beyond the forecast range.';
    return;
  }
  const w = last.wx;
  const now = document.createElement('div');
  now.className = 'dest-now';
  const big = document.createElement('span');
  big.className = 'big';
  big.textContent = w.icon;
  const info = document.createElement('div');
  const temp = document.createElement('b');
  temp.textContent = fmtTemp(w.temp);
  const desc = document.createElement('small');
  desc.textContent = `${w.label} when you arrive (${fmtDayTime(last.eta)})`;
  const more = document.createElement('small');
  more.textContent = `Feels ${fmtTemp(w.feels)} · wind ${fmtSpeed(w.wind)} · ${Math.round(w.pop ?? 0)}% precip`;
  info.append(temp, desc, more);
  now.append(big, info);

  // The 12 hours after arrival, hour by hour.
  const series = state.forecasts[state.forecasts.length - 1];
  const hourly = document.createElement('div');
  hourly.className = 'hourly';
  const startHour = Math.ceil(last.eta / 3600) * 3600;
  for (let h = 0; h < 12; h++) {
    const t = startHour + h * 3600;
    const c = conditionsAt(series, t);
    if (!c) break;
    const cell = document.createElement('div');
    const time = document.createElement('span');
    time.textContent = fmtTime(t, true);
    const icon = document.createElement('span');
    icon.className = 'h-icon';
    icon.textContent = c.icon;
    const tmp = document.createElement('span');
    tmp.textContent = fmtTemp(c.temp);
    const pop = document.createElement('span');
    pop.className = 'h-pop';
    pop.textContent = `${Math.round(c.pop ?? 0)}%`;
    cell.append(time, icon, tmp, document.createElement('br'), pop);
    cell.title = c.label;
    hourly.append(cell);
  }
  box.append(now, hourly);
}

function renderSteps(route) {
  $('steps').replaceChildren(...route.steps.map((s) => {
    const li = document.createElement('li');
    li.textContent = s.text;
    if (s.distance > 0) {
      const small = document.createElement('small');
      small.textContent = ` · ${fmtDist(s.distance)}`;
      li.append(small);
    }
    return li;
  }));
}

// Scan departure times in the window and suggest one if it's clearly better.
// Not useful when you're trying to drive *into* weather, so off in chaser mode.
function renderBestTime(t0) {
  const el = $('best-time');
  if (state.chaser || state.watcher) {
    el.hidden = true;
    return;
  }
  const current = routeScore(state.samples, state.forecasts, t0);
  let best = { offset: state.departOffset, score: current };
  for (let h = 0; h <= MAX_DEPART_HOURS; h += 0.5) {
    const s = routeScore(state.samples, state.forecasts, state.baseTime + h * 3600);
    if (s < best.score - 0.5) best = { offset: h, score: s };
  }
  if (best.offset === state.departOffset || current - best.score < 2) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = `🕑 Leaving ${fmtDayTime(state.baseTime + best.offset * 3600)} looks like a calmer drive.`;
  const btn = document.createElement('button');
  btn.textContent = 'Use that time';
  btn.addEventListener('click', () => {
    state.departOffset = best.offset;
    $('depart').value = best.offset;
    render();
  });
  el.append(btn);
}

// ---------------------------------------------------------------- storm chaser

// Chaser and watcher are two takes on the same storms, so only one is on at a time.
// They share the radar, the storm-potential map layer and the NWS warnings.
$('toggle-chaser').addEventListener('click', () => setMode(state.chaser ? null : 'chaser'));
$('toggle-watcher').addEventListener('click', () => setMode(state.watcher ? null : 'watcher'));
$('scan').addEventListener('click', scanArea);
$('watch-scan').addEventListener('click', scanViewArea);

function setMode(mode) {
  state.chaser = mode === 'chaser';
  state.watcher = mode === 'watcher';
  $('toggle-chaser').setAttribute('aria-pressed', String(state.chaser));
  $('toggle-watcher').setAttribute('aria-pressed', String(state.watcher));
  $('chaser').hidden = !state.chaser;
  $('watcher').hidden = !state.watcher;
  $('panel').classList.remove('collapsed');
  state.targets = null;
  state.spots = null;
  if (state.target && state.target.kind !== (state.chaser ? 'chase' : 'watch')) state.target = null;

  mapReady.then(() => {
    map.getSource('storm-grid').setData(emptyFC());
    map.getSource('watch').setData(emptyFC());
    if (!mode) map.getSource('nws').setData(emptyFC());
  });
  if (mode) {
    if (!state.radarOn) enableRadar();
    focusOnAnchors().then(() => {
      loadWarnings(state.chaser ? 'warnings' : 'watch-warnings');
      if (state.chaser) scanArea();
      else scanViewArea();
    });
  }
  if (state.forecasts) render();
}

// The places that matter to the driver: where they are (GPS), where they're
// starting and where they're going. Scans start around these and rank nearby
// results higher.
function anchors() {
  return [state.gps, state.from, state.to].filter(Boolean);
}

function originPoint(center) {
  return state.gps ?? state.from ?? center;
}

function fromLabel() {
  return state.gps ? 'from you' : state.from ? 'from your start' : 'from the map centre';
}

// Before a storm scan, bring the driver's places into view so the scan covers them.
async function focusOnAnchors() {
  await mapReady;
  const pts = anchors();
  if (!pts.length) return;
  const bounds = new maplibregl.LngLatBounds();
  pts.forEach((p) => bounds.extend([p.lon, p.lat]));
  // Single place, or places close together: show ~150 km around them.
  const pad = 1.4;
  bounds.extend([bounds.getWest() - pad, bounds.getSouth() - pad]);
  bounds.extend([bounds.getEast() + pad, bounds.getNorth() + pad]);
  map.fitBounds(bounds, { padding: 40, maxZoom: 9, duration: 0 });
}

// Quietly pick up the GPS position at start-up if the user has already allowed it.
navigator.permissions?.query({ name: 'geolocation' }).then((p) => {
  if (p.state !== 'granted') return;
  currentPosition().then((pos) => { state.gps = { lat: pos.coords.latitude, lon: pos.coords.longitude }; }).catch(() => {});
}).catch(() => {});

// Roughly what's on screen: a 100–600 km radius around the map centre.
function scanRadius() {
  const center = mapCenter();
  const bounds = map.getBounds();
  const halfWidth = haversine([center.lon, center.lat], [bounds.getEast(), center.lat]) / 1000;
  return { center, radius: Math.round(Math.min(600, Math.max(100, halfWidth))) };
}

function drawStormCells(cells) {
  map.getSource('storm-grid').setData({
    type: 'FeatureCollection',
    features: cells.map((c) => ({
      type: 'Feature',
      properties: { score: c.score, cell: JSON.stringify(c) },
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    })),
  });
}

async function scanArea() {
  await mapReady;
  const { center, radius } = scanRadius();
  const origin = originPoint(center);

  $('scan').disabled = true;
  $('scan-status').textContent = `Scanning ${fmtDist(radius * 1000)} around the map centre for the next 12 hours…`;
  try {
    const cells = await scanStorms(center, radius);
    if (!state.chaser) return;
    state.targets = pickTargets(cells, origin, radius, { anchors: anchors() });
    drawStormCells(cells);
    $('scan-status').textContent = state.targets.length
      ? `Best storm potential within ${fmtDist(radius * 1000)} (distances ${fromLabel()}):`
      : `No thunderstorm potential within ${fmtDist(radius * 1000)} in the next 12 hours.${windNote(cells, center) || ' Zoom out or move the map, then scan again.'}`;
    renderTargets();
  } catch (err) {
    $('scan-status').textContent = err.message;
  } finally {
    $('scan').disabled = false;
  }
}

function renderTargets() {
  $('targets').replaceChildren(...state.targets.map((t) => {
    const li = document.createElement('li');
    li.className = `sev-${t.level.sev}`;
    const info = document.createElement('div');
    info.textContent = `${t.icon} ${t.level.label} · ${t.score}/100`;
    const small = document.createElement('small');
    small.textContent = `Peaks ~${fmtDayTime(t.time)} · ${fmtDist(t.dist)} ${t.bearing}${t.cape ? ` · CAPE ${Math.round(t.cape)}` : ''}`
      + (t.reachable ? '' : ' · probably too far to reach in time');
    info.append(small);
    const btn = document.createElement('button');
    btn.textContent = 'Chase';
    btn.addEventListener('click', () => chase(t));
    li.append(info, btn);
    li.addEventListener('mouseenter', () => map.easeTo({ center: [t.lon, t.lat], duration: 400 }));
    return li;
  }));
}

function stormCard(c) {
  if (c.height !== undefined) {
    return card([
      `🌊 ${c.level.label} surf · ${c.score}/100`,
      `Peak around ${fmtDayTime(c.time)}`,
      `Waves ${fmtHeight(c.height)}, every ${Math.round(c.period ?? 0)} s · gusts ${fmtSpeed(c.gusts)}`,
    ]);
  }
  return card([
    `${c.icon} ${c.level.label} storm potential · ${c.score}/100`,
    `Peak around ${fmtDayTime(c.time)}`,
    `CAPE ${Math.round(c.cape ?? 0)} J/kg · lifted index ${c.li?.toFixed(1) ?? '–'}`,
    `${Math.round(c.pop ?? 0)}% precip chance · gusts ${fmtSpeed(c.gusts)}`,
  ]);
}

async function chase(target) {
  if (!state.from && !$('from').value.trim()) {
    try {
      await useMyLocation();
    } catch {
      $('scan-status').textContent = 'Set a start point first (or allow location access), then press Chase.';
      $('from').focus();
      return;
    }
  }
  setPlace('via', null);
  setPlace('to', { lat: target.lat, lon: target.lon, label: `Storm target · ${target.level.label} (${target.score}/100)` });
  goTo({ ...target, kind: 'chase' });
}

function goTo(target) {
  state.target = target;
  state.departOffset = 0;
  $('depart').value = 0;
  planRoute();
}

// ---------------------------------------------------------------- storm watcher

document.querySelectorAll('#watcher .segmented button').forEach((btn) => btn.addEventListener('click', () => {
  state.watchKind = btn.dataset.kind;
  document.querySelectorAll('#watcher .segmented button').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
  document.querySelectorAll('#watcher [data-for]').forEach((el) => { el.hidden = el.dataset.for !== state.watchKind; });
  if (state.target?.kind === 'watch') state.target = null;
  scanViewArea();
}));

async function scanViewArea() {
  await mapReady;
  const { center, radius } = scanRadius();
  const kind = state.watchKind;
  $('watch-scan').disabled = true;
  $('spots').replaceChildren();
  map.getSource('watch').setData(emptyFC());
  try {
    if (kind === 'coast') await scanCoastArea(center, radius);
    else await scanThunderArea(center, radius);
  } catch (err) {
    $('watch-status').textContent = err.message;
  } finally {
    $('watch-scan').disabled = false;
  }
}

async function scanCoastArea(center, radius) {
  $('watch-status').textContent = `Looking for big surf and wind along the coast within ${fmtDist(radius * 1000)} over the next 36 hours…`;
  const { cells, spots, noCoast } = await scanCoast(center, radius, { anchors: anchors(), origin: originPoint(center) });
  if (!state.watcher || state.watchKind !== 'coast') return;
  state.spots = spots;
  drawStormCells(cells);
  map.getSource('watch').setData({
    type: 'FeatureCollection',
    features: spots.map((s, idx) => ({ type: 'Feature', properties: { idx }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
  });
  $('watch-status').textContent = spots.length
    ? `Best coastal spots (distances ${fromLabel()}):`
    : noCoast
      ? 'No coastline in view. Move the map over a coast and scan again.'
      : `No big surf or strong wind on this coast in the next 36 hours.`;
  renderSpots();
}

async function scanThunderArea(center, radius) {
  $('watch-status').textContent = `Looking for storms and viewing spots within ${fmtDist(radius * 1000)} over the next 12 hours…`;
  const { cells, spots } = await scanViewing(center, radius, { origin: originPoint(center), anchors: anchors() });
  if (!state.watcher || state.watchKind !== 'thunder') return;
  state.spots = spots;
  drawStormCells(cells);
  map.getSource('watch').setData({
    type: 'FeatureCollection',
    features: spots.flatMap((s, idx) => [
      { type: 'Feature', properties: { idx }, geometry: { type: 'LineString', coordinates: [[s.lon, s.lat], [s.stormLon, s.stormLat]] } },
      { type: 'Feature', properties: { idx }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } },
    ]),
  });
  const strongest = Math.max(0, ...cells.map((c) => c.score));
  const wind = windNote(cells, center);
  $('watch-status').textContent = spots.length
    ? `Best viewing spots (distances ${fromLabel()}):`
    : strongest >= 40
      ? 'There are storms around, but no dry spot with a clear view of them. Try zooming out and scanning again.'
      : `No thunderstorms worth watching within ${fmtDist(radius * 1000)} in the next 12 hours.${wind ? `${wind} Try "🌊 Wind & waves" above.` : ' Zoom out or move the map, then scan again.'}`;
  renderSpots();
}

function spotSummary(s) {
  if (s.show === 'waves') return { show: `🌊 ${s.name}`, title: `🌊 ${s.name} · ${s.score}/100` };
  const show = s.show === 'lightning' ? '⚡ Lightning show' : '🌩️ Storm structure';
  return { show, title: `${show} · ${s.score}/100` };
}

function spotDetail(s) {
  if (s.show === 'waves') {
    return `Best ~${fmtDayTime(s.time)} · waves ${fmtHeight(s.waveHeight)} every ${Math.round(s.period)} s`
      + ` · gusts ${fmtSpeed(s.gusts)} · ${fmtDist(s.dist)} ${fromLabel()}`;
  }
  return `Best ~${fmtDayTime(s.time)} · look ${s.look}, storm ${fmtDist(s.stormKm * 1000)} away`
    + `${s.moving ? `, moving ${s.moving}` : ''} · ${fmtDist(s.dist)} ${fromLabel()}`;
}

function renderSpots() {
  $('spots').replaceChildren(...state.spots.map((s) => {
    const li = document.createElement('li');
    li.className = `sev-${s.level.sev}`;
    const info = document.createElement('div');
    info.textContent = spotSummary(s).title;
    const small = document.createElement('small');
    small.textContent = spotDetail(s) + (s.reachable ? '' : ' · probably too far to reach in time');
    info.append(small);
    const btn = document.createElement('button');
    btn.textContent = 'Go';
    btn.addEventListener('click', () => watchFrom(s));
    li.append(info, btn);
    li.addEventListener('mouseenter', () => map.easeTo({ center: [s.lon, s.lat], duration: 400 }));
    return li;
  }));
}

// Storms typically move at roughly 70% of the 500 hPa wind speed.
function spotCard(s) {
  if (s.show === 'waves') {
    return card([
      spotSummary(s).title,
      `Best around ${fmtDayTime(s.time)}`,
      `Waves ${fmtHeight(s.waveHeight)}, every ${Math.round(s.period)} s`,
      `Gusts ${fmtSpeed(s.gusts)} from the ${compassName(s.windFrom)}`,
    ]);
  }
  return card([
    spotSummary(s).title,
    `Best around ${fmtDayTime(s.time)}`,
    `Look ${s.look}: storm ${fmtDist(s.stormKm * 1000)} away${s.moving ? `, moving ${s.moving}${s.speedKmh ? ` at ~${fmtSpeed(s.speedKmh * 0.7)}` : ''}` : ''}`,
    s.show === 'lightning' ? 'After dark, so lightning is the show' : 'Daylight, so cloud structure is the show',
  ]);
}

async function watchFrom(spot) {
  if (!state.from && !$('from').value.trim()) {
    try {
      await useMyLocation();
    } catch {
      $('watch-status').textContent = 'Set a start point first (or allow location access), then press Go.';
      $('from').focus();
      return;
    }
  }
  setPlace('via', null);
  setPlace('to', { lat: spot.lat, lon: spot.lon, label: `Viewing spot · ${spotSummary(spot).show}` });
  goTo({ ...spot, kind: 'watch' });
}

// Will we get to the target around when the storms are expected?
function renderIntercept(pts) {
  const el = $('intercept');
  const t = state.target;
  const active = t && ((t.kind === 'chase' && state.chaser) || (t.kind === 'watch' && state.watcher));
  if (!active) {
    el.hidden = true;
    return;
  }
  const arrive = pts[pts.length - 1].eta;
  const diff = arrive - t.time;
  let text;
  let late = false;
  if (t.kind === 'watch' && t.show === 'waves') {
    const what = `waves ${fmtHeight(t.waveHeight)}, gusts ${fmtSpeed(t.gusts)}`;
    if (diff <= 0) text = `🌊 You arrive ${fmtTime(arrive)}, before the peak around ${fmtDayTime(t.time)} (${what}).`;
    else if (diff <= 3600) text = `🌊 You arrive ${fmtTime(arrive)}, just after the peak (${fmtTime(t.time)}, ${what}).`;
    else {
      late = true;
      text = `You arrive ${fmtDuration(diff)} after the peak (${fmtDayTime(t.time)}). The surf may have eased; scan again.`;
    }
  } else if (t.kind === 'watch') {
    const look = `Look ${t.look}: the storm should be ${fmtDist(t.stormKm * 1000)} away${t.moving ? `, moving ${t.moving}` : ''}.`;
    if (diff <= 0) text = `🔭 You arrive ${fmtTime(arrive)}, before the best viewing around ${fmtTime(t.time)}. ${look}`;
    else if (diff <= 3600) text = `🔭 You arrive ${fmtTime(arrive)}, just after the best viewing time (${fmtTime(t.time)}). ${look}`;
    else {
      late = true;
      text = `You arrive ${fmtDuration(diff)} after the best viewing time (${fmtTime(t.time)}). The storm will have moved; scan again for a closer spot.`;
    }
  } else if (diff < -2 * 3600) text = `You arrive ${fmtDuration(-diff)} before the expected peak. Plenty of time to pick a spot.`;
  else if (diff <= 1800) text = `🎯 Good intercept: you arrive ${fmtTime(arrive)}, storms expected to peak around ${fmtTime(t.time)}.`;
  else {
    late = true;
    text = `You arrive ${fmtDuration(diff)} after the expected peak (${fmtTime(t.time)}). Storms may have moved on; scan again for a closer target.`;
  }
  el.hidden = false;
  el.className = `intercept${late ? ' late' : ''}`;
  el.textContent = text;
}

// Thunderstorm alerts nationwide (with polygons on the map), then any other alerts
// (wind, surf, flood, winter…) covering the area on screen.
async function loadWarnings(boxId) {
  const box = $(boxId);
  const line = (text, strong = false) => {
    const el = document.createElement(strong ? 'strong' : 'div');
    el.textContent = text;
    box.append(el);
  };
  await mapReady;
  const { center, radius } = scanRadius();
  const [storms, local] = await Promise.allSettled([
    fetchWarnings(),
    fetchLocalAlerts([center, ...[0, 90, 180, 270].map((b) => offset(center, b, radius / 2))]),
  ]);
  box.replaceChildren();

  if (storms.status === 'fulfilled') {
    const { alerts, polygons } = storms.value;
    map.getSource('nws').setData(polygons);
    const warnings = polygons.features.length;
    const watches = alerts.length - warnings;
    if (!alerts.length) {
      line('No tornado, severe thunderstorm or flash flood alerts in the US right now.');
    } else {
      line(`NWS: ${warnings} storm warning${warnings === 1 ? '' : 's'} on the map, ${watches} watch${watches === 1 ? '' : 'es'}/zone alert${watches === 1 ? '' : 's'} (US)`, true);
      for (const a of alerts.slice(0, 6)) line(`${a.properties.event}: ${a.properties.area}`);
    }
  } else {
    line('NWS storm alerts unavailable (US only).');
  }

  const others = local.status === 'fulfilled' ? local.value.filter((a) => !STORM_EVENTS.includes(a.event)) : [];
  if (others.length) {
    line('Other alerts around this area:', true);
    for (const a of others.slice(0, 6)) line(`${a.event}: ${a.area}`);
  }
}

// The point `km` from `p` in compass direction `brg` (flat-earth approximation, fine at this scale).
function offset(p, brg, km) {
  const r = (brg * Math.PI) / 180;
  return {
    lat: p.lat + (km / 111) * Math.cos(r),
    lon: p.lon + (km / (111 * Math.cos((p.lat * Math.PI) / 180))) * Math.sin(r),
  };
}

// "No thunderstorms, but…" for windstorm days like a Pacific Northwest blow.
function windNote(cells, center) {
  const w = windstorm(cells);
  if (!w) return '';
  const dir = compass(center, w);
  const where = haversine([center.lon, center.lat], [w.lon, w.lat]) < 30000 ? 'near the map centre' : `${fmtDist(haversine([center.lon, center.lat], [w.lon, w.lat]))} ${dir}`;
  return ` No thunderstorms, but it's a windstorm: gusts up to ${fmtSpeed(w.maxGusts)} around ${fmtDayTime(w.gustTime)}, strongest ${where}. These modes look for thunderstorms, so wind-only storms don't score.`;
}

// ---------------------------------------------------------------- live navigation

$('start-nav').addEventListener('click', startNavigation);
$('stop-nav').addEventListener('click', stopNavigation);

function startNavigation() {
  if (!state.route) return;
  state.departOffset = 0;
  state.baseTime = now();
  $('depart').value = 0;
  // Commit to the chosen route; alternatives are hidden while driving.
  state.options = [state.options[state.selected]];
  state.selected = 0;
  state.planToken++;
  render();

  document.body.classList.add('navigating');
  $('nav-banner').hidden = false;
  $('nav-instruction').textContent = 'Waiting for GPS…';
  $('nav-meta').textContent = '';
  $('nav-weather').textContent = '';

  let rerouting = false;
  state.nav = new Navigator(state.route, {
    onUpdate: updateNavigation,
    onError: (err) => { $('nav-meta').textContent = `Location error: ${err.message}`; },
    onOffRoute: async (here) => {
      if (rerouting) return;
      rerouting = true;
      $('nav-meta').textContent = 'Rerouting…';
      try {
        const route = await getRoute([here, state.to]);
        state.baseTime = now();
        state.options = [await buildOption(route)];
        selectOption(0);
        state.nav?.setRoute(route);
      } catch (err) {
        $('nav-meta').textContent = `Reroute failed: ${err.message}`;
      } finally {
        rerouting = false;
      }
    },
  });
  state.nav.start();
  keepAwake();
}

// iPhones stop sending GPS once the screen locks, so hold the screen on while
// navigating. The lock is dropped whenever the app is hidden; take it back on return.
async function keepAwake() {
  if (!('wakeLock' in navigator) || !state.nav) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Not allowed right now (e.g. low battery mode); navigation still works.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.nav) keepAwake();
});

function updateNavigation(u) {
  if (!state.meMarker) {
    const el = document.createElement('div');
    el.className = 'me-dot';
    state.meMarker = new maplibregl.Marker({ element: el });
  }
  state.meMarker.setLngLat(u.position).addTo(map);
  state.gps = { lon: u.position[0], lat: u.position[1] };

  const moving = u.speed != null && u.speed > 2 && u.heading != null && !Number.isNaN(u.heading);
  map.easeTo({ center: u.position, zoom: 16, pitch: 50, bearing: moving ? u.heading : map.getBearing(), duration: 900 });

  $('nav-instruction').textContent = u.next.text;
  const meta = (arrive) => `In ${fmtDist(u.toNext)} · ${fmtDist(u.remainingDist)} left · arrive ${fmtTime(arrive)}`;
  $('nav-meta').textContent = meta(now() + u.remainingTime);
  if (!state.forecasts) return;

  // Re-run the weather timeline from where we are now. Times are shifted by the
  // weather delay already "spent" behind us so only the road ahead slows us down.
  const elapsed = state.route.cumTime[state.route.cumTime.length - 1] - u.remainingTime;
  const pts = alongRoute(state.samples, state.forecasts, now() - elapsed);
  const behind = pts.filter((p) => p.dist <= u.along);
  const spent = behind.length ? behind[behind.length - 1].delay : 0;
  const dest = pts[pts.length - 1];
  $('nav-meta').textContent = meta(now() + u.remainingTime + (dest.delay - spent));

  // Next notable weather ahead of us.
  const ahead = pts.filter((p) => p.dist > u.along && p.wx);
  const hazard = ahead.find((p) => p.wx.severity >= 2);
  if (hazard) {
    $('nav-weather').textContent = `${hazard.wx.icon} ${hazard.wx.label} in ${fmtDist(hazard.dist - u.along)} (~${fmtTime(hazard.eta - spent)})`;
  } else if (dest.wx) {
    $('nav-weather').textContent = `Clear driving ahead · ${dest.wx.icon} ${fmtTemp(dest.wx.temp)} at destination`;
  }
}

function stopNavigation() {
  state.nav?.stop();
  state.nav = null;
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  state.meMarker?.remove();
  state.meMarker = null;
  document.body.classList.remove('navigating');
  $('nav-banner').hidden = true;
  map.easeTo({ pitch: 0, bearing: 0 });
  if (state.route) fitRoute();
}

// ---------------------------------------------------------------- helpers

function drawEndpoints() {
  state.endpointMarkers.forEach((m) => m.remove());
  state.endpointMarkers = [];
  const add = (p, color) => p && state.endpointMarkers.push(new maplibregl.Marker({ color }).setLngLat([p.lon, p.lat]).addTo(map));
  add(state.from, '#16a34a');
  add(state.via, '#7c3aed');
  add(state.to, '#dc2626');
}

function showStatus(text, isError = false) {
  const el = $('status');
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function hideStatus() {
  $('status').hidden = true;
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('not supported on this device'));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 });
  });
}

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function fmtTemp(c) {
  if (c == null) return '–';
  return state.imperial ? `${Math.round(c * 9 / 5 + 32)}°` : `${Math.round(c)}°`;
}

function fmtDist(m) {
  if (state.imperial) {
    const mi = m / 1609.344;
    if (mi < 0.2) return `${Math.round(m * 3.28084 / 50) * 50} ft`;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString()} mi`;
  }
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString()} km`;
}

function fmtSpeed(kmh) {
  if (kmh == null) return '–';
  return state.imperial ? `${Math.round(kmh / 1.609344)} mph` : `${Math.round(kmh)} km/h`;
}

function fmtElevation(ft) {
  return state.imperial ? `${ft.toLocaleString()} ft` : `${Math.round(ft * 0.3048).toLocaleString()} m`;
}

function fmtHeight(m) {
  if (m == null) return '–';
  return state.imperial ? `${Math.round(m * 3.28084)} ft` : `${m.toFixed(1)} m`;
}

function compassName(deg) {
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round((deg ?? 0) / 45) % 8];
}

function fmtPrecip(mm) {
  if (mm == null) return '–';
  return state.imperial ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
}

function fmtDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function fmtTime(t, short = false) {
  const opts = short ? { hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' };
  return new Date(t * 1000).toLocaleTimeString([], opts);
}

function fmtDayTime(t) {
  const d = new Date(t * 1000);
  const today = new Date();
  const days = Math.round((startOfDay(d) - startOfDay(today)) / 86400000);
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : d.toLocaleDateString([], { weekday: 'short' });
  return `${day} ${fmtTime(t)}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
