// Builds docs/data/releases.json: Dutch cinema release dates from Filmvandaag.nl, enriched with
// posters, US dates, synopsis and cast from TMDB. Runs on a schedule in GitHub Actions (see
// .github/workflows/update-data.yml) and locally with: node scripts/build-data.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'data', 'releases.json');
const MAP = path.join(ROOT, 'cache', 'fv-map.json');
const KEY = process.env.TMDB_API_KEY || readJson(path.join(ROOT, 'config.json'), {}).tmdbApiKey;
const UA = 'OpeningWeeks/1.0 (personal release calendar)';
const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const KEEP_PAST_DAYS = 8 * 7;          // keep films that already opened for this long
const RECHECK_UNMATCHED = 20 * 3600e3;  // retry films without a TMDB match after this long

if (!KEY) { console.error('Missing TMDB_API_KEY'); process.exit(1); }

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const decode = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function get(url, tries = 0) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (r.status === 429 && tries < 5) { await sleep(2000 * (tries + 1)); return get(url, tries + 1); }
  if (!r.ok) throw new Error(`${r.status} for ${url.replace(/api_key=[^&]+/, 'api_key=…')}`);
  return r;
}
const tmdb = (p, params = {}) => get(`https://api.themoviedb.org/3${p}?${new URLSearchParams({ api_key: KEY, ...params })}`).then(r => r.json());

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { console.warn(e.message); out[k] = null; } }
  }));
  return out;
}

// ---------- Filmvandaag ----------
function parseList(html) {
  return html.split('<li class="item is-movie">').slice(1).map(item => {
    const link = item.match(/href="\/film\/(\d+)-([^"]+)"/);
    const alt = item.match(/alt="([^"]+)"/);
    const d = item.match(/Vanaf (\d{1,2}) ([a-z]+)\.? (\d{4}) in de bioscoop/);
    if (!link || !alt || !d) return null;
    const month = d[2].startsWith('maa') ? 2 : MONTHS.findIndex(m => d[2].startsWith(m));
    if (month < 0) return null;
    const t = decode(alt[1]).match(/^(.*?)(?: \((\d{4})\))?$/);
    return {
      fv: Number(link[1]), slug: link[2], title: t[1], year: t[2] ? Number(t[2]) : null,
      nl: `${d[3]}-${pad(month + 1)}-${pad(d[1])}`,
      fvDirectors: [...item.matchAll(/href='\/regisseur\/[^']*'>([^<]+)</g)].map(x => decode(x[1])),
    };
  }).filter(Boolean);
}

// "Now in cinemas" list: same items, but without a release date.
function parseNowShowing(html) {
  return html.split('<li class="item is-movie">').slice(1).map(item => {
    const link = item.match(/href="\/film\/(\d+)-([^"]+)"/);
    const alt = item.match(/alt="([^"]+)"/);
    if (!link || !alt) return null;
    const t = decode(alt[1]).match(/^(.*?)(?: \((\d{4})\))?$/);
    return {
      fv: Number(link[1]), slug: link[2], title: t[1], year: t[2] ? Number(t[2]) : null,
      fvDirectors: [...item.matchAll(/href='\/regisseur\/[^']*'>([^<]+)</g)].map(x => decode(x[1])),
    };
  }).filter(Boolean);
}

// Match a Filmvandaag film to TMDB: via the IMDb ID on its film page, else by title + year.
async function resolve(f, map) {
  const known = map[f.fv];
  if (known?.tmdb) return known.tmdb;
  if (known && Date.now() - known.checkedAt < RECHECK_UNMATCHED) return null;
  let imdb = null, id = null;
  try {
    const html = await (await get(`https://www.filmvandaag.nl/film/${f.fv}-${f.slug}`)).text();
    imdb = html.match(/imdb\.com\/title\/(tt\d{7,9})/)?.[1] || null;
  } catch (e) { console.warn(e.message); }
  await sleep(400); // be polite to Filmvandaag
  if (imdb) id = (await tmdb(`/find/${imdb}`, { external_source: 'imdb_id' })).movie_results?.[0]?.id || null;
  if (!id) {
    const res = (await tmdb('/search/movie', { query: f.title, language: 'nl-NL', include_adult: 'false' })).results || [];
    const yearOk = r => !f.year || Math.abs(Number((r.release_date || '0').slice(0, 4)) - f.year) <= 1;
    id = res.find(yearOk)?.id || null;
  }
  map[f.fv] = { imdb, tmdb: id, checkedAt: Date.now() };
  return id;
}

// ---------- TMDB details ----------
function theatrical(m, country) {
  const r = (m.release_dates?.results || []).find(x => x.iso_3166_1 === country);
  const th = (r?.release_dates || []).filter(x => x.type === 2 || x.type === 3).sort((a, b) => a.release_date.localeCompare(b.release_date));
  return th.length ? { date: th[0].release_date.slice(0, 10), cert: th.find(x => x.certification)?.certification || '' } : null;
}

