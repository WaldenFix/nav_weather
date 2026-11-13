import { search, reverse } from './geocode.js';
import { getRoute, getAlternatives, samplePoints, haversine, prettyRoad } from './route.js';
import { fetchForecasts, alongRoute, conditionsAt, routeScore } from './weather.js';
import { SEVERITY_LABEL } from './wmo.js';
import { showRadar, hideRadar } from './radar.js';
import { Navigator } from './nav.js';
import { scanStorms, pickTargets, fetchWarnings, fetchLocalAlerts, windstorm, compass, STORM_EVENTS } from './storm.js';
import { scanViewing } from './watch.js';
import { scanCoast } from './coast.js';
import { scanViews, hourAt, bestHour, nearbyCams, VIEW_KINDS } from './viewpoint.js';
import { fetchWsdot, inWashington, onRoute, reportSeverity } from './roads.js';

// OpenFreeMap: free, keyless vector tiles of OpenStreetMap (https://openfreemap.org).
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const MAX_DEPART_HOURS = 72;
// While driving, a weather warning lights up when it's this close (whichever comes first).
const ALERT_WITHIN_M = 65000;
const ALERT_WITHIN_S = 45 * 60;
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
  watchKind: 'view', // watcher: 'view' (fog & clouds at peaks), 'thunder' or 'coast'
  leaveAt: null, // chosen departure (unix s); null = now
  scanToken: 0,
  spotSel: null, // selected watch spot / chase target index
  gps: null, // last known device position
  roads: null, // WSDOT { alerts, passes } for the current plan
  roadError: null,
  roadMarkers: [],
  // GPS, start and destination bias searches and storm scans; see anchors().
  target: null, // storm target or viewing spot we're routing to; .kind is 'chase' or 'watch'
  themePref: loadTheme(), // 'auto', 'light', 'dark' or 'night'
  town: '', // town we're driving through, from reverse geocoding
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

// Phones pinch to zoom, so the zoom/compass buttons are hidden there (CSS). Without a
// compass there'd be no way back from a twisted or tilted map, so touch rotate and
// tilt are off on phones too. Navigation still turns the map with your heading.
const phone = matchMedia('(max-width: 700px)');
function fitGestures() {
  for (const handler of [map.dragRotate, map.touchPitch]) {
    if (phone.matches) handler.disable();
    else handler.enable();
  }
  if (phone.matches) map.touchZoomRotate.disableRotation();
  else map.touchZoomRotate.enableRotation();
}
fitGestures();
phone.addEventListener('change', fitGestures);

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
    paint: {
      'circle-color': ['coalesce', ['get', 'color'], '#7c3aed'],
      'circle-radius': ['case', ['boolean', ['get', 'sel'], false], 11, 8],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
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
  // Thins (to 55%) and fades further along the trip, where the forecast is less sure.
  const taper = ['-', 1, ['*', 0.45, ['coalesce', ['get', 't'], 0]]];
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'sev'], 0, SEV_COLORS[0], 1, SEV_COLORS[1], 2, SEV_COLORS[2], 3, SEV_COLORS[3], '#3b82f6'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['*', 4, taper], 14, ['*', 9, taper]],
      'line-opacity': ['-', 1, ['*', 0.4, ['coalesce', ['get', 't'], 0]]],
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
  map.on('click', 'watch-spots', (e) => selectSpot(e.features[0].properties.idx));
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

// ---------------------------------------------------------------- themes

// Light, Dark (warm charcoal) and Night (amber, for night driving). "Auto" follows
// the phone's light/dark setting, and switches to Night when you navigate in the dark.
const THEMES = ['auto', 'light', 'dark', 'night'];
const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark', night: 'Night' };
const THEME_ICON = { auto: '#i-auto', light: '#i-sun', dark: '#i-moon', night: '#i-glow' };
const systemDark = matchMedia('(prefers-color-scheme: dark)');

// Base-map colours for the dark themes. Light keeps OpenFreeMap's own colours.
// Night keeps roads faintly visible ("ghosted"), with highways brightest.
const MAP_COLORS = {
  dark: { land: '#15120f', water: '#1c2630', park: '#182019', building: '#1f1b17', major: '#4a4037', mid: '#3a332c', minor: '#2e2822', rail: '#2a241f', boundary: '#4a4037', label: '#a99f93', halo: '#15120f', icons: 0.6, relief: 0.22 },
  night: { land: '#000000', water: '#140b05', park: '#0a0704', building: '#0a0603', major: '#6a3c14', mid: '#45230b', minor: '#2a1608', rail: '#1f1007', boundary: '#45230b', label: '#b0672a', halo: '#000000', icons: 0.3, relief: 0.08 },
};
const OUR_SOURCES = new Set(['nws', 'storm-grid', 'watch', 'alts', 'route', 'radar']);
const originalPaint = new Map(); // "layer|property" -> value before we recoloured it

function loadTheme() {
  try {
    // Runs while `state` is being built, before THEMES exists.
    const saved = localStorage.getItem('theme');
    if (['light', 'dark', 'night'].includes(saved)) return saved;
  } catch {}
  return 'auto';
}

function theme() {
  if (state.themePref !== 'auto') return state.themePref;
  if (systemDark.matches) return state.nav ? 'night' : 'dark';
  return 'light';
}

function setThemePref(pref) {
  state.themePref = pref;
  try { localStorage.setItem('theme', pref); } catch {}
  applyTheme();
}

function applyTheme() {
  const t = theme();
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = cssVar('--bg');
  $('theme-label').textContent = THEME_LABEL[state.themePref];
  $('toggle-theme').querySelector('use').setAttribute('href', THEME_ICON[state.themePref]);
  $('toggle-theme').title = `Theme: ${THEME_LABEL[state.themePref]}${state.themePref === 'auto' ? ` (${THEME_LABEL[t]} now)` : ''}`;
  $('night-toggle').setAttribute('aria-pressed', String(t === 'night'));
  mapReady.then(() => styleMap(t));
}

$('toggle-theme').addEventListener('click', () => {
  setThemePref(THEMES[(THEMES.indexOf(state.themePref) + 1) % THEMES.length]);
});

// While driving: one tap in and out of Night.
$('night-toggle').addEventListener('click', () => {
  if (theme() === 'night') {
    state.themePref = 'auto';
    if (theme() === 'night') state.themePref = 'dark';
    setThemePref(state.themePref);
  } else {
    setThemePref('night');
  }
});

systemDark.addEventListener('change', applyTheme);
// Recolour as soon as the style arrives, before tiles load, so there's no flash of the light map.
map.once('style.load', () => styleMap(theme()));

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setPaint(id, prop, value) {
  const key = `${id}|${prop}`;
  if (!originalPaint.has(key)) originalPaint.set(key, map.getPaintProperty(id, prop));
  map.setPaintProperty(id, prop, value);
}

