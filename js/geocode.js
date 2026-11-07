// Place search via Photon (https://photon.komoot.io), an open-source geocoder
// built on OpenStreetMap data. It allows search-as-you-type, unlike Nominatim.

const PHOTON = 'https://photon.komoot.io/api/';

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
