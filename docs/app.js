// Opening Weeks: Dutch cinema releases per week, with a watchlist stored on this device.
// Release data comes from data/releases.json, rebuilt every few hours by a GitHub Action.
const IMG = 'https://image.tmdb.org/t/p/';
const PAGE = 20;
const WL_KEY = 'opening-weeks:watchlist';

const ICON = {
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

const state = {
  view: viewFromHash(),
  selected: mondayOf(new Date()),
  shown: PAGE,
  films: null,        // fv id -> film
  byWeek: new Map(),  // monday key -> films sorted by popularity
  generatedAt: null,
  watchlist: loadWatchlist(), // [{ fv, addedAt, film }]
  showtimes: null,    // Pathé screenings per cinema, from data/showtimes.json
};
function viewFromHash() {
  return { '#watchlist': 'watchlist', '#doubles': 'doubles' }[location.hash] || 'releases';
}

// ---------- dates ----------
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function mondayOf(d) { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function key(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  return { week: Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7), year: y };
}
const parseDay = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const fmt = (d, o = { day: 'numeric', month: 'short', year: 'numeric' }) => d.toLocaleDateString('en-GB', o);
const short = s => fmt(parseDay(s), { weekday: 'short', day: 'numeric', month: 'short' });
const rangeLabel = monday => `${fmt(monday, { day: 'numeric', month: 'short' })} – ${fmt(addDays(monday, 6))}`;
function weekTitle(monday) {
  const { week, year } = isoWeek(monday);
  return `Week <em>${week}</em>${year !== new Date().getFullYear() ? ` ${year}` : ''}`;
}

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isRerelease = f => f.year && Number(f.nl.slice(0, 4)) - f.year >= 2;
const onList = fv => state.watchlist.some(i => i.fv === fv);
const filmFor = fv => state.films?.get(fv) || state.watchlist.find(i => i.fv === fv)?.film;

// ---------- watchlist storage (this device only) ----------
function loadWatchlist() {
  try { return JSON.parse(localStorage.getItem(WL_KEY)) || []; } catch { return []; }
}
function saveWatchlist() {
  try { localStorage.setItem(WL_KEY, JSON.stringify(state.watchlist)); } catch {}
}
function toggleSave(fv) {
  if (onList(fv)) state.watchlist = state.watchlist.filter(i => i.fv !== fv);
  else state.watchlist.push({ fv, addedAt: new Date().toISOString(), film: filmFor(fv) });
  saveWatchlist();
  updateCount();
  if (state.view === 'watchlist') renderWatchlist();
  if (state.view === 'doubles') renderDoubles();
  document.querySelectorAll(`[data-save="${fv}"]`).forEach(updateSaveButton);
}
function updateSaveButton(b) {
  const fv = +b.dataset.save, saved = onList(fv), title = filmFor(fv)?.title || '';
  b.setAttribute('aria-pressed', saved);
  if (b.classList.contains('add')) b.innerHTML = `${saved ? ICON.check : ICON.add}<span>${saved ? 'On your watchlist' : 'Add to watchlist'}</span>`;
  else { b.innerHTML = saved ? ICON.check : ICON.add; b.setAttribute('aria-label', `${saved ? 'Remove from' : 'Add to'} watchlist: ${title}`); }
}
function updateCount() {
  const n = state.watchlist.length;
  $('wlCount').hidden = !n;
  $('wlCount').textContent = n;
}

// ---------- cards ----------
function datesLine(f) {
  const parts = [`<span class="nl">NL ${esc(short(f.nl))}</span>`];
  if (isRerelease(f)) parts.push(`<span class="badge">Re-release · ${f.year}</span>`);
  else if (f.us) parts.push(`<span>US ${esc(fmt(parseDay(f.us), { day: 'numeric', month: 'short' }))}</span>`);
  return `<div class="dates">${parts.join('')}</div>`;
}
function card(f, rank) {
  return `<article class="card">
    <button class="save" type="button" data-save="${f.fv}"></button>
    <button class="open" type="button" data-open="${f.fv}" aria-label="${esc(f.title)}: details">
      <div class="poster">${f.poster ? `<img src="${IMG}w500${f.poster}" alt="" loading="lazy">` : esc(f.title)}${rank ? `<span class="rank">${rank}</span>` : ''}</div>
      <h3>${esc(f.title)}</h3>
    </button>
    ${datesLine(f)}
  </article>`;
}
function hydrateButtons(root) { root.querySelectorAll('.save').forEach(updateSaveButton); }

// ---------- releases view ----------
function renderWeekbar() {
  $('weekNo').innerHTML = weekTitle(state.selected);
  const thisWeek = key(state.selected) === key(mondayOf(new Date()));
  $('range').innerHTML = esc(rangeLabel(state.selected)) + (thisWeek ? ' · this week' : '<button type="button" id="goToday">Today</button>');
  $('goToday')?.addEventListener('click', () => select(mondayOf(new Date())));
}

function renderReleases() {
  if (!state.films) { $('main').innerHTML = `<div class="grid">${'<div class="skel"></div>'.repeat(4)}</div>`; return; }
  const films = state.byWeek.get(key(state.selected)) || [];
  if (!films.length) {
    const past = key(state.selected) < key(mondayOf(new Date()));
    $('main').innerHTML = `<div class="empty"><p>${past ? 'No releases saved for this week.' : 'No Dutch cinema releases announced for this week yet.'}</p></div>`;
    return;
  }
  $('main').innerHTML = `<div class="grid">${films.slice(0, state.shown).map((f, i) => card(f, i + 1)).join('')}</div>`
    + (films.length > state.shown ? `<div style="display:grid;margin-top:24px"><button class="btn more" id="more" type="button">Show ${films.length - state.shown} more</button></div>` : '');
  hydrateButtons($('main'));
  $('more')?.addEventListener('click', () => { state.shown = Infinity; renderReleases(); });
}

// ---------- watchlist view ----------
function renderWatchlist() {
  if (!state.watchlist.length) {
    $('main').innerHTML = `<div class="empty"><p>Nothing here yet. Tap the <b>+</b> on any poster to save it, and it shows up here under the week it opens.</p><button class="btn primary" type="button" id="toReleases">Browse releases</button></div>`;
    $('toReleases').addEventListener('click', () => setView('releases'));
    return;
  }
  const thisMonday = key(mondayOf(new Date()));
  const groups = new Map(), past = [];
  state.watchlist.forEach(i => {
    const f = filmFor(i.fv);
    if (!f) return;
    const m = key(mondayOf(parseDay(f.nl)));
    if (m < thisMonday) return past.push(f);
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(f);
  });
  const section = (title, sub, films, now) => `<section class="wl-week">
    <h3>${title}${sub ? ` <span class="range">${esc(sub)}</span>` : ''}${now ? '<span class="now">This week</span>' : ''}</h3>
    <div class="grid">${films.map(f => card(f)).join('')}</div></section>`;
  const parts = [...groups.keys()].sort().map(m =>
    section(weekTitle(parseDay(m)), rangeLabel(parseDay(m)), groups.get(m).sort((a, b) => a.nl.localeCompare(b.nl)), m === thisMonday));
  if (past.length) parts.push(section('Already in cinemas', '', past.sort((a, b) => b.nl.localeCompare(a.nl))));
  const n = state.watchlist.length;
  $('main').innerHTML = `<div class="wl"><div class="wl-head"><h2>Watchlist</h2><p>${n} film${n === 1 ? '' : 's'} by the week they open in Dutch cinemas</p></div>${parts.join('')}</div>`;
  hydrateButtons($('main'));
}

// ---------- double screenings ----------
const LATE_ENTRY = 15; // minutes of trailers/ads after the listed start time
const MAX_GAP = 30;    // longest break between film 1 ending and film 2 starting
// "2026-10-16T11:30" as local time (avoids Safari's inconsistent parsing).
const toDate = s => { const [d, t] = s.split('T'); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(y, m - 1, dd, h, mi); };
const hhmm = s => s.slice(11, 16);
const screenName = s => { const n = s.screen.match(/^\d+/)?.[0]; return n ? `Screen ${n}` : s.screen; };

// Pathé screenings for each watchlist film: [{ film, screenings }]
function watchlistShowings() {
  const now = new Date();
  return state.watchlist.map(i => filmFor(i.fv)).filter(Boolean).map(film => {
    const shows = (currentCinema()?.films || []).filter(s => (film.tmdb && s.tmdb === film.tmdb) || s.fv === film.fv);
    const screenings = shows.flatMap(s => s.screenings)
      .filter(s => toDate(s.start) > now && !s.formats.some(f => dbl.exclude.includes(f)));
    return { film, screenings };
  });
}

function findDoubles(showings) {
  const pairs = [];
  for (const a of showings) for (const b of showings) {
    if (a.film.fv === b.film.fv) continue;
    for (const s1 of a.screenings) for (const s2 of b.screenings) {
      // Negative gap: film 2's listed start is before film 1 ends. That's fine up to LATE_ENTRY minutes,
      // because Pathé's listed start time is when the trailers and ads begin.
      const gap = (toDate(s2.start) - toDate(s1.end)) / 60000;
      if (gap >= -LATE_ENTRY && gap <= MAX_GAP) pairs.push({ first: a.film, s1, second: b.film, s2, gap });
    }
  }
  return pairs.sort((x, y) => x.s1.start.localeCompare(y.s1.start) || x.gap - y.gap);
}

function slot(film, s) {
  const meta = [screenName(s), ...s.formats, s.version].filter(Boolean).join(' · ');
  const thumb = film.poster ? `style="background-image:url('${IMG}w154${film.poster}')"` : '';
  return `<div class="slot">
    <button class="thumb" type="button" data-open="${film.fv}" aria-label="${esc(film.title)}: details" ${thumb}></button>
    <div><b>${esc(film.title)}</b><span class="time">${hhmm(s.start)} – ${hhmm(s.end)}</span><span class="meta">${esc(meta)}${s.soldOut ? ' · Sold out' : ''}</span></div>
    ${s.book && !s.soldOut ? `<a class="book" href="${esc(s.book)}" target="_blank" rel="noopener">Book</a>` : ''}
  </div>`;
}

// View options for the double screenings list. Day is per visit; cinema, time of day and sort are remembered.
const DBL_KEY = 'opening-weeks:doubles';
const dbl = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(DBL_KEY)) || {}; } catch {}
  return {
    day: null, film: '', // film that must be part of the pair ('' = any); per visit
    cinema: saved.cinema || 'pathe-de-kuip', sort: saved.sort || 'start',
    from: saved.from ?? '', until: saved.until ?? '', // earliest start / latest end, in minutes after midnight ('' = any)
    exclude: Array.isArray(saved.exclude) ? saved.exclude : [], // special formats (Dolby, IMAX, 4DX…) to leave out
  };
})();
// Dropdown choices: earliest start 09:00–22:00, latest end 15:00–02:00 (past midnight counts as the same evening).
const FROM_HOURS = Array.from({ length: 14 }, (_, i) => 9 + i);
const UNTIL_HOURS = Array.from({ length: 12 }, (_, i) => 15 + i);
const hourLabel = h => `${String(h % 24).padStart(2, '0')}:00`;
// Minutes after midnight of `day` (so 00:30 the next day is 1470).
const minutesFrom = (day, s) => (toDate(s) - toDate(`${day}T00:00`)) / 60000;
function inWindow(p) {
  const day = p.s1.start.slice(0, 10);
  return (dbl.from === '' || minutesFrom(day, p.s1.start) >= +dbl.from)
    && (dbl.until === '' || minutesFrom(day, p.s2.end) <= +dbl.until);
}
const SORTS = {
  start: { label: 'Start time', cmp: (a, b) => a.s1.start.localeCompare(b.s1.start) || a.gap - b.gap },
  wait: { label: 'Shortest wait', cmp: (a, b) => Math.abs(a.gap) - Math.abs(b.gap) || a.s1.start.localeCompare(b.s1.start) },
  end: { label: 'Ends earliest', cmp: (a, b) => a.s2.end.localeCompare(b.s2.end) || a.s1.start.localeCompare(b.s1.start) },
};

