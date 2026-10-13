// One-time import of every watched film from a Letterboxd data export (Settings → Import & Export → Export your
// data). Usage: node scripts/import-letterboxd-export.mjs path/to/watched.csv
// Matches each film to TMDB by title + year and saves the ids to cache/letterboxd-history.json, which
// build-letterboxd.mjs merges into the watched list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'cache', 'letterboxd-history.json');
const KEY = process.env.TMDB_API_KEY || JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).tmdbApiKey;
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import-letterboxd-export.mjs path/to/watched.csv'); process.exit(1); }

// Minimal CSV parser (quoted fields, commas and quotes inside quotes).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(Boolean));
}

const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const col = name => header.findIndex(h => h.trim().toLowerCase() === name);
const iName = col('name'), iYear = col('year');
if (iName < 0) throw new Error(`No "Name" column in ${file}; expected Letterboxd's watched.csv`);

const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const history = JSON.parse(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '{"watched":[]}');
const ids = new Set(history.watched);
let matched = 0;
const missed = [];

for (const r of rows) {
  const name = r[iName], year = Number(r[iYear]) || null;
  const qs = new URLSearchParams({ api_key: KEY, query: name, include_adult: 'false', ...(year ? { year: String(year) } : {}) });
  const res = (await (await fetch(`https://api.themoviedb.org/3/search/movie?${qs}`)).json()).results || [];
  const hit = res.find(m => norm(m.title) === norm(name) || norm(m.original_title) === norm(name)) || res[0];
  if (hit) { ids.add(hit.id); matched++; } else missed.push(`${name} (${year})`);
  await sleep(60);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ importedAt: new Date().toISOString(), watched: [...ids] }));
console.log(`Imported ${matched} of ${rows.length} films${missed.length ? `; not found: ${missed.join(', ')}` : ''}`);
