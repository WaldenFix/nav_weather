// Place search via Photon (https://photon.komoot.io), an open-source geocoder
// built on OpenStreetMap data. It allows search-as-you-type, unlike Nominatim.

const PHOTON = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE = 'https://photon.komoot.io/reverse';

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

export async function search(query, bias, signal) {
  const params = new URLSearchParams({ q: query, limit: '6' });
  const lang = navigator.language?.slice(0, 2);
  if (['en', 'de', 'fr', 'it'].includes(lang)) params.set('lang', lang);
  if (bias) {
    params.set('lat', bias.lat.toFixed(4));
    params.set('lon', bias.lon.toFixed(4));
    // Regional rather than street-level bias, so "Spokane" finds the city, not a nearby street.
    params.set('zoom', '7');
  }
  let res;
  try {
    res = await fetch(`${PHOTON}?${params}`, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Place search (photon.komoot.io) isn\'t responding right now. Try again in a minute, or right-click the map to pick a spot.');
  }
  if (!res.ok) throw new Error(`Place search failed (${res.status}). Try again in a minute.`);
  const data = await res.json();
  return data.features.map((f) => {
    const p = f.properties;
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const title = p.name || street || p.city || 'Unnamed place';
    const detail = [p.name ? street : '', p.city, p.state, p.country]
      .filter((x) => x && x !== title)
      .join(', ');
    const [lon, lat] = f.geometry.coordinates;
    return { title, detail, label: detail ? `${title}, ${detail}` : title, lat, lon };
  });
}
