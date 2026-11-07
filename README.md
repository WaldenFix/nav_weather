# Nav Weather

Driving navigation that shows the weather **when you'll actually be there**: it works out
your arrival time at points along the route and at your destination, then shows the
forecast for each point at that time.

It uses only open-source tools and open data. It has no Google or Apple services, no
API keys, no accounts and no tracking.

## Features

- Place search with autocomplete. You can also right-click (or long-press) the map to route from or to that spot.
- Driving route with turn-by-turn directions.
- **Route choices**: for example SF → Houston on I-10 or on I-40. Each option shows its distance, its extra time compared with the fastest, and how rough its weather looks at your departure time. The options are tagged *Fastest* and *Calmest*. Tap a card, or a grey line on the map, to switch routes.
- **Via stop**: makes the route go through a particular town ("via Albuquerque" forces I-40). You can also right-click the map and choose "Go via here".
- The route line is colored by driving conditions (good, minor, caution, hazardous). Weather bubbles on the map show the expected conditions at each point.
- A timeline of conditions along the trip, with alerts that group bad stretches together (for example, "Heavy rain 40–65 mi, 3:10–3:45 PM"). It also warns about possible icy roads.
- The forecast at your destination for your arrival time, plus the 12 hours after it.
- **Weather-adjusted drive times.** Each stretch of the route is slowed down by the weather forecast there, using US FHWA figures for how much rain, snow, ice, fog and wind reduce highway speeds. The delay pushes back the arrival time, and with it the forecast for everything further along. The summary and route cards show how much of the drive time is weather ("incl. 13 min for weather").
- **Official road reports (Washington):** WSDOT incidents, closures, construction and mountain pass conditions (road surface, chain and traction rules, temperature). They're shown in driving order with when you'll reach each one, and marked on the map. Add a free WSDOT access code in *Settings*; it's stored only on your device. The API supports JSONP, so this works from static hosting with no server.
- A **departure-time slider** covering the next 72 hours. The app also suggests a departure time when another one looks noticeably calmer.
- A live precipitation radar overlay.
- Live navigation mode: it follows your GPS position, shows the next maneuver and reroutes if you go off course.
  - Shows **the road you're on and the town you're in** (road from the route, town looked up with Photon about every half mile).
  - A trip gauge shows how far along you are, your arrival time and any bad-weather stretch ahead.
  - A weather warning stays dark until bad weather is within about 40 miles or 45 minutes, then lights up.
- **Storm chaser mode** (⛈️ Chase tab):
  - Scans the visible map area on a 9×9 grid for the next 12 hours. It scores thunderstorm potential from 0 to 100 using CAPE, lifted index, thunderstorm weather codes, rain chance and gusts.
  - Highlights the hotspots on the map and lists the best targets. Ones you can reach before the storms peak come first.
  - **Chase** routes you to a target and checks whether you'll arrive in time.
  - Turns on radar and loads active NWS tornado, severe thunderstorm and flash flood warnings, drawing warning polygons on the map (US only).
  - In this mode, route options are tagged *Most storms* instead of *Calmest*.
- **Storm watcher mode** (🔭 Watch tab), for watching storms from a safe distance rather than chasing them:
  - First it finds the strongest storms in view over the next 12 hours. Then it checks rings of possible viewing spots 20–50 km (12–30 mi) around each one.
  - A good spot is dry with low cloud overhead and good visibility. It sits *beside* the storm's path, using the 500 hPa winds to estimate where the storm is heading. By day it's better with the sun behind you. Slightly higher ground scores a little better.
  - Each spot is labeled **🌩️ Storm structure** (daylight) or **⚡ Lightning show** (after dark). It says when to be there, which way to look, how far away the storm is and which way it's moving. A dashed line on the map points from the spot to the storm.
  - **Go** routes you to the spot and checks you'll arrive in time for the best viewing.
  - Includes lightning safety guidance: watch from inside a hard-top car.
  - **🌊 Wind & waves** switch, for coastal storm watching (big surf plus strong wind, like a Pacific Northwest windstorm):
    - Uses Open-Meteo Marine wave forecasts for the sea just off the coast in view, plus gusts and daylight, over the next 36 hours.
    - Picks the best hour you can actually drive there for.
    - Names the nearest lighthouse, beach park or beach (from Photon). If none is found it falls back to the area name from Nominatim, for example "Jefferson County coast".
    - Includes sneaker-wave and driftwood-log safety guidance.
  - If there are no thunderstorms but a windstorm is under way, both storm modes say so, and list any wind, surf or flood alerts covering the area.
