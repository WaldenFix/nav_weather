// WMO weather interpretation codes, as returned by Open-Meteo's `weather_code`.
// https://open-meteo.com/en/docs#weather_variable_documentation

const CODES = {
  0: ['Clear', '☀️'],
  1: ['Mostly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Drizzle', '🌦️'],
  55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🧊'],
  57: ['Heavy freezing drizzle', '🧊'],
  61: ['Light rain', '🌦️'],
  63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🧊'],
  67: ['Heavy freezing rain', '🧊'],
  71: ['Light snow', '🌨️'],
  73: ['Snow', '🌨️'],
  75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'],
  81: ['Showers', '🌧️'],
  82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'],
  86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm with hail', '⛈️'],
  99: ['Severe thunderstorm with hail', '⛈️'],
};

export function describe(code) {
  const [label, icon] = CODES[code] ?? ['Unknown', '❔'];
  return { label, icon };
}

// Driving severity: 0 fine, 1 minor, 2 caution, 3 hazardous.
// Combines the weather code with wind gusts (km/h) and visibility (m).
export function severity({ code, gusts = 0, visibility = Infinity, snowfall = 0 }) {
  let s = 0;
  if ([1, 2, 3].includes(code)) s = 0;
  else if ([51, 53, 61, 80].includes(code)) s = 1;
  else if ([45, 55, 63, 71, 77, 81, 85].includes(code)) s = 2;
  else if ([48, 56, 57, 65, 66, 67, 73, 75, 82, 86, 95, 96, 99].includes(code)) s = 3;

  if (gusts >= 90) s = Math.max(s, 3);
  else if (gusts >= 60) s = Math.max(s, 2);
  else if (gusts >= 45) s = Math.max(s, 1);

  if (visibility < 200) s = Math.max(s, 3);
  else if (visibility < 1000) s = Math.max(s, 2);

  if (snowfall >= 1) s = Math.max(s, 3);
  return s;
}

export const SEVERITY_LABEL = ['Good', 'Minor', 'Caution', 'Hazardous'];
