// Place search on OpenStreetMap data: Nominatim (https://nominatim.org) first,
// Photon (https://photon.komoot.io) as backup and for town names while driving.

const PHOTON = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE = 'https://photon.komoot.io/reverse';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

const US_STATES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
  Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
  Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA',
  'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

// The town at a position, e.g. "SeaTac, WA" (US) or "Bristol" (elsewhere).
export async function reverse({ lat, lon }, signal) {
  const params = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5), limit: '1' });
  const res = await fetch(`${PHOTON_REVERSE}?${params}`, { signal });
  if (!res.ok) throw new Error(`Reverse geocoding failed (${res.status})`);
  const p = (await res.json()).features?.[0]?.properties;
  if (!p) return '';
  const town = p.city || p.town || p.village || p.locality || p.district || p.county || '';
  if (!town) return '';
  return p.countrycode === 'US' && US_STATES[p.state] ? `${town}, ${US_STATES[p.state]}` : town;
}

// Each box is looked up once (when you leave it or press Enter), so Nominatim's
// usage policy (no search-as-you-type, about one request a second) is easy to
// keep. Nominatim is much better than Photon at US street addresses, so it goes
// first; Photon takes over for a minute if Nominatim fails. Answers are cached.
const cache = new Map();
const COOLDOWN_MS = 60000;
let nominatimDownUntil = 0;

export async function search(query, bias, signal) {
  const key = `${query.toLowerCase()}|${bias ? `${bias.lat.toFixed(1)},${bias.lon.toFixed(1)}` : ''}`;
  if (cache.has(key)) return cache.get(key);
  if (Date.now() >= nominatimDownUntil) {
    try {
      return remember(key, await nominatim(query, bias, signal));
    } catch (err) {
      if (err.name === 'AbortError' && signal?.aborted) throw err;
      nominatimDownUntil = Date.now() + COOLDOWN_MS;
    }
  }
  try {
    return remember(key, await photon(query, bias, signal));
  } catch (err) {
    if (err.name === 'AbortError' && signal?.aborted) throw err;
    throw new Error("Place search isn't responding right now. Try again in a minute, or right-click the map to pick a spot.");
  }
}

function remember(key, results) {
  if (results.length) {
    cache.set(key, results);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return results;
}

// The caller's signal (a newer keystroke) or a timeout, whichever comes first.
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
}

async function photon(query, bias, signal) {
  // Ask for extra results so US places can be moved to the top (Photon has no
  // country filter), then keep the best six.
  const params = new URLSearchParams({ q: query, limit: '15' });
  const lang = navigator.language?.slice(0, 2);
  if (['en', 'de', 'fr', 'it'].includes(lang)) params.set('lang', lang);
  if (bias) {
    params.set('lat', bias.lat.toFixed(4));
    params.set('lon', bias.lon.toFixed(4));
    // Regional rather than street-level bias, so "Spokane" finds the city, not a
    // nearby street; wider still when the hint is just a zoomed-out map.
    params.set('zoom', String(Math.round(Math.max(3, Math.min(7, bias.zoom ?? 7)))));
    params.set('location_bias_scale', '0.4');
  }
  const res = await fetch(`${PHOTON}?${params}`, { signal: withTimeout(signal, 6000) });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const data = await res.json();
  const us = (f) => (f.properties.countrycode === 'US' ? 1 : 0);
  // Stable sort: US results first, otherwise Photon's own order.
  const features = data.features.map((f, i) => [f, i]).sort((a, b) => us(b[0]) - us(a[0]) || a[1] - b[1]).map(([f]) => f);
  const seen = new Set();
  return features.map((f) => {
    const p = f.properties;
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const title = p.name || street || p.city || 'Unnamed place';
    const isUS = p.countrycode === 'US';
    const state = isUS ? US_STATES[p.state] ?? p.state : p.state;
    const detail = [p.name ? street : '', p.city, state, isUS ? '' : p.country]
      .filter((x) => x && x !== title)
      .join(', ');
    const [lon, lat] = f.geometry.coordinates;
    return { title, detail, label: detail ? `${title}, ${detail}` : title, lat, lon };
  }).filter((r) => !seen.has(r.label) && seen.add(r.label)).slice(0, 6);
}

// Prefers US results and places near the hint (the other places you've entered),
// without ruling anything out: "Portland" is still Oregon from San Francisco.
async function nominatim(query, bias, signal) {
  // A zoomed-out map centre is too vague to prefer.
  const near = bias && !(bias.zoom < 8) ? bias : null;
  const ask = async (us) => {
    const params = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', limit: '6' });
    if (us) params.set('countrycodes', 'us');
    if (near) {
      const d = 1;
      params.set('viewbox', [near.lon - d, near.lat + d, near.lon + d, near.lat - d].map((n) => n.toFixed(3)).join(','));
      params.set('bounded', '0');
    }
    const res = await fetch(`${NOMINATIM}?${params}`, { signal: withTimeout(signal, 8000) });
    if (!res.ok) throw new Error(`Place search failed (${res.status})`);
    return res.json();
  };
  let rows = await ask(true);
  if (!rows.length) rows = await ask(false);
  return rows.map((r) => {
    const a = r.address ?? {};
    const isUS = a.country_code === 'us';
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const title = (r.name && r.name !== a.road ? r.name : '') || street || a.city || a.town || a.village || r.display_name.split(',')[0];
    const city = a.city || a.town || a.village || a.hamlet || '';
    const state = isUS ? US_STATES[a.state] ?? a.state : a.state;
    const detail = [title !== street ? street : '', city, state, isUS ? '' : a.country].filter((x) => x && x !== title).join(', ');
    return { title, detail, label: detail ? `${title}, ${detail}` : title, lat: Number(r.lat), lon: Number(r.lon) };
  });
}
