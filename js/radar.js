// Precipitation radar tiles from RainViewer (https://www.rainviewer.com/api.html).
// Free and keyless, though not itself open source. Tiles are only served up to
// zoom 7, so MapLibre overzooms them beyond that.

const INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
const SOURCE = 'radar';

export async function showRadar(map) {
  const res = await fetch(INDEX);
  if (!res.ok) throw new Error('Radar is unavailable right now');
  const data = await res.json();
  const frames = data.radar?.past ?? [];
  const latest = frames[frames.length - 1];
  if (!latest) throw new Error('No radar frames available');

  hideRadar(map);
  map.addSource(SOURCE, {
    type: 'raster',
    tiles: [`${data.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`],
    tileSize: 256,
    maxzoom: 7,
    attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
  });
  // Insert beneath our own layers (warnings, routes) so they stay readable.
  const before = ['nws-fill', 'alt-line', 'route-casing'].find((id) => map.getLayer(id));
  map.addLayer({ id: SOURCE, type: 'raster', source: SOURCE, paint: { 'raster-opacity': 0.6 } }, before);
  return new Date(latest.time * 1000);
}

export function hideRadar(map) {
  if (map.getLayer(SOURCE)) map.removeLayer(SOURCE);
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
}
