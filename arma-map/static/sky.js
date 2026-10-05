// Sun and moon for the game clock: where they are and when they rise and set, for a date, a latitude and a time of day.
// The game's clock is taken as local solar time (12:00 is when the sun is highest), so no longitude is needed. The
// moon's phase follows the real calendar for the date given; its position is approximate (within a degree or two).
// Angles are in degrees, times in seconds since midnight of the clock's date (they run on past 86400 into later days).
(function (root) {
  'use strict';
  const RAD = Math.PI / 180, DAY = 86400, SYNODIC = 29.530588, J2000 = Date.UTC(2000, 0, 1, 12);
  const PHASES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];

  // Sun and moon at S seconds after midnight of clock.year/month/day.
  function bodies(S, clock) {
    const t = Date.UTC(clock.year, clock.month - 1, clock.day) + S * 1000;
    const n = (t - J2000) / 86400000;                 // days since J2000
    const hours = ((S % DAY) + DAY) % DAY / 3600;
    const phi = clock.lat * RAD, eps = (23.439 - 0.0000004 * n) * RAD;
    const g = (357.528 + 0.9856003 * n) * RAD;
    const ls = (280.460 + 0.9856474 * n + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD; // sun's ecliptic longitude
    const at = (lam) => {                              // declination and right ascension of a point on the ecliptic
      const dec = Math.asin(Math.sin(eps) * Math.sin(lam)), ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
      return { dec, ra };
    };
    const place = (dec, H) => {                        // altitude and azimuth (from north, clockwise) for hour angle H
      const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
      const az = Math.atan2(-Math.cos(dec) * Math.sin(H), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H));
      return { el: el / RAD, az: (az / RAD + 360) % 360 };
    };
    const H = (hours - 12) * 15 * RAD;
    const s = at(ls), sun = place(s.dec, H);
    const age = (((n - 5.76) % SYNODIC) + SYNODIC) % SYNODIC;  // days since the new moon of 2000-01-06
    const elong = age / SYNODIC * 360;
    const m = at(ls + elong * RAD), moon = place(m.dec, H + s.ra - m.ra);
    moon.illum = (1 - Math.cos(elong * RAD)) / 2;
    moon.age = age;
    moon.phase = PHASES[Math.floor(((elong + 22.5) % 360) / 45)];
    moon.waxing = elong < 180;
    return { sun, moon };
  }

  // How much light there is: a short name and a level, 0 (dark) to 5 (full day).
  function light(b) {
    const h = b.sun.el, m = b.moon;
    if (h >= 10) return { level: 5, name: 'Day' };
    if (h >= -0.833) return { level: 4, name: 'Low sun' };
    if (h >= -6) return { level: 3, name: 'Civil twilight' };
    if (h >= -12) return { level: 2, name: 'Nautical twilight' };
    if (m.el > 0 && m.illum > 0.7) return { level: 1, name: 'Night, bright moon' };
    if (m.el > 0 && m.illum > 0.25) return { level: 1, name: 'Night, moonlit' };
    return { level: 0, name: 'Night, dark' };
  }

  // The next rises, sets and twilights from S on (default 26 h), soonest first.
  function events(S, clock, hours = 26) {
    const out = [], step = 120, end = S + hours * 3600;
    const val = t => { const b = bodies(t, clock); return { sun: b.sun.el, moon: b.moon.el }; };
    const marks = [['sun', -0.833, 'Sunrise', 'Sunset'], ['sun', -6, 'First light', 'Last light'], ['moon', -0.5, 'Moonrise', 'Moonset']];
    let prev = val(S);
    for (let t = S + step; t <= end; t += step) {
      const cur = val(t);
      for (const [k, lim, up, down] of marks) {
        const a = prev[k] - lim, c = cur[k] - lim;
        if ((a < 0) === (c < 0)) continue;
        out.push({ t: t - step + step * a / (a - c), name: c > a ? up : down, body: k, rising: c > a });
      }
      prev = cur;
    }
    return out.sort((x, y) => x.t - y.t);
  }

  root.Sky = { bodies, light, events, DAY };
  if (typeof module !== 'undefined') module.exports = root.Sky;
})(typeof window !== 'undefined' ? window : globalThis);