// Recolour OpenFreeMap's style layers by what they draw.
function styleMap(t) {
  const c = MAP_COLORS[t];
  if (!c) {
    for (const [key, value] of originalPaint) {
      const [id, prop] = key.split('|');
      if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
    }
  } else {
    for (const layer of map.getStyle().layers) {
      if (OUR_SOURCES.has(layer.source)) continue;
      const id = layer.id;
      const src = layer['source-layer'] ?? '';
      const road = /motorway|trunk/.test(id) ? c.major : /primary|secondary/.test(id) ? c.mid : c.minor;
      switch (layer.type) {
        case 'background':
          setPaint(id, 'background-color', c.land);
          break;
        case 'fill': {
          const fill = src === 'water' ? c.water
            : src === 'building' ? c.building
              : /park|wood|forest|grass|wetland|scrub|meadow|farmland|national/.test(id) ? c.park
                : src === 'aeroway' || src === 'transportation' ? c.minor
                  : c.land;
          setPaint(id, 'fill-color', fill);
          setPaint(id, 'fill-outline-color', fill);
          // Patterned fills (wetland, plazas) are light images; fade them right down.
          if (layer.paint?.['fill-pattern']) setPaint(id, 'fill-opacity', 0.06);
          break;
        }
        case 'fill-extrusion':
          setPaint(id, 'fill-extrusion-color', c.building);
          break;
        case 'line':
          if (src === 'waterway' || src === 'water') setPaint(id, 'line-color', c.water);
          else if (src === 'boundary') setPaint(id, 'line-color', c.boundary);
          else if (/casing/.test(id)) setPaint(id, 'line-color', c.land);
          else if (/rail|transit|ferry/.test(id)) setPaint(id, 'line-color', c.rail);
          else setPaint(id, 'line-color', road);
          break;
        case 'symbol':
          setPaint(id, 'text-color', c.label);
          setPaint(id, 'text-halo-color', c.halo);
          setPaint(id, 'icon-opacity', c.icons);
          break;
        case 'raster': // shaded relief at country zoom
          setPaint(id, 'raster-saturation', -1);
          setPaint(id, 'raster-brightness-max', c.relief);
          break;
        case 'hillshade':
          setPaint(id, 'hillshade-shadow-color', c.land);
          setPaint(id, 'hillshade-highlight-color', c.minor);
          setPaint(id, 'hillshade-accent-color', c.land);
          break;
        default:
      }
    }
  }
  styleRouteLayers(t);
}

function styleRouteLayers(t) {
  if (!map.getLayer('route-line')) return; // not added yet; styled again once they are
  const sev = [cssVar('--route-good'), cssVar('--sev-1'), cssVar('--sev-2'), cssVar('--sev-3')];
  const color = ['match', ['get', 'sev'], 0, sev[0], 1, sev[1], 2, sev[2], 3, sev[3], cssVar('--accent')];
  map.setPaintProperty('route-line', 'line-color', color);
  map.setPaintProperty('route-casing', 'line-color', cssVar('--route-casing'));
  map.setPaintProperty('route-casing', 'line-opacity', t === 'light' ? 0.55 : 0.9);
  map.setPaintProperty('alt-line', 'line-color', cssVar('--route-alt'));
}

applyTheme();

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

// The middle of the part of the map you can see (not hidden by the panel).
function mapCenter() {
  const [x, y] = focusPx();
  const c = map.unproject([x, y]);
  return { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
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

$('collapse').addEventListener('click', () => {
  if (phone.matches) snapSheet(sheetState() === 'peek' ? 'half' : 'peek');
  else $('panel').classList.toggle('collapsed');
  placeCrosshair();
});

// After a route is planned the form slides away, leaving a one-line "From → To"
// strip; tapping the strip slides the form back for editing.
function foldForm(fold) {
  const wrap = $('form-wrap');
  if (fold === wrap.classList.contains('folded')) return;
  $('trip-from').textContent = shortName(state.from);
  $('trip-to').textContent = shortName(state.to);
  $('trip-line').hidden = !fold;
  $('trip-line').setAttribute('aria-expanded', String(!fold));
  wrap.classList.add('moving'); // clip while it slides; the suggestion lists need overflow afterwards
  wrap.classList.toggle('folded', fold);
  setTimeout(() => wrap.classList.remove('moving'), 400);
}
$('trip-line').addEventListener('click', () => foldForm(false));

// ---------------------------------------------------------------- departure time

// Dragging the needle doesn't change the plan: it marks on the bars how the trip
// would look leaving then (a ghost). "Set" makes it the plan.
$('depart').max = MAX_DEPART_HOURS;
$('depart').addEventListener('input', () => {
  updateDepartLabel();
  if (state.forecasts) renderBars();
});
$('set-depart').addEventListener('click', () => {
  state.departOffset = Number($('depart').value);
  setLeaveAt(state.departOffset ? state.baseTime + state.departOffset * 3600 : null, false);
  if (state.forecasts) render();
});

function departAt() {
  return state.baseTime + state.departOffset * 3600;
}

function ghostOffset() {
  const g = Number($('depart').value);
  return Math.abs(g - state.departOffset) < 0.01 ? null : g;
}

function updateDepartLabel() {
  const g = Number($('depart').value);
  const label = g === 0 ? 'now' : fmtDayTime(state.baseTime + g * 3600);
  $('depart-label').textContent = label[0].toUpperCase() + label.slice(1);
  $('needle').style.left = `${(g / MAX_DEPART_HOURS) * 100}%`;
  $('set-depart').hidden = ghostOffset() == null;
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
  $('units-label').textContent = state.imperial ? '°F · mi' : '°C · km';
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
    $('radar-label').textContent = `Radar ${fmtTime(time.getTime() / 1000)}`;
  } catch (err) {
    showStatus(err.message, true);
  }
}

function disableRadar() {
  hideRadar(map);
  state.radarOn = false;
  $('radar-legend').hidden = true;
  $('toggle-radar').setAttribute('aria-pressed', 'false');
  $('radar-label').textContent = 'Radar';
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
    if (state.leaveAt) {
      state.departOffset = leaveOffset();
      $('depart').value = state.departOffset;
    }
    const option = await buildOption(route);
    await mapReady;
    if (token !== state.planToken) return;
    hideStatus();
    state.options = [option];
    state.roads = null;
    state.roadError = null;
    selectOption(0);
    foldForm(true);
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
  state.barSel = null;
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
  renderAlerts(pts);
  renderDestination(pts[pts.length - 1]);
  renderSteps(route);
  renderBestTime(t0);
  updateDepartLabel();
  $('results').hidden = false;
  if ($('panel-foot').hidden) {
    // First result: the footer slides up with a big Go.
    $('panel-foot').hidden = false;
    $('panel-foot').classList.add('enter');
    $('panel-foot').addEventListener('animationend', () => $('panel-foot').classList.remove('enter'), { once: true });
  }
  renderBars();
}

// ---------------------------------------------------------------- trip bars

// The route split into ten stretches by distance; each bar's lit segments show how
// rough its worst weather is. Segment and gap sizes are whole screen pixels, so the
// gaps look identical at 125% / 150% display scaling too.
const BARS = 10;
const BAR_SEGS = [2, 5, 7, 10]; // lit segments per severity
let barSeg = 5;
let barGap = 2;

function snapBars() {
  const dpr = devicePixelRatio || 1;
  barSeg = Math.round(5 * dpr) / dpr;
  barGap = Math.max(1, Math.round(2 * dpr)) / dpr;
  const el = $('bars');
  el.style.setProperty('--seg', `${barSeg}px`);
  el.style.setProperty('--gap', `${barGap}px`);
  el.style.height = `${BARS * (barSeg + barGap) - barGap}px`;
}
snapBars();
addEventListener('resize', () => { snapBars(); if (state.forecasts) renderBars(); });

function sevColor(s) {
  return s ? `var(--sev-${s})` : 'var(--route-good)';
}

// The worst point in each tenth of the route.
function stretches(pts) {
  const total = pts[pts.length - 1].dist || 1;
  const sev = (p) => p.wx?.severity ?? -1;
  return Array.from({ length: BARS }, (_, b) => {
    const lo = (total * b) / BARS;
    const hi = (total * (b + 1)) / BARS;
    const mid = (lo + hi) / 2;
    let group = pts.filter((p) => p.dist >= lo && (p.dist < hi || b === BARS - 1));
    if (!group.length) group = [pts.reduce((a, p) => (Math.abs(p.dist - mid) < Math.abs(a.dist - mid) ? p : a))];
    return group.reduce((a, p) => (sev(p) > sev(a) ? p : a), group[0]);
  });
}

function renderBars() {
  const now = stretches(alongRoute(state.samples, state.forecasts, departAt()));
  const g = ghostOffset();
  const ghost = g == null ? null : stretches(alongRoute(state.samples, state.forecasts, state.baseTime + g * 3600));
  state.bars = now;
  $('bars').innerHTML = now.map((p, k) => {
    const s = p.wx?.severity ?? 0;
    const peak = ghost ? `<span class="peak" style="bottom:${BAR_SEGS[ghost[k].wx?.severity ?? 0] * (barSeg + barGap) - barGap}px"></span>` : '';
    return `<div class="cl-bar${s ? '' : ' calm'}${state.barSel === k ? ' sel' : ''}" data-k="${k}" style="--c:${sevColor(s)}">${'<i></i>'.repeat(BAR_SEGS[s])}${peak}</div>`;
  }).join('');
  $('handle-strip').innerHTML = now.map((p) => `<i style="background:${sevColor(p.wx?.severity ?? 0)}"></i>`).join('');

  const read = $('read');
  const sel = state.barSel != null ? now[state.barSel] : null;
  if (sel) {
    const b = document.createElement('b');
    b.textContent = sel.wx ? sel.wx.label : 'Beyond forecast';
    read.replaceChildren(b, ` · ${fmtDist(sel.dist)} · ${fmtTime(sel.eta)}${sel.wx ? ` · ${fmtTemp(sel.wx.temp)}` : ''}`);
  } else {
    read.textContent = ghost ? `Marks show leaving ${fmtTime(state.baseTime + g * 3600)}` : '';
  }
}

$('bars').addEventListener('click', (e) => {
  const bar = e.target.closest('.cl-bar');
  const k = bar ? Number(bar.dataset.k) : null;
  state.barSel = k === state.barSel ? null : k;
  const p = state.barSel != null ? state.bars[state.barSel] : null;
  if (p) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 8), duration: 600 });
  renderBars();
});