function cinemaList() {
  const st = state.showtimes;
  if (!st) return [];
  // Older data files held a single cinema.
  return st.cinemas || [{ ...(st.cinema || { slug: 'pathe-de-kuip', name: 'Pathé De Kuip' }), films: st.films || [] }];
}
function currentCinema() {
  const list = cinemaList();
  return list.find(c => c.slug === dbl.cinema) || list[0];
}

function renderDoubles() {
  const wrap = body => { $('main').innerHTML = `<div class="dbl"><div class="dbl-head"><h2>Double screenings</h2></div>${body}</div>`; };

  if (!state.showtimes) { wrap(state.showtimesError ? `<div class="empty"><p>Couldn't load the Pathé showtimes (${esc(state.showtimesError)}).</p></div>` : '<div class="skel" style="aspect-ratio:auto;height:160px"></div>'); return; }
  if (state.watchlist.length < 2) {
    wrap(`<div class="empty"><p>Add at least two films to your watchlist to find double screenings.</p><button class="btn primary" type="button" id="toReleases">Browse releases</button></div>`);
    $('toReleases').addEventListener('click', () => setView('releases'));
    return;
  }
  const cinema = currentCinema();
  const cinemaSelect = `<label>Cinema<select id="dblCinema">${cinemaList().map(c => `<option value="${c.slug}"${c.slug === cinema.slug ? ' selected' : ''}>${esc(c.name.replace(/^Pathé\s+/, ''))}</option>`).join('')}</select></label>`;
  const sortSelect = `<label>Sort<select id="dblSort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${k === dbl.sort ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>`;
  const timeSelect = (id, label, hours, value, anyLabel) => `<label>${label}<select id="${id}"><option value=""${value === '' ? ' selected' : ''}>${anyLabel}</option>${hours.map(h =>
    `<option value="${h * 60}"${String(h * 60) === String(value) ? ' selected' : ''}>${hourLabel(h)}</option>`).join('')}</select></label>`;
  const fromSelect = timeSelect('dblFrom', 'Start from', FROM_HOURS, dbl.from, 'Any time');
  const untilSelect = timeSelect('dblUntil', 'End by', UNTIL_HOURS, dbl.until, 'Any time');

  const showings = watchlistShowings();
  const playing = showings.filter(s => s.screenings.length).length;
  if (playing < 2) {
    wrap(`<div class="dbl-ctl"><div class="selects">${cinemaSelect}</div>${formatChips(cinema)}</div>
      <div class="empty"><p>${playing ? 'Only one film' : 'None of the films'} on your watchlist ${playing ? 'is' : 'are'} playing at ${esc(cinema.name)} right now, so there's nothing to combine yet.</p></div>`);
    return;
  }

  // Keep pairs inside the chosen start/end window, then group by day.
  const options = showings.filter(s => s.screenings.length).map(s => s.film).sort((a, b) => a.title.localeCompare(b.title));
  if (!options.some(f => String(f.fv) === dbl.film)) dbl.film = '';
  const filmSelect = `<label class="wide">Must include<select id="dblFilm"><option value="">Any film</option>${options.map(f =>
    `<option value="${f.fv}"${String(f.fv) === dbl.film ? ' selected' : ''}>${esc(f.title)}</option>`).join('')}</select></label>`;
  const pairs = findDoubles(showings).filter(inWindow)
    .filter(p => !dbl.film || String(p.first.fv) === dbl.film || String(p.second.fv) === dbl.film);
  const byDay = new Map();
  pairs.forEach(p => { const d = p.s1.start.slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(p); });
  if (!byDay.has(dbl.day)) dbl.day = byDay.keys().next().value || null;

  const controls = `<div class="dbl-ctl">
    <div class="selects">${cinemaSelect}${sortSelect}${fromSelect}${untilSelect}${filmSelect}</div>
    ${formatChips(cinema)}
    ${byDay.size ? `<div class="days-strip" role="group" aria-label="Day">${[...byDay].map(([d, list]) => `<button type="button" class="daychip" data-dbl="day:${d}" aria-pressed="${d === dbl.day}">
      <span>${esc(fmt(parseDay(d), { weekday: 'short' }))}</span><b>${parseDay(d).getDate()}</b><small>${esc(fmt(parseDay(d), { month: 'short' }))} · ${list.length}</small></button>`).join('')}</div>` : ''}
  </div>`;

  if (!dbl.day) {
    const limited = dbl.from !== '' || dbl.until !== '';
    wrap(`${controls}<div class="empty"><p>No double screenings at ${esc(cinema.name)}${limited ? ' within these times. Try a wider window.' : '.'}</p></div>`);
    return;
  }
  const list = byDay.get(dbl.day).sort(SORTS[dbl.sort].cmp);
  const day = `<section>
    <h3 class="day-h">${esc(fmt(parseDay(dbl.day), { weekday: 'long', day: 'numeric', month: 'long' }))}<span>${list.length} option${list.length === 1 ? '' : 's'}</span></h3>
    <div class="pairs">${list.map(p => `<article class="pair">
      ${slot(p.first, p.s1)}
      <div class="gapline${p.gap < 0 ? ' late' : ''}">${p.gap > 0 ? `${p.gap} min break` : p.gap === 0 ? 'Starts right after'
        : `Walk in ${-p.gap} min late, during the trailers`}</div>
      ${slot(p.second, p.s2)}
      <div class="total">${hhmm(p.s1.start)} – ${hhmm(p.s2.end)} at ${esc(cinema.name)}</div>
    </article>`).join('')}</div></section>`;
  wrap(controls + day);
  $('main').querySelector('.daychip[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// Toggle buttons for the special formats this cinema has. On = included.
function formatChips(cinema) {
  const formats = [...new Set(cinema.films.flatMap(f => f.screenings.flatMap(s => s.formats)))].sort();
  if (!formats.length) return '';
  return `<div class="formats" role="group" aria-label="Special screenings"><span>Include</span>${formats.map(f =>
    `<button type="button" class="fmt" data-dbl="fmt:${esc(f)}" aria-pressed="${!dbl.exclude.includes(f)}">${esc(f)}</button>`).join('')}</div>`;
}

function setDoubleOption(name, value) {
  if (name === 'fmt') dbl.exclude = dbl.exclude.includes(value) ? dbl.exclude.filter(f => f !== value) : [...dbl.exclude, value];
  else dbl[name] = value;
  if (name === 'cinema' || name === 'film') dbl.day = null;
  try { localStorage.setItem(DBL_KEY, JSON.stringify({ cinema: dbl.cinema, sort: dbl.sort, from: dbl.from, until: dbl.until, exclude: dbl.exclude })); } catch {}
  renderDoubles();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-dbl]');
  if (b) setDoubleOption(...b.dataset.dbl.split(':'));
});
document.addEventListener('change', e => {
  if (e.target.id === 'dblSort') setDoubleOption('sort', e.target.value);
  if (e.target.id === 'dblCinema') setDoubleOption('cinema', e.target.value);
  if (e.target.id === 'dblFrom') setDoubleOption('from', e.target.value);
  if (e.target.id === 'dblUntil') setDoubleOption('until', e.target.value);
  if (e.target.id === 'dblFilm') setDoubleOption('film', e.target.value);
});

