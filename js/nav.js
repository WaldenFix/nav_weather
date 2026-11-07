// Live turn-by-turn following using the browser's Geolocation API.

import { haversine } from './route.js';

const OFF_ROUTE_M = 60;
const OFF_ROUTE_FIXES = 3;

export class Navigator {
  constructor(route, { onUpdate, onOffRoute, onError }) {
    this.route = route;
    this.onUpdate = onUpdate;
    this.onOffRoute = onOffRoute;
    this.onError = onError;
    this.idx = 0;
    this.offCount = 0;
    this.watchId = null;
  }

  start() {
    if (!('geolocation' in navigator)) {
      this.onError(new Error('This device has no location support'));
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.#fix(pos),
      (err) => this.onError(err),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  setRoute(route) {
    this.route = route;
    this.idx = 0;
    this.offCount = 0;
  }

  #fix(pos) {
    const here = [pos.coords.longitude, pos.coords.latitude];
    const { coords, cumDist, cumTime, steps, distance, duration } = this.route;

    // Search near the last known position on the line, mostly ahead of it.
    const lo = Math.max(0, this.idx - 30);
    const hi = Math.min(coords.length - 1, this.idx + 400);
    let best = this.idx;
    let bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const d = haversine(here, coords[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.idx = best;

    if (bestD > OFF_ROUTE_M) {
      if (++this.offCount >= OFF_ROUTE_FIXES) {
        this.offCount = 0;
        this.onOffRoute({ lon: here[0], lat: here[1] });
      }
    } else {
      this.offCount = 0;
    }

    const along = cumDist[best];
    const next = steps.find((s) => s.startDist > along + 5) ?? steps[steps.length - 1];
    const current = steps.findLast((s) => s.startDist <= along + 5) ?? steps[0];
    this.onUpdate({
      position: here,
      heading: pos.coords.heading,
      speed: pos.coords.speed,
      along,
      current,
      next,
      toNext: Math.max(0, next.startDist - along),
      remainingDist: distance - along,
      remainingTime: duration - cumTime[best],
    });
  }
}
