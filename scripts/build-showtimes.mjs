// Builds docs/data/showtimes.json: every screening at Pathé De Kuip and Pathé Schouwburgplein (Rotterdam),
// matched to TMDB/Filmvandaag films so the app can find double screenings on your watchlist. Run after build-data.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'data', 'showtimes.json');
const RELEASES = path.join(ROOT, 'docs', 'data', 'releases.json');
const MAP = path.join(ROOT, 'cache', 'pathe-map.json');
const KEY = process.env.TMDB_API_KEY || readJson(path.join(ROOT, 'config.json'), {}).tmdbApiKey;
const CINEMAS = [
  { slug: 'pathe-de-kuip', name: 'Pathé De Kuip' },
  { slug: 'pathe-schouwburgplein', name: 'Pathé Schouwburgplein' },
];
const PATHE = 'https://www.pathe.nl/api';
const UA = 'OpeningWeeks/1.0 (personal release calendar)';
const RECHECK_UNMATCHED = 20 * 3600e3;

if (!KEY) { console.error('Missing TMDB_API_KEY'); process.exit(1); }

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 0) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if ((r.status === 429 || r.status >= 500) && tries < 4) { await sleep(1500 * (tries + 1)); return getJson(url, tries + 1); }
  if (!r.ok) throw new Error(`${r.status} for ${url.replace(/api_key=[^&]+/, 'api_key=…')}`);
  return r.json();
}
const tmdb = (p, params = {}) => getJson(`https://api.themoviedb.org/3${p}?${new URLSearchParams({ api_key: KEY, ...params })}`);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { console.warn(e.message); out[k] = null; }
      await sleep(150); // keep the load on Pathé light
    }
  }));
  return out;
}

// "Het Vergeten Eiland (Nederlandse versie)" -> "het vergeten eiland"
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\((nederlandse|originele) versie\)|\b(nederlands gesproken|nl|ov|re-release|\d+(th|e) anniversary)\b/g, ' ')
  .replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// Match a Pathé show to our data: first against this run's releases (gives Filmvandaag + TMDB ids), else TMDB search.
async function match(show, releases) {
  const names = new Set([norm(show.title), norm(show.originalTitle)].filter(Boolean));
  const release = show.releaseAt?.NL_NL || show.originalReleaseAt || '';
  const hits = releases.filter(f => names.has(norm(f.title)) || names.has(norm(f.altTitle)));
  if (hits.length) {
    hits.sort((a, b) => Math.abs(new Date(a.nl) - new Date(release || a.nl)) - Math.abs(new Date(b.nl) - new Date(release || b.nl)));
    return { tmdb: hits[0].tmdb || null, fv: hits[0].fv };
  }
  const year = Number(release.slice(0, 4)) || null;
  for (const query of [show.originalTitle, show.title].filter(Boolean)) {
    const clean = query.replace(/\([^)]*\)/g, ' ').replace(/\b(nederlands gesproken|re-release|nl|ov)\s*$/i, ' ').replace(/\s+/g, ' ').trim();
    const res = (await tmdb('/search/movie', { query: clean, language: 'nl-NL', include_adult: 'false' })).results || [];
    // Only accept an exact title match, so events like "Sneak Night" don't latch onto a random film.
    const ok = res.find(r => (norm(r.title) === norm(query) || norm(r.original_title) === norm(query))
      && (!year || Math.abs(Number((r.release_date || '0').slice(0, 4)) - year) <= 1));
    if (ok) return { tmdb: ok.id, fv: null };
    // Re-runs of classics (The Shining, Halloween) carry this year's date: confirm by director instead.
    const directors = (show.directors || '').split(',').map(norm).filter(Boolean);
    const sameTitle = res.filter(r => norm(r.title) === norm(clean) || norm(r.original_title) === norm(clean)).slice(0, 5);
    for (const r of directors.length ? sameTitle : []) {
      const crew = (await tmdb(`/movie/${r.id}/credits`)).crew || [];
      if (crew.some(c => c.job === 'Director' && directors.includes(norm(c.name)))) return { tmdb: r.id, fv: null };
    }
  }
  return { tmdb: null, fv: null };
}