function render() {
  $('tabReleases').setAttribute('aria-selected', state.view === 'releases');
  $('tabWatchlist').setAttribute('aria-selected', state.view === 'watchlist');
  $('tabDoubles').setAttribute('aria-selected', state.view === 'doubles');
  $('weekbar').hidden = state.view !== 'releases';
  if (state.view === 'releases') { renderWeekbar(); renderReleases(); }
  else if (state.view === 'watchlist') renderWatchlist();
  else renderDoubles();
}
function setView(v) {
  state.view = v;
  history.replaceState(null, '', v === 'releases' ? location.pathname : `#${v}`);
  render();
  window.scrollTo(0, 0);
}
function select(monday) { state.selected = monday; state.shown = PAGE; render(); window.scrollTo(0, 0); }

function setStatus() {
  if (!state.generatedAt) return;
  const mins = Math.round((Date.now() - new Date(state.generatedAt)) / 60000);
  const ago = mins < 60 ? `${Math.max(mins, 1)} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  $('status').textContent = `Release dates updated ${ago}`;
}

// ---------- detail ----------
const initials = name => name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
function person(p, role) {
  const face = p.profile ? `style="background-image:url('${IMG}w185${p.profile}')"` : '';
  return `<div class="person"><div class="face" ${face}>${p.profile ? '' : esc(initials(p.name))}</div><div><b>${esc(p.name)}</b>${role ? `<span>${esc(role)}</span>` : ''}</div></div>`;
}
function openDetail(fv) {
  const f = filmFor(fv);
  if (!f) return;
  const d = $('detail');
  const facts = [f.cert, f.runtime ? `${Math.floor(f.runtime / 60)}h ${f.runtime % 60}m` : '', ...(f.genres || [])].filter(Boolean);
  const second = isRerelease(f)
    ? `<div><div class="lbl">Original release</div><div class="val">${f.year}</div><div class="note">Back in Dutch cinemas</div></div>`
    : `<div><div class="lbl">US release</div><div class="val">${f.us ? esc(fmt(parseDay(f.us))) : 'Not announced'}</div><div class="note">${f.us ? 'In US cinemas' : 'No US date on TMDB'}</div></div>`;
  d.innerHTML = `
    <div class="hero" style="${f.backdrop ? `background-image:url('${IMG}w1280${f.backdrop}')` : ''}">
      <button class="close" type="button" aria-label="Close">${ICON.close}</button>
    </div>
    <div class="sheet">
      <div class="poster">${f.poster ? `<img src="${IMG}w342${f.poster}" alt="">` : ''}</div>
      <div>
        <h2 id="dTitle">${esc(f.title)}</h2>
        ${f.altTitle ? `<p class="alt">${esc(f.altTitle)}${f.year ? ` · ${f.year}` : ''}</p>` : f.year ? `<p class="alt">${f.year}</p>` : ''}
        ${f.tagline ? `<p class="tagline">${esc(f.tagline)}</p>` : ''}
        ${facts.length ? `<div class="facts">${facts.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
        <button class="btn primary add" type="button" data-save="${f.fv}"></button>
      </div>
      <div class="body">
        <div class="rel">
          <div class="nl"><div class="lbl">In Dutch cinemas</div><div class="val">${esc(fmt(parseDay(f.nl), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</div><div class="note">${esc(weekTitle(mondayOf(parseDay(f.nl))).replace(/<[^>]+>/g, ''))}</div></div>
          ${second}
        </div>
        <section><h4>Synopsis</h4><p>${esc(f.overview || 'No synopsis available yet.')}</p></section>
        <section><h4>Director${(f.directors || []).length === 1 ? '' : 's'}</h4>
          ${(f.directors || []).length ? `<div class="people">${f.directors.map(p => person(p, '')).join('')}</div>` : '<p class="alt">Not listed yet.</p>'}</section>
        ${(f.cast || []).length ? `<section><h4>Cast</h4><div class="people">${f.cast.map(p => person(p, p.character)).join('')}</div></section>` : ''}
        <div class="links">
          <a href="https://www.filmvandaag.nl/film/${f.fv}-${esc(f.fvSlug)}" target="_blank" rel="noopener">Filmvandaag ↗</a>
          ${f.tmdb ? `<a href="https://www.themoviedb.org/movie/${f.tmdb}" target="_blank" rel="noopener">TMDB ↗</a>` : ''}
        </div>
      </div>
    </div>`;
  updateSaveButton(d.querySelector('.add'));
  d.querySelector('.close').addEventListener('click', () => d.close());
  if (!d.open) d.showModal();
  d.scrollTop = 0;
}

// ---------- events ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-save], [data-open]');
  if (!t) return;
  if (t.dataset.save) toggleSave(+t.dataset.save);
  else openDetail(+t.dataset.open);
});
$('detail').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('tabReleases').addEventListener('click', () => setView('releases'));
$('tabWatchlist').addEventListener('click', () => setView('watchlist'));
$('tabDoubles').addEventListener('click', () => setView('doubles'));
window.addEventListener('hashchange', () => setView(viewFromHash()));
$('prev').addEventListener('click', () => select(addDays(state.selected, -7)));
$('next').addEventListener('click', () => select(addDays(state.selected, 7)));
document.addEventListener('keydown', e => {
  if (state.view !== 'releases' || $('detail').open) return;
  if (e.key === 'ArrowLeft') select(addDays(state.selected, -7));
  if (e.key === 'ArrowRight') select(addDays(state.selected, 7));
});
// Swipe left/right on the poster wall to change week.
let touch = null;
$('main').addEventListener('touchstart', e => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
$('main').addEventListener('touchend', e => {
  if (!touch || state.view !== 'releases') return;
  const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) select(addDays(state.selected, dx < 0 ? 7 : -7));
}, { passive: true });

