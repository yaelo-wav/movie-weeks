// Builds docs/data/letterboxd.json from a public Letterboxd profile: the films on the watchlist and the films
// logged in the diary, both as TMDB ids. The app uses it to sync its watchlist and "watched" markers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'data', 'letterboxd.json');
const SLUGS = path.join(ROOT, 'cache', 'letterboxd-slugs.json');
const USER = (process.env.LETTERBOXD_USER || 'yaelooo').toLowerCase();
const UA = 'OpeningWeeks/1.0 (personal release calendar)';

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return r.text();
}

// Watchlist: film slugs from every page, then each slug's TMDB id (cached; looked up once per film).
const slugs = [];
for (let page = 1; page <= 40; page++) {
  const html = await getText(`https://letterboxd.com/${USER}/watchlist/page/${page}/`);
  const found = [...html.matchAll(/data-item-slug="([^"]+)"/g)].map(m => m[1]);
  if (!found.length) break;
  slugs.push(...found);
  await sleep(700);
}
const cache = readJson(SLUGS, {});
for (const slug of new Set(slugs)) {
  if (cache[slug]) continue;
  try {
    const html = await getText(`https://letterboxd.com/film/${slug}/`);
    const id = Number(html.match(/data-tmdb-id="(\d+)"/)?.[1]);
    const type = html.match(/data-tmdb-type="([a-z]+)"/)?.[1];
    cache[slug] = { tmdb: type === 'movie' && id ? id : null };
  } catch (e) { console.warn(e.message); }
  await sleep(700);
}
writeJson(SLUGS, cache);
const watchlist = [...new Set(slugs.map(s => cache[s]?.tmdb).filter(Boolean))];

// Diary: the RSS feed has the most recent entries with their TMDB ids.
const rss = await getText(`https://letterboxd.com/${USER}/rss/`);
const watched = [...new Set([...rss.matchAll(/<item>[\s\S]*?<\/item>/g)]
  .map(m => Number(m[0].match(/<tmdb:movieId>(\d+)<\/tmdb:movieId>/)?.[1]))
  .filter(Boolean))];

writeJson(OUT, { user: USER, generatedAt: new Date().toISOString(), watchlist, watched });
console.log(`Letterboxd ${USER}: ${watchlist.length} films on the watchlist, ${watched.length} recently logged`);