const FORMATS = { dolby: 'Dolby', '4dx': '4DX', imax: 'IMAX', screenx: 'ScreenX', '3d': '3D', atmos: 'Atmos' };

// ---------- main ----------
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); // YYYY-MM-DD
const programmes = {};
for (const c of CINEMAS) {
  programmes[c.slug] = (await getJson(`${PATHE}/cinema/${c.slug}/shows`)).shows || {};
  if (!Object.keys(programmes[c.slug]).length) throw new Error(`Pathé returned no shows for ${c.name}; the API may have changed`);
}
const slugs = [...new Set(Object.values(programmes).flatMap(p => Object.keys(p)))];

const releases = readJson(RELEASES, { films: [] }).films;
const map = readJson(MAP, {});
for (const slug of slugs) {
  const known = map[slug];
  if (known && (known.tmdb || known.fv || Date.now() - known.checkedAt < RECHECK_UNMATCHED)) continue;
  try {
    const show = await getJson(`${PATHE}/show/${slug}`);
    map[slug] = { title: show.title, ...(await match(show, releases)), checkedAt: Date.now() };
  } catch (e) { console.warn(e.message); }
  await sleep(150);
}
// Re-link Filmvandaag ids for films that showed up in the release data after they were first matched.
for (const m of Object.values(map)) if (m.tmdb && !m.fv) m.fv = releases.find(f => f.tmdb === m.tmdb)?.fv || null;
writeJson(MAP, map);

// One request per film, per cinema, per day it plays there.
const jobs = CINEMAS.flatMap(c => Object.entries(programmes[c.slug])
  .filter(([slug]) => map[slug]?.tmdb || map[slug]?.fv)
  .flatMap(([slug, show]) => Object.keys(show.days || {}).filter(d => d >= today).map(day => ({ cinema: c.slug, slug, day }))));
const results = await pool(jobs, 4, j => getJson(`${PATHE}/show/${j.slug}/showtimes/${j.cinema}/${j.day}`));

const films = Object.fromEntries(CINEMAS.map(c => [c.slug, new Map()]));
jobs.forEach((j, i) => {
  const list = Array.isArray(results[i]) ? results[i] : [];
  const m = map[j.slug], byFilm = films[j.cinema];
  if (!byFilm.has(j.slug)) byFilm.set(j.slug, { slug: j.slug, title: m.title, tmdb: m.tmdb, fv: m.fv, screenings: [] });
  for (const s of list) {
    // Skip Dutch-language screenings (Dutch films and Dutch-dubbed versions).
    if (!s.time || !s.endTime || s.version === 'nlnl') continue;
    byFilm.get(j.slug).screenings.push({
      start: s.time.slice(0, 16).replace(' ', 'T'),
      end: s.endTime.slice(0, 16).replace(' ', 'T'),
      screen: (s.auditoriumName || '').replace(/\s+/g, ' ').trim(),
      version: (s.version || '').toUpperCase(),
      formats: (s.tags || []).map(t => FORMATS[t]).filter(Boolean),
      soldOut: s.status === 'full' || s.status === 'soldout',
      book: s.refCmd || null,
    });
  }
});
const cinemas = CINEMAS.map(c => {
  const list = [...films[c.slug].values()].filter(f => f.screenings.length)
    .map(f => ({ ...f, screenings: f.screenings.sort((a, b) => a.start.localeCompare(b.start)) }));
  console.log(`${c.name}: ${list.length} films, ${list.reduce((n, f) => n + f.screenings.length, 0)} screenings`);
  return { ...c, films: list };
});
writeJson(OUT, { generatedAt: new Date().toISOString(), cinemas });
console.log(`${jobs.length} showtime requests`);
const unmatched = slugs.filter(s => !map[s]?.tmdb && !map[s]?.fv);
if (unmatched.length) console.log(`Not matched (skipped): ${unmatched.join(', ')}`);