function film(f, m) {
  const base = {
    fv: f.fv, fvSlug: f.slug, title: f.title, year: f.year, nl: f.nl,
    directors: f.fvDirectors.map(name => ({ name, profile: null })), cast: [],
  };
  if (!m) return base;
  const us = theatrical(m, 'US'), nl = theatrical(m, 'NL');
  return {
    ...base,
    tmdb: m.id,
    lang: m.original_language || null,
    altTitle: m.title !== f.title ? m.title : undefined,
    year: f.year || Number((m.release_date || '').slice(0, 4)) || null,
    us: us?.date || null,
    popularity: m.popularity,
    poster: m.poster_path, backdrop: m.backdrop_path,
    tagline: m.tagline || '', overview: m.overview || '',
    runtime: m.runtime || null, genres: (m.genres || []).map(g => g.name),
    cert: nl?.cert ? `NL ${nl.cert}` : us?.cert || '',
    directors: (m.credits?.crew || []).filter(c => c.job === 'Director').map(c => ({ name: c.name, profile: c.profile_path })),
    cast: (m.credits?.cast || []).slice(0, 12).map(c => ({ name: c.name, character: c.character, profile: c.profile_path })),
  };
}

// ---------- main ----------
const listHtml = await (await get('https://www.filmvandaag.nl/nieuwefilms')).text();
const upcoming = parseList(listHtml);
if (upcoming.length < 20) throw new Error(`Only ${upcoming.length} films parsed from Filmvandaag; page layout may have changed`);
console.log(`Filmvandaag: ${upcoming.length} upcoming films`);

// Films already in cinemas, so earlier weeks stay filled while those films are still playing.
const upcomingIds = new Set(upcoming.map(f => f.fv));
const nowShowing = parseNowShowing(await (await get('https://www.filmvandaag.nl/bioscoop')).text()).filter(f => !upcomingIds.has(f.fv));
if (nowShowing.length < 20) throw new Error(`Only ${nowShowing.length} films parsed from Filmvandaag's now-showing list; page layout may have changed`);
console.log(`Filmvandaag: ${nowShowing.length} films now in cinemas`);

const map = readJson(MAP, {});
for (const f of [...upcoming, ...nowShowing]) f.tmdb = await resolve(f, map);
writeJson(MAP, map);

const fetchDetails = list => pool(list, 8, f => f.tmdb ? tmdb(`/movie/${f.tmdb}`, { language: 'en-US', append_to_response: 'credits,release_dates' }) : null);
const upcomingDetails = await fetchDetails(upcoming);
const films = upcoming.map((f, i) => film(f, upcomingDetails[i]));

const day = offset => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const cutoff = day(-KEEP_PAST_DAYS), soon = day(7), oldest = day(-270);
const previousFilms = readJson(OUT, { films: [] }).films;
const previousDate = new Map(previousFilms.map(f => [f.fv, f.nl]));

// Release date for a film that's already playing: the Filmvandaag date saved by an earlier run, else TMDB's
// Dutch cinema date if it's from the last 9 months. Classics back in cinemas (no recent date) are left out.
const nowDetails = await fetchDetails(nowShowing);
const playing = nowShowing.map((f, i) => {
  const nl = previousDate.get(f.fv) || theatrical(nowDetails[i] || {}, 'NL')?.date;
  return nl && nl >= oldest && nl <= soon ? { ...film({ ...f, nl }, nowDetails[i]), nowShowing: true } : null;
}).filter(Boolean);

// Films drop off Filmvandaag's "coming soon" list once they open, and sometimes a few days before.
// Keep them from the previous run for a while; films more than a week out that vanish were probably postponed.
const current = new Set([...films, ...playing].map(f => f.fv));
const previous = previousFilms.filter(f => !current.has(f.fv) && f.nl >= cutoff && f.nl <= soon);

// Leave out Dutch-language films. Films TMDB doesn't know are small Dutch releases too.
const wanted = f => f.tmdb && f.lang !== 'nl';
const all = [...previous, ...playing, ...films];
const out = all.filter(wanted);

// Letterboxd average rating for films that are already out (in NL or the US). Letterboxd has no API, so read
// the rating from the film page (found via /tmdb/<id>/), politely and only once per weekly run.
const LB_CACHE = path.join(ROOT, 'cache', 'letterboxd.json');
const lb = readJson(LB_CACHE, {});
const todayStr = day(0);
const released = out.filter(f => f.nl <= todayStr || (f.us && f.us <= todayStr));
let lbOk = 0, lbFail = 0;
for (const f of released) {
  try {
    const r = await fetch(`https://letterboxd.com/tmdb/${f.tmdb}/`, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error(`Letterboxd ${r.status}`);
    const html = await r.text();
    const rating = Number(html.match(/"ratingValue":\s*([\d.]+)/)?.[1]) || null;
    const slug = new URL(r.url).pathname.match(/\/film\/([^/]+)/)?.[1] || null;
    lb[f.tmdb] = { rating, slug, checkedAt: Date.now() };
    lbOk++;
  } catch (e) { lbFail++; } // keep the previous rating if this run can't reach Letterboxd
  await sleep(700);
}
writeJson(LB_CACHE, lb);
for (const f of out) if (lb[f.tmdb]?.slug) f.lb = { rating: lb[f.tmdb].rating, slug: lb[f.tmdb].slug };
console.log(`Letterboxd: ${lbOk} checked, ${lbFail} failed, ${out.filter(f => f.lb?.rating).length} films with a rating`);
writeJson(OUT, { generatedAt: new Date().toISOString(), source: 'filmvandaag.nl + TMDB', films: out });
console.log(`Wrote ${out.length} films: ${films.filter(wanted).length} upcoming, ${playing.filter(wanted).length} now showing, ${previous.filter(wanted).length} kept from earlier (${all.length - out.length} Dutch or unmatched left out)`);