// ---------- startup ----------
async function load() {
  const r = await fetch('data/releases.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  state.generatedAt = data.generatedAt;
  state.films = new Map(data.films.map(f => [f.fv, f]));
  state.byWeek = new Map();
  for (const f of data.films) {
    const k = key(mondayOf(parseDay(f.nl)));
    if (!state.byWeek.has(k)) state.byWeek.set(k, []);
    state.byWeek.get(k).push(f);
  }
  for (const list of state.byWeek.values()) list.sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1));
  // Refresh saved snapshots so the watchlist keeps working if a film later drops out of the data.
  state.watchlist.forEach(i => { const f = state.films.get(i.fv); if (f) i.film = f; });
  saveWatchlist();
}

updateCount();
render();
load().then(() => { render(); setStatus(); })
  .catch(err => {
    $('status').textContent = location.protocol === 'file:'
      ? 'This page was opened as a file, so it can’t load release dates. Run "node serve.js" and open http://localhost:4173 instead.'
      : `Couldn't load release dates (${err.message}). Showing your watchlist only.`;
    state.films = state.films || new Map();
    render();
  });
fetch('data/showtimes.json', { cache: 'no-store' })
  .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then(data => { state.showtimes = data; })
  .catch(err => { state.showtimesError = err.message; })
  .finally(() => { if (state.view === 'doubles') renderDoubles(); });
setInterval(setStatus, 60000);
if ('serviceWorker' in navigator) {
  // When an updated version takes over, reload once so the new app shows right away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
}