- **Biased to you**: your GPS position, start and destination act as anchors. When a storm mode turns on, the map moves to them first. Targets near them rank higher, distances are measured from you, and place search prefers results near you.
- **Radar legend**: shows what the colors mean (rain and snow intensity, not wind), using RainViewer's published color table.
- °F/mi or °C/km units. On phones the panel becomes a bottom sheet.
- **Themes**: Light, Dark (warm charcoal, easier on the eyes) and **Night**, an amber night-driving theme with the map dimmed to faint roads. *Auto* follows your phone's light/dark setting and switches to Night when you start navigating in the dark. The moon button switches Night on or off while you drive.

## Run it

You need [Node.js](https://nodejs.org). There's nothing to install:

```bash
npm start
```

Then open http://localhost:8080. To use GPS on a phone, the page has to be served over
HTTPS. Browsers only allow geolocation on secure origins and `localhost`.

## Put it on your iPhone (free)

The app is a Progressive Web App. Host it on any free static HTTPS host, then add it
to your home screen. It doesn't need the App Store or an Apple Developer account.

**1a. Host it on [GitHub Pages](https://pages.github.com)** (free):

1. On GitHub, create a new **public**, **empty** repository named `nav-weather`. Don't add a README, license or .gitignore, because this folder already has them.
2. Push this folder to it:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/nav-weather.git
   git push -u origin main
   ```
3. In the repository, go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
4. After a minute or two the app is live at `https://YOUR-USERNAME.github.io/nav-weather/`. The empty `.nojekyll` file tells GitHub to serve the files as they are.

**1b. Or host it on [Codeberg Pages](https://codeberg.org)** (non-profit, free):

1. Create a Codeberg account and a new, empty repository named **`pages`**.
2. Push this folder to it:
   ```bash
   git remote add origin https://codeberg.org/YOUR-USERNAME/pages.git
   git push -u origin main
   ```
3. After a minute or two the app is live at `https://YOUR-USERNAME.codeberg.page/`.

You can use a repository with a different name, for example `nav-weather`. In that case push to a branch called `pages` (`git push origin main:pages`), and the app will be at `https://YOUR-USERNAME.codeberg.page/nav-weather/`. GitHub Pages, Cloudflare Pages and Netlify also work, since the app is just static files.

**2. On the iPhone:** open that address in **Safari** and tap **Share → Add to Home Screen**. It opens full-screen with its own icon. The app's code is cached, so it opens even on a weak signal, but maps and forecasts still need data.

**iPhone notes**
- Allow location when asked. If you said no, re-enable it in *Settings → Privacy & Security → Location Services → Safari Websites*.
- During navigation the app keeps the screen on, because iOS stops GPS when the screen locks. If the screen does lock, unlock it and tracking resumes.
- **Quick test without hosting:** with your phone and PC on the same Wi-Fi, run `npm start` and open `http://YOUR-PC-IP:8080` on the phone. Everything works except GPS, which needs HTTPS.

## Updating the icons

`icons/*.png` are generated from the shapes in `icon.svg`. If you change the design, run `node tools/make-icons.js`. When you add or rename app files, bump `VERSION` in `sw.js` so installed copies pick up the change.

## How it works

1. **Route**: OSRM returns the route geometry along with the travel time for every segment, so we know the time offset for each point on the line (`js/route.js`).
2. **Sample**: we pick up to 40 evenly spaced points along the route.
3. **Forecast**: one Open-Meteo request gets hourly forecasts for every sample point (`js/weather.js`).
4. **Match times**: for each point, ETA = departure time + time offset. We interpolate the hourly forecast to that ETA. Because of this, moving the departure slider is instant: nothing has to be downloaded again.
5. **Rate**: WMO weather codes, wind gusts, visibility and snowfall are combined into a driving severity from 0 to 3 (`js/wmo.js`).

## Stack

| Piece | Project | License | Notes |
|---|---|---|---|
| Map rendering | [MapLibre GL JS](https://maplibre.org) | BSD-3 | Open-source fork of Mapbox GL |
| Map tiles | [OpenFreeMap](https://openfreemap.org) | MIT / ODbL data | OpenStreetMap vector tiles, no key |
| Routing | [OSRM](https://project-osrm.org) on the FOSSGIS server | BSD-2 | Demo server with fair-use limits |
| Search | [Photon](https://photon.komoot.io) | Apache-2.0 | OSM geocoder with type-ahead |
| Forecasts | [Open-Meteo](https://open-meteo.com) | AGPL-3.0 / CC-BY data | Built on NOAA, DWD, ECMWF and other national weather services |
| Wave forecasts | [Open-Meteo Marine](https://open-meteo.com/en/docs/marine-weather-api) | AGPL-3.0 / CC-BY data | Wave height and period for Wind & waves mode |
| Place names on the coast | [Nominatim](https://nominatim.org) | GPL-2.0 / ODbL data | Fallback only; 1 request per second |
| Road reports (WA) | [WSDOT Traveler Information API](https://wsdot.wa.gov/traffic/api/) | Public, free access code | Incidents, closures, mountain passes |
| Severe weather alerts | [NWS api.weather.gov](https://www.weather.gov/documentation/services-web-api) | US public domain | Tornado, severe thunderstorm and flood warnings |
| Radar | [RainViewer](https://www.rainviewer.com/api.html) | Free API, not open source | Optional overlay |

You can self-host every service. Change the URL constant at the top of each module.

## Caveats

- The public OSRM, Photon and Open-Meteo servers are free community resources with fair-use limits. Before you ship this to many users, run your own instances (all three have Docker images) or use a paid plan.
- On Android Chrome, the browser's geolocation runs through Google Play Services. To be completely free of Google, use a de-Googled browser or OS, or wrap the app natively (see below).
- Forecasts become less accurate the further ahead they are. Read the 72-hour departure window as a guide, not a promise.

## Ideas for next steps

- **Native Android app** with [Capacitor](https://capacitorjs.com) and MapLibre Native, so it can use raw GPS and be published on F-Droid.
- **Offline maps** using [PMTiles](https://protomaps.com/docs/pmtiles) extracts.
- **Self-hosted stack**: a `docker-compose.yml` that runs OSRM or Valhalla, Photon, Open-Meteo and a tile server.
- **Faster alternatives**: the public OSRM server can take 30–60 s to find alternatives on cross-country trips. A self-hosted OSRM or Valhalla server answers in under a second.
- **Storm chaser extras**: storm motion vectors, a storm-relative intercept point, and SPC convective outlooks as a map layer.
- **Live lightning strikes** for storm watcher mode: [Blitzortung.org](https://www.blitzortung.org) (volunteer network; check its terms for non-commercial use first) or NOAA GOES GLM satellite data (public domain, needs a small server to convert it).
- **Animated radar** using RainViewer's past and nowcast frames.
- **Government weather alerts** from the NWS `api.weather.gov` (US) or MeteoAlarm (EU).
- **Voice guidance** with the Web Speech API.
- **More states' road data**: other state DOT / 511 feeds, and US work-zone feeds in the open WZDx format.
- **Community traffic, once there are enough users.** With opt-in only, the app would send anonymous speed reports (road segment, speed, time; no account, no device ID, trip start and end dropped). A small server would snap them to roads with Valhalla's map matching, average them per segment and publish live slowdowns. The archived OpenTraffic project is a design reference. It only becomes useful once a few hundred drivers in an area use the app.

## License

Copyright (C) 2026 the Nav Weather contributors.

Nav Weather is free software. You can redistribute it and/or modify it under the
terms of the [GNU General Public License](LICENSE), either version 3 of the License or
(at your option) any later version. Anyone who shares a modified version has to share
their source code under the same license.

Map data © OpenStreetMap contributors (ODbL). Forecast data from Open-Meteo (CC BY 4.0).