function hoursMinutes(s) {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

// Road-sign shapes: circle calm, rectangle minor, diamond caution, octagon hazardous.
const SIGNS = [
  '<circle cx="13" cy="13" r="11"/>',
  '<rect x="2" y="5" width="22" height="16" rx="4"/>',
  '<path d="M13 1 L25 13 L13 25 L1 13 Z"/>',
  '<path d="M8.5 1 H17.5 L25 8.5 V17.5 L17.5 25 H8.5 L1 17.5 V8.5 Z"/>',
];
function signSvg(sev) {
  return `<svg viewBox="0 0 26 26" aria-hidden="true" style="stroke:${sevColor(sev)}">${SIGNS[sev]}</svg>`;
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

  // Compact buttons: road name, time (the others as "+h:mm" over the fastest), and the
  // sign shape of the route's worst weather. The full story is in the tooltip.
  $('route-options').replaceChildren(...state.options.map((o, i) => {
    const s = stats[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cl-route${i === state.selected ? ' on' : ''}`;
    const extra = s.time - stats[fastest].time;
    const tags = [];
    if (state.options.length > 1 && i === fastest) tags.push('fastest');
    if (state.options.length > 1 && i === calmest && stats[calmest].score < stats[fastest].score - 0.5 && !state.chaser) tags.push('calmest');
    if (state.chaser && stats[stormiest].storms > 0 && i === stormiest) tags.push('most storms');
    btn.title = `${o.route.roads.length ? `via ${o.route.roads.join(', ')}` : `Route ${i + 1}`}${tags.length ? ` (${tags.join(', ')})` : ''}`
      + ` · ${fmtDist(o.route.distance)} · ${fmtDuration(s.time)} · worst weather: ${SEVERITY_LABEL[s.worst].toLowerCase()}`
      + (s.storms ? ` · ${s.storms} storm point${s.storms > 1 ? 's' : ''}` : '');
    btn.innerHTML = `${signSvg(s.worst)}<div><b></b><span></span></div>`;
    btn.querySelector('b').textContent = `${o.route.ferries ? '⛴ ' : ''}${o.route.roads[0] ?? (o.route.ferries ? 'Ferry' : `Route ${i + 1}`)}`;
    btn.querySelector('span').textContent = i !== fastest && extra >= 120 ? `+${hoursMinutes(extra)}` : hoursMinutes(s.time);
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

// Each piece carries its severity and how far along the trip it is (t, 0–1): the line
// thins and fades further out, where the forecast is less certain.
function colorRoute(pts) {
  const features = [];
  const total = pts[pts.length - 1].dist || 1;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const sev = Math.max(a.wx?.severity ?? -1, b.wx?.severity ?? -1);
    features.push({
      type: 'Feature',
      properties: { sev, t: a.dist / total },
      geometry: { type: 'LineString', coordinates: state.route.coords.slice(a.index, b.index + 1) },
    });
  }
  map.getSource('route').setData({ type: 'FeatureCollection', features });
}

// One road-sign marker per stretch of rough weather, at its worst point.
// Calm stretches get no marker, so the map stays clean.
function drawWeatherMarkers(pts) {
  state.markers.forEach((m) => m.remove());
  state.markers = [];
  const runs = [];
  let run = null;
  for (const p of pts) {
    if (p.wx && p.wx.severity >= 1) {
      if (!run) runs.push(run = []);
      run.push(p);
    } else {
      run = null;
    }
  }
  for (const r of runs) {
    const p = r.reduce((a, q) => (q.wx.severity > a.wx.severity ? q : a));
    const el = document.createElement('div');
    el.className = 'wx-sign';
    el.innerHTML = signSvg(p.wx.severity);
    const temp = document.createElement('b');
    temp.textContent = fmtTemp(p.wx.temp);
    el.append(temp);
    el.title = `${p.wx.label} · ${SEVERITY_LABEL[p.wx.severity]}`;
    const popup = new maplibregl.Popup({ offset: 14 }).setDOMContent(detailCard(p));
    state.markers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [-12, 0] }).setLngLat([p.lon, p.lat]).setPopup(popup).addTo(map));
  }
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

// Arrival time large; drive time and distance small beside it. A small "+7" on the
// drive time is the minutes added for weather.
function renderSummary(route, pts) {
  const last = pts[pts.length - 1];
  const arrive = fmtTime(last.eta).match(/^(.*?)\s?([AaPp]\.?[Mm]\.?)$/);
  $('arrive').replaceChildren(arrive ? arrive[1] : fmtTime(last.eta));
  if (arrive) {
    const small = document.createElement('small');
    small.textContent = arrive[2];
    $('arrive').append(small);
  }
  const unit = (text) => { const s = document.createElement('span'); s.textContent = text; return s; };
  $('drive').replaceChildren(hoursMinutes(last.eta - pts[0].eta), unit('H'));
  if (last.delay >= 300) {
    const sup = document.createElement('sup');
    sup.textContent = `+${Math.round(last.delay / 60)}`;
    sup.title = `Includes ${fmtDuration(last.delay)} for weather`;
    $('drive').append(sup);
  }
  const [num, u] = splitDist(fmtDist(route.distance));
  $('dist').replaceChildren(num, unit(u.toUpperCase()));
}

// Only what the bars can't show: possible ice, and a forecast that runs out.
function renderAlerts(pts) {
  const lis = [];
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

  $('alerts').replaceChildren(...lis);
}

// Footer: destination temperature and name; tap for the hours after you arrive.
function renderDestination(last) {
  const w = last.wx;
  $('dest-temp').textContent = w ? fmtTemp(w.temp) : '–';
  $('dest-name').textContent = shortName(state.to);
  $('dest-line').title = w
    ? `${w.label} when you arrive (${fmtDayTime(last.eta)}) · feels ${fmtTemp(w.feels)} · wind ${fmtSpeed(w.wind)} · ${Math.round(w.pop ?? 0)}% precip`
    : 'Arrival is beyond the forecast range';

  // The 12 hours after arrival, hour by hour.
  const series = state.forecasts[state.forecasts.length - 1];
  const hourly = $('hourly');
  hourly.replaceChildren();
  if (!w) return;
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
}

$('dest-line').addEventListener('click', () => {
  $('hourly').hidden = !$('hourly').hidden || !$('hourly').childElementCount;
  if (!$('hourly').hidden) $('hourly').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

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
// A small dot on the departure scale marks a clearly calmer time to leave.
function renderBestTime(t0) {
  const el = $('best-mark');
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
  el.style.left = `${(best.offset / MAX_DEPART_HOURS) * 100}%`;
  el.title = `Leaving ${fmtDayTime(state.baseTime + best.offset * 3600)} looks calmer`;
}

// ---------------------------------------------------------------- storm chaser

// Chaser and watcher are two takes on the same storms, so only one is on at a time.
// They share the radar, the storm-potential map layer and the NWS warnings.
document.querySelectorAll('.mode-tabs button').forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode || null)));
document.querySelectorAll('.warn-btn').forEach((btn) => btn.addEventListener('click', () => {
  const box = $(btn.dataset.box);
  box.hidden = !box.hidden;
  btn.setAttribute('aria-expanded', String(!box.hidden));
}));

function setMode(mode) {
  state.chaser = mode === 'chaser';
  state.watcher = mode === 'watcher';
  document.querySelectorAll('.mode-tabs button').forEach((b) => b.setAttribute('aria-selected', String((b.dataset.mode || null) === mode)));
  $('chaser').hidden = !state.chaser;
  $('watcher').hidden = !state.watcher;
  $('panel').classList.remove('collapsed');
  state.targets = null;
  state.spots = null;
  state.spotSel = null;
  lastScan = null;
  placeCrosshair();
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
  // Single place, or places close together: show ~150 km around them (~20 km
  // for viewpoints, which are about local peaks). Keep it clear of the panel.
  const pad = state.watcher && state.watchKind === 'view' ? 0.2 : 1.4;
  bounds.extend([bounds.getWest() - pad, bounds.getSouth() - pad]);
  bounds.extend([bounds.getEast() + pad, bounds.getNorth() + pad]);
  const [, , r] = focusPx();
  const padding = { top: r.t + 40, left: r.l + 40, right: window.innerWidth - r.r + 40, bottom: window.innerHeight - r.b + 40 };
  map.fitBounds(bounds, { padding, maxZoom: 11, duration: 0 });
}

// Quietly pick up the GPS position at start-up if the user has already allowed it.
navigator.permissions?.query({ name: 'geolocation' }).then((p) => {
  if (p.state !== 'granted') return;
  currentPosition().then((pos) => { state.gps = { lat: pos.coords.latitude, lon: pos.coords.longitude }; }).catch(() => {});
}).catch(() => {});

// Roughly what's on screen: a 100–600 km radius around the map centre.
function scanRadius() {
  const center = mapCenter();
  const [, y, r] = focusPx();
  const edge = map.unproject([r.r, y]);
  const halfWidth = haversine([center.lon, center.lat], [edge.lng, edge.lat]) / 1000;
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

  const token = ++state.scanToken;
  lastScan = { center, radius };
  $('scan-status').textContent = `Scanning ${fmtDist(radius * 1000)} around the crosshair…`;
  try {
    const cells = await scanStorms(center, radius);
    if (!state.chaser || token !== state.scanToken) return;
    state.spotSel = null;
    state.targets = pickTargets(cells, origin, radius, { anchors: anchors() });
    drawStormCells(cells);
    $('scan-status').textContent = state.targets.length
      ? `Best storm potential within ${fmtDist(radius * 1000)} (distances ${fromLabel()}):`
      : `No thunderstorm potential within ${fmtDist(radius * 1000)} in the next 12 hours.${windNote(cells, center) || ' Zoom out or move the map.'}`;
    renderTargets();
  } catch (err) {
    if (token === state.scanToken) scanFailed('scan-status', err, scanArea);
  }
}

function renderTargets() {
  $('targets').replaceChildren(...state.targets.map((t, i) => {
    const li = document.createElement('li');
    li.className = `sev-${t.level.sev}${state.spotSel === i ? ' sel' : ''}`;
    li.tabIndex = 0;
    const info = document.createElement('div');
    info.textContent = `${t.icon} ${t.level.label} · ${t.score}/100`;
    const small = document.createElement('small');
    small.textContent = `Peaks ~${fmtDayTime(t.time)} · ${fmtDist(t.dist)} ${t.bearing}${t.cape ? ` · CAPE ${Math.round(t.cape)}` : ''}`
      + (t.reachable ? '' : ' · probably too far to reach in time');
    info.append(small);
    li.append(info);
    li.addEventListener('click', () => {
      state.spotSel = i;
      renderTargets();
      chase(t);
    });
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
  state.departOffset = leaveOffset();
  $('depart').value = state.departOffset;
  planRoute();
}

// ---------------------------------------------------------------- storm watcher

document.querySelectorAll('#watcher .segmented button').forEach((btn) => btn.addEventListener('click', () => {
  state.watchKind = btn.dataset.kind;
  document.querySelectorAll('#watcher .segmented button').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
  document.querySelectorAll('#watcher [data-for]').forEach((el) => { el.hidden = el.dataset.for !== state.watchKind; });
  if (state.target?.kind === 'watch') state.target = null;
  state.spotSel = null;
  scanViewArea();
}));

async function scanViewArea() {
  await mapReady;
  const { center, radius } = scanRadius();
  const kind = state.watchKind;
  const token = ++state.scanToken;
  lastScan = { center, radius };
  try {
    if (kind === 'view') await scanViewpoints(center, radius, token);
    else if (kind === 'coast') await scanCoastArea(center, radius, token);
    else await scanThunderArea(center, radius, token);
  } catch (err) {
    if (token === state.scanToken) scanFailed('watch-status', err, scanViewArea);
  }
}

async function scanCoastArea(center, radius, token) {
  $('watch-status').textContent = `Looking for big surf and wind within ${fmtDist(radius * 1000)}…`;
  const { cells, spots, noCoast } = await scanCoast(center, radius, { anchors: anchors(), origin: originPoint(center) });
  if (!state.watcher || state.watchKind !== 'coast' || token !== state.scanToken) return;
  state.spots = spots;
  state.spotSel = null;
  drawStormCells(cells);
  map.getSource('watch').setData({
    type: 'FeatureCollection',
    features: spots.map((s, idx) => ({ type: 'Feature', properties: { idx }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
  });
  $('watch-status').textContent = spots.length
    ? `Best coastal spots (distances ${fromLabel()}):`
    : noCoast
      ? 'No coastline in view. Move the map over a coast.'
      : `No big surf or strong wind on this coast in the next 36 hours.`;
  renderSpots();
}

async function scanThunderArea(center, radius, token) {
  $('watch-status').textContent = `Looking for storms and viewing spots within ${fmtDist(radius * 1000)}…`;
  const { cells, spots } = await scanViewing(center, radius, { origin: originPoint(center), anchors: anchors() });
  if (!state.watcher || state.watchKind !== 'thunder' || token !== state.scanToken) return;
  state.spots = spots;
  state.spotSel = null;
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
      ? 'There are storms around, but no dry spot with a clear view of them. Try zooming out.'
      : `No thunderstorms worth watching within ${fmtDist(radius * 1000)} in the next 12 hours.${wind ? `${wind} Try Surf above.` : ' Zoom out or move the map.'}`;
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
  if (state.spots?.[0]?.show === 'view') return renderViews();
  $('spots').replaceChildren(...state.spots.map((s, i) => {
    const li = document.createElement('li');
    li.className = `sev-${s.level.sev}${state.spotSel === i ? ' sel' : ''}`;
    li.tabIndex = 0;
    const info = document.createElement('div');
    info.textContent = spotSummary(s).title;
    const small = document.createElement('small');
    small.textContent = spotDetail(s) + (s.reachable ? '' : ' · probably too far to reach in time');
    info.append(small);
    li.append(info);
    li.addEventListener('click', () => selectSpot(i));
    return li;
  }));
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
  const label = spot.show === 'view' ? spot.name : `Viewing spot · ${spotSummary(spot).show}`;
  setPlace('to', { lat: spot.lat, lon: spot.lon, label });
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
  if (t.kind === 'watch' && t.show === 'view') {
    const at = hourAt(t, arrive);
    const best = bestHour(t, arrive, 12);
    text = `You arrive ${fmtTime(arrive)}: ${VIEW_KINDS[at.kind].label.toLowerCase()}, gusts ${fmtSpeed(at.gusts)}.`;
    if (best && best.kind !== at.kind && best.score > at.score + 5) text += ` Better ${fmtDayTime(best.time)}: ${VIEW_KINDS[best.kind].label.toLowerCase()}.`;
    late = at.score < 30;
  } else if (t.kind === 'watch' && t.show === 'waves') {
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
  const btn = document.querySelector(`.warn-btn[data-box="${box.closest('.warn-box').id}"]`);
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
  // The "!" button carries the count of alerts covering this area.
  const here = local.status === 'fulfilled' ? local.value.length : 0;
  btn.classList.toggle('hot', here > 0);
  btn.dataset.count = here || '';
  btn.title = here ? `${here} alert${here > 1 ? 's' : ''} here · safety` : 'Alerts & safety';
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
  setLeaveAt(null, false);
  state.baseTime = now();
  $('depart').value = 0;
  // Commit to the chosen route; alternatives are hidden while driving.
  state.options = [state.options[state.selected]];
  state.selected = 0;
  state.planToken++;
  render();

  // The panel slides down out of the way, then the driving view takes over.
  $('panel').classList.add('leaving');
  setTimeout(() => {
    if (!state.nav) return;
    document.body.classList.add('navigating');
    $('panel').classList.remove('leaving');
  }, 350);
  $('nav-ui').hidden = false;
  placeCrosshair();
  $('nav-dist').textContent = '';
  $('nav-dist-unit').textContent = '';
  $('nav-instruction').textContent = 'Waiting for GPS…';
  $('nav-meta').textContent = '';
  $('nav-arrive').textContent = '–';
  $('nav-alert').hidden = true;
  $('now-on').hidden = true;
  $('nav-from').textContent = shortName(state.from);
  $('nav-to').textContent = shortName(state.to);
  $('nav-dest-wx').textContent = '';
  setGauge('gauge-progress', 0, 0);
  setGauge('gauge-hazard', 0, 0);
  state.town = '';
  state.townLookup = null;

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
  applyTheme(); // "Auto" switches to Night when navigating in the dark
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
    el.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-car"/></svg>';
    state.meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'viewport' });
  }
  state.meMarker.setLngLat(u.position).addTo(map);
  state.gps = { lon: u.position[0], lat: u.position[1] };

  const moving = u.speed != null && u.speed > 2 && u.heading != null && !Number.isNaN(u.heading);
  if (moving) state.meMarker.setRotation(u.heading);
  map.easeTo({ center: u.position, zoom: 16, pitch: 50, bearing: moving ? u.heading : map.getBearing(), duration: 900 });

  // Next turn: arrow, distance (big), instruction.
  const [icon, left] = turnIcon(u.next);
  $('nav-turn').querySelector('use').setAttribute('href', icon);
  $('nav-turn').classList.toggle('left', left);
  const [num, unit] = splitDist(fmtDist(u.toNext));
  $('nav-dist').textContent = num;
  $('nav-dist-unit').textContent = unit;
  $('nav-instruction').textContent = u.next.text;

  // Where you are right now: road and town.
  const road = roadLabel(u.current);
  state.navRoad = road;
  renderNowOn();
  updateTown({ lon: u.position[0], lat: u.position[1] });

  const total = state.route.distance;
  setGauge('gauge-progress', 0, u.along / total);
  const show = (arrive) => {
    $('nav-arrive').textContent = fmtTime(arrive);
    $('nav-meta').textContent = `${fmtDist(u.remainingDist)} · ${fmtDuration(u.remainingTime)}`;
  };
  show(now() + u.remainingTime);
  if (!state.forecasts) return;

  // Re-run the weather timeline from where we are now. Times are shifted by the
  // weather delay already "spent" behind us so only the road ahead slows us down.
  const elapsed = state.route.cumTime[state.route.cumTime.length - 1] - u.remainingTime;
  const pts = alongRoute(state.samples, state.forecasts, now() - elapsed);
  const behind = pts.filter((p) => p.dist <= u.along);
  const spent = behind.length ? behind[behind.length - 1].delay : 0;
  const dest = pts[pts.length - 1];
  show(now() + u.remainingTime + (dest.delay - spent));
  $('nav-dest-wx').textContent = dest.wx ? `${dest.wx.icon} ${fmtTemp(dest.wx.temp)} at arrival` : '';

  // Weather ahead stays dark until there's something worth knowing, then lights up.
  const ahead = pts.filter((p) => p.dist > u.along && p.wx);
  const start = ahead.findIndex((p) => p.wx.severity >= 2);
  if (start < 0) {
    $('nav-alert').hidden = true;
    setGauge('gauge-hazard', 0, 0);
    return;
  }
  let end = start;
  while (end + 1 < ahead.length && ahead[end + 1].wx.severity >= 2) end++;
  const run = ahead.slice(start, end + 1);
  const worst = run.reduce((a, p) => (p.wx.severity > a.wx.severity ? p : a), run[0]);
  const first = run[0];
  const last = run[run.length - 1];
  const extra = [];
  if (worst.wx.gusts >= 45) extra.push(`gusts ${fmtSpeed(worst.wx.gusts)}`);
  if (worst.wx.visibility < 1000) extra.push(`visibility ${fmtDist(worst.wx.visibility)}`);
  const when = first === last ? `~${fmtTime(first.eta - spent)}` : `${fmtTime(first.eta - spent)} – ${fmtTime(last.eta - spent)}`;
  // The gauge always marks the stretch; the warning card only lights up once it's close.
  setGauge('gauge-hazard', first.dist / total, Math.max(last.dist, first.dist + total * 0.02) / total);
  const soon = first.dist - u.along < ALERT_WITHIN_M || first.eta - spent - now() < ALERT_WITHIN_S;
  $('nav-alert').hidden = !soon;
  if (!soon) return;
  $('nav-alert').className = `nav-alert sev-${worst.wx.severity}`;
  $('nav-alert-icon').textContent = worst.wx.icon;
  $('nav-alert-title').textContent = `${worst.wx.label} in ${fmtDist(first.dist - u.along)}`;
  $('nav-alert-detail').textContent = [when, ...extra].join(' · ');
}

// Show part of the gauge arc, from `from` to `to` (fractions of the trip).
function setGauge(id, from, to) {
  const a = Math.max(0, Math.min(100, from * 100));
  const b = Math.max(a, Math.min(100, to * 100));
  $(id).style.strokeDasharray = `0 ${a} ${b - a} 100`;
}

// Tick marks around the trip gauge, every 15°, longer every 45°.
$('gauge-ticks').innerHTML = Array.from({ length: 13 }, (_, i) => {
  const a = Math.PI + (i * Math.PI) / 12;
  const r1 = 140;
  const r2 = i % 3 === 0 ? 152 : 146;
  const p = (r) => [150 + r * Math.cos(a), 150 + r * Math.sin(a)].map((n) => n.toFixed(1));
  const [x1, y1] = p(r1);
  const [x2, y2] = p(r2);
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
}).join('');

function turnIcon(step) {
  const { type, modifier = '' } = step.maneuver ?? {};
  if (type === 'arrive') return ['#i-flag', false];
  if (modifier.includes('uturn')) return ['#i-uturn', false];
  if (modifier.includes('right')) return ['#i-turn-right', false];
  if (modifier.includes('left')) return ['#i-turn-right', true];
  return ['#i-straight', false];
}

// "0.4 mi" -> ["0.4", "mi"]
function splitDist(text) {
  const m = text.match(/^([\d.,]+)\s*(.*)$/);
  return m ? [m[1], m[2]] : [text, ''];
}

// "Seattle, King County, Washington" -> "Seattle"
function shortName(place) {
  if (!place) return '';
  return place.label === 'My location' ? 'Start' : place.label.split(',')[0];
}

// The road we're on, e.g. { badge: '518', road: 'SR 518' } or { badge: '', road: 'Main Street' }.
function roadLabel(step) {
  const ref = (step?.ref ?? '').split(';')[0].trim();
  const name = (step?.name ?? '').trim();
  return { badge: ref.match(/\d+[A-Z]?/)?.[0] ?? '', road: prettyRoad(name || ref) };
}

function renderNowOn() {
  const { badge = '', road = '' } = state.navRoad ?? {};
  const town = state.town;
  $('now-on').hidden = !road && !town;
  $('now-badge').hidden = !badge;
  $('now-badge').textContent = badge;
  $('now-road').hidden = !road;
  $('now-road').textContent = road;
  $('now-sep').hidden = !(road && town);
  $('now-town').textContent = town;
}

// Look the town up again after ~800 m of driving, at most every 20 s, so we stay
// well inside Photon's fair-use limits.
async function updateTown(pos) {
  const last = state.townLookup;
  const t = Date.now();
  if (last && (last.busy || t - last.at < 20000 || haversine([last.pos.lon, last.pos.lat], [pos.lon, pos.lat]) < 800)) return;
  state.townLookup = { pos, at: t, busy: true };
  try {
    const place = await reverse(pos);
    if (place && state.nav) {
      state.town = place;
      renderNowOn();
    }
  } catch {
    // Keep showing the last town; the road name still updates.
  } finally {
    if (state.townLookup) state.townLookup.busy = false;
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
  $('panel').classList.remove('leaving');
  $('panel').classList.add('returning');
  $('panel').addEventListener('animationend', () => $('panel').classList.remove('returning'), { once: true });
  $('nav-ui').hidden = true;
  placeCrosshair();
  applyTheme();
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

// ---------------------------------------------------------------- viewpoints (Watch ⛰️)

// One small shape per kind of view, drawn in that kind's colour.
const VIEW_COLORS = { sea: '#a855f7', rolling: '#14b8a6', skim: '#0ea5e9', under: '#64748b', clear: '#16a34a', fog: '#9ca3af', rain: '#3b82f6' };
const VIEW_GLYPHS = {
  sea: '<path d="M7 13l5-8 5 8z" fill="currentColor"/><path d="M3 17c3-2 5 2 9 0s6 2 9 0M3 21c3-2 5 2 9 0s6 2 9 0"/>',
  rolling: '<path d="M7 18a4 4 0 0 1 .5-8A5.5 5.5 0 0 1 18 10a4 4 0 0 1 0 8z"/><path d="M2 21h8M14 21h8"/>',
  skim: '<path d="M6 21l6-9 6 9z" fill="currentColor"/><path d="M4 8h16M7 4h10"/>',
  under: '<path d="M3 4h18M3 21h18"/><path d="M8 17l4-7 4 7z" fill="currentColor"/>',
  clear: '<circle cx="12" cy="12" r="6"/>',
  fog: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  rain: '<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z" fill="currentColor"/>',
};
function viewGlyph(kind) {
  return `<svg class="vg" viewBox="0 0 24 24" aria-hidden="true" style="color:${VIEW_COLORS[kind]}">${VIEW_GLYPHS[kind]}</svg>`;
}

$('view-legend').innerHTML = Object.entries(VIEW_KINDS).map(([k, v]) => `<span>${viewGlyph(k)}${v.label}</span>`).join('');

async function scanViewpoints(center, radius, token) {
  $('watch-status').textContent = 'Checking peaks and lookouts around the crosshair…';

  const spots = await scanViews(center, radius);
  if (!state.watcher || state.watchKind !== 'view' || token !== state.scanToken) return;
  state.spots = spots.filter((s) => s.hours.length).map((s) => ({ ...s, show: 'view' }));
  state.spotSel = null;
  drawStormCells([]);
  rankViews();
  $('watch-status').textContent = state.spots.length
    ? (radius > 30 ? 'Zoom in to check other peaks.' : '')
    : 'No forecast for this area right now.';
  renderSpots();
}

// When you'd get to a spot if you leave at the chosen time (rough mountain-road pace).
function arriveAtSpot(s) {
  const origin = state.gps ?? state.from;
  const leave = state.leaveAt ?? now();
  if (!origin) return leave;
  return leave + (haversine([origin.lon, origin.lat], [s.lon, s.lat]) * 1.3) / 20;
}

// Each spot's view when you'd arrive and its best hour after that; best first.
function rankViews() {
  for (const s of state.spots) {
    s.eta = arriveAtSpot(s);
    s.at = hourAt(s, s.eta);
    s.best = bestHour(s, s.eta);
    s.time = s.at.time;
  }
  const sel = state.spots[state.spotSel];
  state.spots.sort((a, b) => b.at.score - a.at.score || b.best.score - a.best.score);
  state.spotSel = sel ? state.spots.indexOf(sel) : null;
}

function drawViewSpots() {
  map.getSource('watch').setData({
    type: 'FeatureCollection',
    features: state.spots.map((s, idx) => ({
      type: 'Feature',
      properties: { idx, color: VIEW_COLORS[s.at.kind], sel: idx === state.spotSel },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })),
  });
}

function renderViews() {
  drawViewSpots();
  $('spots').replaceChildren(...state.spots.map((s, i) => {
    const li = document.createElement('li');
    li.className = `view-spot${state.spotSel === i ? ' sel' : ''}`;
    li.style.borderLeftColor = VIEW_COLORS[s.at.kind];
    li.tabIndex = 0;

    const top = document.createElement('div');
    top.className = 'vs-top';
    top.innerHTML = viewGlyph(s.at.kind);
    const name = document.createElement('b');
    name.textContent = s.name;
    const ele = document.createElement('small');
    ele.textContent = fmtElevation(Math.round(s.ele * 3.28084));
    const gust = document.createElement('span');
    gust.className = 'vs-gust num';
    gust.textContent = `💨${fmtSpeed(s.at.gusts)}`;
    gust.title = 'Gusts when you arrive';
    top.append(name, ele, gust);

    const read = document.createElement('small');
    read.className = 'vs-read';
    const line = (h, lead) => `${lead} ${fmtDayTime(h.time)}: ${VIEW_KINDS[h.kind].label.toLowerCase()}`;
    read.textContent = line(s.at, 'Arrive')
      + (s.best.kind !== s.at.kind && s.best.score > s.at.score + 5 ? ` · best ${line(s.best, '').trim()}` : '');

    // Hour strip: one square per hour from now, coloured by the view; the hour you'd
    // arrive is outlined. Tap a square for that hour.
    const strip = document.createElement('div');
    strip.className = 'vs-strip';
    const from = now() - 1800;
    s.hours.filter((h) => h.time >= from).slice(0, 30).forEach((h) => {
      const c = document.createElement('i');
      c.style.background = VIEW_COLORS[h.kind];
      if (!h.day) c.className = 'night';
      if (h.time === s.at.time) c.classList.add('arrive');
      c.title = `${fmtDayTime(h.time)} · ${VIEW_KINDS[h.kind].label} · gusts ${fmtSpeed(h.gusts)}`;
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        read.textContent = `${fmtDayTime(h.time)}: ${VIEW_KINDS[h.kind].label.toLowerCase()} · gusts ${fmtSpeed(h.gusts)} · ${fmtTemp(h.temp)}`
          + (h.visibility < 5000 ? ` · see ${fmtDist(h.visibility)}` : '');
        strip.querySelectorAll('i').forEach((x) => x.classList.toggle('picked', x === c));
      });
      strip.append(c);
    });

    li.append(top, read, strip);
    if (state.spotSel === i) li.append(spotExtras(s));
    li.addEventListener('click', () => selectSpot(i));
    return li;
  }));
  sizeStrips();
}

// Hour squares and the gaps between them are whole screen pixels, so every gap
// looks the same at any display scaling.
function sizeStrips() {
  const dpr = devicePixelRatio || 1;
  const px = (n) => Math.max(1, Math.round(n * dpr)) / dpr;
  for (const strip of document.querySelectorAll('.vs-strip')) {
    const n = strip.childElementCount;
    if (!n) continue;
    const gap = px(2);
    const cell = Math.max(1, Math.floor(((strip.clientWidth - gap * (n - 1)) * dpr) / n)) / dpr;
    strip.style.setProperty('--gap', `${gap}px`);
    strip.style.setProperty('--cell', `${cell}px`);
    strip.style.setProperty('--h', `${px(7)}px`);
  }
}
addEventListener('resize', sizeStrips);

// Sunrise and live webcams near the selected spot.
function spotExtras(s) {
  const box = document.createElement('div');
  box.className = 'vs-extra';
  const sunrise = s.sunrise.find((t) => t > (state.leaveAt ?? now()));
  if (sunrise) {
    const sun = document.createElement('small');
    sun.textContent = `☀ Sunrise ${fmtDayTime(sunrise)}`;
    box.append(sun);
  }
  const cams = document.createElement('div');
  cams.className = 'cams';
  box.append(cams);
  nearbyCams(s).then((list) => {
    cams.replaceChildren(...list.map((c) => {
      const a = document.createElement('a');
      a.href = c.full;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = `${c.name} · ${fmtDist(c.dist)} away${c.look != null ? ` · looking ${compassName(c.look)}` : ''}`;
      a.addEventListener('click', (e) => e.stopPropagation());
      const img = document.createElement('img');
      img.src = `${c.thumb}?t=${Math.floor(Date.now() / 60000)}`;
      img.alt = c.name;
      img.loading = 'lazy';
      const cap = document.createElement('span');
      cap.textContent = c.look != null ? `${c.name} ${['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][Math.round(c.look / 45) % 8]}` : c.name;
      a.append(img, cap);
      return a;
    }));
  });
  return box;
}

// Tapping a spot (in the list or on the map) picks it and routes there; the
// route's Go button then starts the drive.
function selectSpot(i) {
  const spot = state.spots?.[i];
  if (!spot) return;
  state.spotSel = i;
  renderSpots();
  watchFrom(spot);
}

// ---------------------------------------------------------------- leave time

function toLocalInput(t) {
  const d = new Date(t * 1000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// While "Leave" is left at now, keep it showing the current time.
setInterval(() => {
  if (!state.leaveAt && document.activeElement !== $('leave-at')) $('leave-at').value = toLocalInput(now());
}, 30000);

// Hours from the plan's base time to the chosen departure (0 = now).
function leaveOffset() {
  if (!state.leaveAt) return 0;
  return Math.max(0, Math.min(MAX_DEPART_HOURS, (state.leaveAt - now()) / 3600));
}

function setLeaveAt(t, apply = true) {
  state.leaveAt = t && t > now() + 300 ? t : null;
  $('leave-at').value = toLocalInput(state.leaveAt ?? now());
  $('leave-now').hidden = !state.leaveAt;
  if (!apply) return;
  if (state.watcher && state.spots?.[0]?.show === 'view') {
    rankViews();
    renderSpots();
  }
  if (state.route && !state.nav) {
    state.baseTime = now();
    state.departOffset = leaveOffset();
    $('depart').value = state.departOffset;
    render();
  }
}

$('leave-at').addEventListener('change', () => {
  const v = $('leave-at').value;
  setLeaveAt(v ? Math.floor(new Date(v).getTime() / 1000) : null);
});
$('leave-now').addEventListener('click', () => setLeaveAt(null));
setLeaveAt(null, false);

// A failed scan says so briefly, with a small button to try again.
function scanFailed(id, err, retry) {
  const offline = err.name === 'TypeError' || /fetch|network|timed? ?out|abort/i.test(err.message);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'retry';
  b.title = 'Try again';
  b.setAttribute('aria-label', 'Try again');
  b.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-refresh"/></svg>';
  b.addEventListener('click', () => { $(id).textContent = ''; retry(); });
  $(id).replaceChildren(offline ? "Couldn't reach the forecast service." : err.message, b);
}

// ---------------------------------------------------------------- crosshair

// The visible part of the map, in screen pixels, around the panel. On phones it's
// the map above the sheet at its usual half height (62%), fixed so the crosshair
// doesn't ride up and down with the sheet.
function focusPx() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  let r = { l: 0, t: 0, r: w, b: h };
  if (!state.nav) {
    const p = $('panel').getBoundingClientRect();
    if (phone.matches) r = { l: 0, t: 0, r: w, b: Math.max(120, Math.round(h * 0.38)) };
    else if (p.width) r = { l: Math.min(p.right, w * 0.6), t: 0, r: w, b: h };
  }
  return [(r.l + r.r) / 2, (r.t + r.b) / 2, r];
}

// When the panel grows or shrinks, the map shifts so the same place stays under
// the crosshair (and the last scan still matches it).
let crossAt = null;
function placeCrosshair() {
  const el = $('crosshair');
  el.hidden = !!state.nav || $('panel').classList.contains('full');
  if (el.hidden) {
    crossAt = null;
    return;
  }
  const [x, y] = focusPx();
  const scanning = state.chaser || state.watcher;
  if (scanning && crossAt && !map.isMoving() && (crossAt[0] !== x || crossAt[1] !== y)) map.panBy([crossAt[0] - x, crossAt[1] - y], { duration: 0 });
  crossAt = [x, y];
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

new ResizeObserver(placeCrosshair).observe($('panel'));
addEventListener('resize', () => { crossAt = null; placeCrosshair(); });

// Moving the map in Chase / Watch looks again around the new crosshair spot.
let lastScan = null;
let rescanTimer;
map.on('moveend', (e) => {
  if (!e.originalEvent || state.nav || !(state.chaser || state.watcher)) return;
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    const { center, radius } = scanRadius();
    if (lastScan) {
      const moved = haversine([center.lon, center.lat], [lastScan.center.lon, lastScan.center.lat]) / 1000;
      const zoomed = Math.abs(radius - lastScan.radius) / lastScan.radius;
      if (moved < lastScan.radius * 0.2 && zoomed < 0.3) return;
    }
    if (state.chaser) scanArea();
    else scanViewArea();
  }, 700);
});

// ---------------------------------------------------------------- phone sheet

// On phones the panel is a bottom sheet with three stops: peek (just the header),
// half (the default) and full screen. Drag the handle or header to move it.
function sheetState() {
  const p = $('panel');
  return p.classList.contains('full') ? 'full' : p.classList.contains('collapsed') ? 'peek' : 'half';
}

function setSheetClasses(s) {
  $('panel').classList.toggle('full', s === 'full');
  $('panel').classList.toggle('collapsed', s === 'peek');
}

function sheetHeight(s) {
  const p = $('panel');
  const before = sheetState();
  const { height, maxHeight } = p.style;
  setSheetClasses(s);
  p.style.height = '';
  p.style.maxHeight = '';
  const h = p.getBoundingClientRect().height;
  setSheetClasses(before);
  p.style.height = height;
  p.style.maxHeight = maxHeight;
  return h;
}

function snapSheet(target) {
  const p = $('panel');
  const from = p.getBoundingClientRect().height;
  const to = sheetHeight(target);
  setSheetClasses(target === 'peek' ? 'half' : target); // keep content visible while it slides
  p.style.maxHeight = 'none';
  p.style.height = `${from}px`;
  p.getBoundingClientRect();
  p.style.transition = 'height 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
  p.style.height = `${to}px`;
  clearTimeout(snapSheet.timer);
  snapSheet.timer = setTimeout(() => {
    setSheetClasses(target);
    p.style.transition = '';
    p.style.height = '';
    p.style.maxHeight = '';
    placeCrosshair();
  }, 320);
}

(function sheetDrag() {
  const p = $('panel');
  let drag = null;
  const grabbable = (t) => (t.closest('#handle-strip') || t.closest('#panel-head')) && !t.closest('button');

  p.addEventListener('pointerdown', (e) => {
    if (!phone.matches || state.nav || !grabbable(e.target)) return;
    drag = { y: e.clientY, h: p.getBoundingClientRect().height, start: sheetState(), moved: false, samples: [[e.timeStamp, e.clientY]] };
    p.setPointerCapture(e.pointerId);
  });

  p.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.peek = sheetHeight('peek');
      drag.max = sheetHeight('full');
      setSheetClasses('half');
      p.style.maxHeight = 'none';
      p.style.transition = 'none';
    }
    p.style.height = `${Math.max(drag.peek, Math.min(drag.max, drag.h - dy))}px`;
    drag.samples.push([e.timeStamp, e.clientY]);
    if (drag.samples.length > 5) drag.samples.shift();
  });

  const end = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      // A tap on the handle toggles between peek and half.
      if (e.target.closest('#handle-strip')) snapSheet(d.start === 'peek' ? 'half' : 'peek');
      return;
    }
    const [t0, y0] = d.samples[0];
    const v = (e.clientY - y0) / Math.max(e.timeStamp - t0, 1); // px per ms, + is down
    const h = p.getBoundingClientRect().height;
    const order = ['peek', 'half', 'full'];
    const stops = { peek: d.peek, half: sheetHeight('half'), full: d.max };
    let target;
    if (v > 0.5) target = [...order].reverse().find((s) => stops[s] < h - 10) ?? 'peek'; // flick down
    else if (v < -0.5) target = order.find((s) => stops[s] > h + 10) ?? 'full'; // flick up
    else target = order.reduce((a, s) => (Math.abs(stops[s] - h) < Math.abs(stops[a] - h) ? s : a), 'half');
    snapSheet(target);
  };
  p.addEventListener('pointerup', end);
  p.addEventListener('pointercancel', end);
}());

phone.addEventListener('change', () => {
  if (!phone.matches) $('panel').classList.remove('full');
  placeCrosshair();
});
