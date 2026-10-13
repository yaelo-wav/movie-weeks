// Opening Weeks: Dutch cinema releases per week, with a watchlist stored on this device.
// Release data comes from data/releases.json, rebuilt every few hours by a GitHub Action.
const IMG = 'https://image.tmdb.org/t/p/';
const PAGE = 20;
const WL_KEY = 'opening-weeks:watchlist';

const ICON = {
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
};

const state = {
  view: viewFromHash(),
  account: null,      // your account ({ uid, name, group, lbUser }) when signed in
  members: [],        // others in your sharing group: [{ uid, name, watchlist: Set of fv }]
  wlFilter: 'all',    // watchlist filter with a group: all | together | solo
  lbData: null,       // last loaded data/letterboxd.json
  selected: mondayOf(new Date()),
  shown: PAGE,
  films: null,        // fv id -> film
  byWeek: new Map(),  // monday key -> films sorted by popularity
  generatedAt: null,
  watchlist: loadWatchlist(), // [{ fv, addedAt, film }]
  watched: loadWatched(),     // Set of fv ids marked as watched (shown with an eye icon)
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
  pushAccount();
}
function saveWatched() {
  try { localStorage.setItem(WATCHED_KEY, JSON.stringify([...state.watched])); } catch {}
  pushAccount();
}
function toggleSave(fv) {
  if (onList(fv)) {
    state.watchlist = state.watchlist.filter(i => i.fv !== fv);
    // Removed in the app while it's on your Letterboxd watchlist: don't add it back on the next sync.
    if (lbSync.imported.includes(fv)) { lbSync.imported = lbSync.imported.filter(x => x !== fv); lbSync.dismissed.push(fv); saveLbSync(); }
  }
  else state.watchlist.push({ fv, addedAt: new Date().toISOString(), film: filmFor(fv) });
  saveWatchlist();
  updateCount();
  if (state.view === 'watchlist') renderWatchlist();
  if (state.view === 'doubles') renderDoubles();
  document.querySelectorAll(`[data-save="${fv}"]`).forEach(updateSaveButton);
}
function updateSaveButton(b) {
  const fv = +b.dataset.save, saved = onList(fv), title = filmFor(fv)?.title || '';
  b.hidden = state.watched.has(fv); // no point saving a film you've already seen
  b.setAttribute('aria-pressed', saved);
  if (b.classList.contains('add')) b.innerHTML = `${saved ? ICON.check : ICON.add}<span>${saved ? 'On your watchlist' : 'Add to watchlist'}</span>`;
  else { b.innerHTML = saved ? ICON.check : ICON.add; b.setAttribute('aria-label', `${saved ? 'Remove from' : 'Add to'} watchlist: ${title}`); }
}
// ---------- watched (this device only) ----------
const WATCHED_KEY = 'opening-weeks:watched';
function loadWatched() {
  try { return new Set(JSON.parse(localStorage.getItem(WATCHED_KEY)) || []); } catch { return new Set(); }
}
// Marking a film as watched also takes it off the watchlist.
function toggleWatched(fv) {
  if (state.watched.has(fv)) {
    state.watched.delete(fv);
    // Un-marked in the app: don't let the Letterboxd diary mark it again.
    if (!lbSync.unwatched.includes(fv)) { lbSync.unwatched.push(fv); saveLbSync(); }
  }
  else {
    state.watched.add(fv);
    if (onList(fv)) { state.watchlist = state.watchlist.filter(i => i.fv !== fv); saveWatchlist(); updateCount(); }
  }
  saveWatched();
  render();
  const d = $('detail');
  if (d.open) { d.querySelectorAll('[data-save]').forEach(updateSaveButton); d.querySelectorAll('[data-watched]').forEach(updateWatchedButton); }
}
// ---------- Letterboxd sync ----------
// data/letterboxd.json (built by a GitHub Action) lists the TMDB ids on your Letterboxd watchlist and in your
// recent diary. Films from the watchlist are added here; logged films are marked watched. Your own changes in
// the app win: removing an imported film or un-marking a logged one sticks.
const LB_SYNC_KEY = 'opening-weeks:letterboxd-sync';
const lbSync = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LB_SYNC_KEY)) || {}; } catch {}
  return { imported: s.imported || [], dismissed: s.dismissed || [], unwatched: s.unwatched || [] };
})();
function saveLbSync() { try { localStorage.setItem(LB_SYNC_KEY, JSON.stringify(lbSync)); } catch {} pushAccount(); }

function applyLetterboxd(lb) {
  state.lbData = lb;
  // With an account, only sync when the account is linked to this Letterboxd profile.
  if (state.account && (state.account.lbUser || '').toLowerCase() !== lb.user) { state.letterboxd = null; return; }
  // Signed out: only on a device that already synced this profile before accounts existed (not on someone
  // else's phone that just installed the app).
  if (!state.account) {
    let device = null;
    try { device = localStorage.getItem('opening-weeks:letterboxd-device'); } catch {}
    if (!device && lbSync.imported.length) { device = lb.user; try { localStorage.setItem('opening-weeks:letterboxd-device', device); } catch {} }
    if (device !== lb.user) { state.letterboxd = null; return; }
  }
  const byTmdb = new Map([...state.films.values()].filter(f => f.tmdb).map(f => [f.tmdb, f]));
  const onLbList = new Set(lb.watchlist);
  for (const id of lb.watched) {
    const f = byTmdb.get(id);
    if (!f || state.watched.has(f.fv) || lbSync.unwatched.includes(f.fv)) continue;
    state.watched.add(f.fv);
    state.watchlist = state.watchlist.filter(i => i.fv !== f.fv);
  }
  for (const id of lb.watchlist) {
    const f = byTmdb.get(id);
    if (!f || state.watched.has(f.fv) || onList(f.fv) || lbSync.dismissed.includes(f.fv)) continue;
    state.watchlist.push({ fv: f.fv, addedAt: new Date().toISOString(), film: f });
    if (!lbSync.imported.includes(f.fv)) lbSync.imported.push(f.fv);
  }
  // Taken off the Letterboxd watchlist since it was imported: take it off here too.
  for (const fv of [...lbSync.imported]) {
    const f = filmFor(fv);
    if (f?.tmdb && onLbList.has(f.tmdb)) continue;
    state.watchlist = state.watchlist.filter(i => i.fv !== fv);
    lbSync.imported = lbSync.imported.filter(x => x !== fv);
  }
  saveLbSync();
  saveWatchlist();
  saveWatched();
  state.letterboxd = lb;
  updateCount();
}

// ---------- account & sharing ----------
// With an account (Firebase, see cloud.js) your watchlist, watched films and Letterboxd sync state live in the
// account and follow you across devices; this device keeps a copy for offline use. People in your sharing group
// can see each other's watchlists: a film on both is "together".
const MERGED_KEY = 'opening-weeks:account-merged'; // uid this device's own copy has been merged into
let pushTimer = null, unsubMe = null, unsubGroup = null, watchingGroup = null, lbAppliedFor = null;
const slim = f => f && ({ fv: f.fv, tmdb: f.tmdb || null, title: f.title, poster: f.poster || null, nl: f.nl, us: f.us || null, year: f.year || null, fvSlug: f.fvSlug || '', popularity: f.popularity ?? null });

function pushAccount() {
  if (!state.account || !window.cloud?.available) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    cloud.call('saveMe', {
      watchlist: state.watchlist.map(i => ({ fv: i.fv, addedAt: i.addedAt, film: slim(i.film || filmFor(i.fv)) })),
      watched: [...state.watched],
      lbSync: { imported: lbSync.imported, dismissed: lbSync.dismissed, unwatched: lbSync.unwatched },
    }).catch(e => console.warn('Saving to your account failed:', e.message));
  }, 400);
}

function applyAccountDoc(doc, uid) {
  if (pushTimer) return; // a newer change from this device is on its way
  doc = doc || {};
  const first = (() => { try { return localStorage.getItem(MERGED_KEY) !== uid; } catch { return true; } })();
  let wl = (doc.watchlist || []).map(i => ({ fv: i.fv, addedAt: i.addedAt, film: state.films?.get(i.fv) || i.film }));
  const watched = new Set(doc.watched || []);
  const lbs = { imported: [], dismissed: [], unwatched: [], ...(doc.lbSync || {}) };
  let lbUser = doc.lbUser || '';
  if (first) {
    // First sign-in on this device: keep what was already saved here.
    for (const i of state.watchlist) if (!wl.some(x => x.fv === i.fv)) wl.push(i);
    state.watched.forEach(fv => watched.add(fv));
    for (const k of ['imported', 'dismissed', 'unwatched']) lbs[k] = [...new Set([...lbs[k], ...lbSync[k]])];
    if (!lbUser && lbSync.imported.length && state.lbData) lbUser = state.lbData.user; // this device synced Letterboxd
    try { localStorage.setItem(MERGED_KEY, uid); } catch {}
  }
  state.account = { uid, name: doc.name || '', group: doc.group || null, lbUser };
  state.watched = watched;
  state.watchlist = wl.filter(i => !watched.has(i.fv));
  Object.assign(lbSync, lbs);
  try {
    localStorage.setItem(WL_KEY, JSON.stringify(state.watchlist));
    localStorage.setItem(WATCHED_KEY, JSON.stringify([...state.watched]));
    localStorage.setItem(LB_SYNC_KEY, JSON.stringify(lbSync));
  } catch {}
  if (first) { if (lbUser !== (doc.lbUser || '')) cloud.call('saveMe', { lbUser }).catch(() => {}); pushAccount(); }
  if (state.lbData && lbAppliedFor !== uid) { lbAppliedFor = uid; applyLetterboxd(state.lbData); }
  followGroup(state.account.group);
  updateCount();
  render();
  renderAccountSheet();
}

function followGroup(code) {
  if (code === watchingGroup) return;
  unsubGroup?.(); unsubGroup = null; watchingGroup = code; state.members = [];
  if (!code) return;
  unsubGroup = cloud.call('watchGroup', code, members => {
    state.members = members.map(m => ({ uid: m.uid, name: m.name || 'Friend', watchlist: new Set((m.watchlist || []).map(i => i.fv)) }));
    render();
    renderAccountSheet();
  });
}

// Names of the people in your group who have this film on their watchlist.
const fansOf = fv => (state.members || []).filter(m => m.watchlist.has(fv)).map(m => m.name);

function startAccounts() {
  if (!window.cloud) return;
  cloud.ready.then(ok => {
    if (!ok) return;
    $('acctBtn').hidden = false;
    cloud.onAuth(user => {
      unsubMe?.(); unsubMe = null; lbAppliedFor = null;
      followGroup(null);
      if (!user) {
        // Logged out: the films live in the account, so clear this device's copy (so the next person who logs
        // in here doesn't get them merged into their account).
        if (state.account) {
          state.watchlist = []; state.watched = new Set();
          Object.assign(lbSync, { imported: [], dismissed: [], unwatched: [] });
          try { [WL_KEY, WATCHED_KEY, LB_SYNC_KEY, MERGED_KEY, 'opening-weeks:letterboxd-device'].forEach(k => localStorage.removeItem(k)); } catch {}
          updateCount();
        }
        state.account = null;
        state.members = [];
        if (state.lbData) applyLetterboxd(state.lbData);
        updateAccountButton(); render(); renderAccountSheet();
        return;
      }
      unsubMe = cloud.call('watchMe', doc => { applyAccountDoc(doc, user.uid); updateAccountButton(); });
    });
  });
}
function updateAccountButton() {
  const b = $('acctBtn');
  const name = state.account?.name;
  b.innerHTML = name ? esc(name.trim()[0].toUpperCase()) : ICON.user;
  b.setAttribute('aria-label', state.account ? `Account: ${name || 'signed in'}` : 'Log in or create an account');
  b.classList.toggle('in', !!state.account);
}

function updateWatchedButton(b) {
  const seen = state.watched.has(+b.dataset.watched);
  b.setAttribute('aria-pressed', seen);
  b.innerHTML = `${ICON.eye}<span>${seen ? 'Watched' : 'Mark as watched'}</span>`;
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
  const last = lastChance(f);
  if (last) parts.push(`<span class="last">Last chance · until ${esc(short(last))}</span>`);
  const fans = fansOf(f.fv);
  if (fans.length) parts.push(`<span class="with">${onList(f.fv) ? `Together with ${esc(fans.join(' & '))}` : `${esc(fans.join(' & '))} want${fans.length > 1 ? '' : 's'} to see it`}</span>`);
  return `<div class="dates">${parts.join('')}</div>`;
}
const lbBadge = f => f.lb?.rating ? `<span class="lbscore" aria-label="Letterboxd ${f.lb.rating.toFixed(1)} out of 5"><i></i><i></i><i></i>${f.lb.rating.toFixed(1)}</span>` : '';
function card(f, rank) {
  const seen = state.watched.has(f.fv);
  return `<article class="card">
    <button class="save" type="button" data-save="${f.fv}"></button>
    <button class="open" type="button" data-open="${f.fv}" aria-label="${esc(f.title)}: details${seen ? ' (watched)' : ''}">
      <div class="poster">${f.poster ? `<img src="${IMG}w500${f.poster}" alt="" loading="lazy">` : esc(f.title)}${rank ? `<span class="rank">${rank}</span>` : ''}${seen ? `<span class="seen" title="Watched">${ICON.eye}</span>` : ''}${lbBadge(f)}</div>
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
  // With a sharing group: All / Together (also on someone else's list) / Just me.
  const shared = state.members?.length > 0;
  if (!shared) state.wlFilter = 'all';
  const keep = fv => state.wlFilter === 'together' ? fansOf(fv).length > 0 : state.wlFilter === 'solo' ? !fansOf(fv).length : true;
  const filterBar = shared ? `<div class="seg wlfilter" role="group" aria-label="Show">${[['all', 'All'], ['together', `Together`], ['solo', 'Just me']].map(([v, t]) =>
    `<button type="button" data-wlfilter="${v}" aria-pressed="${state.wlFilter === v}">${t}</button>`).join('')}</div>` : '';
  state.watchlist.forEach(i => {
    const f = filmFor(i.fv);
    if (!f || !keep(i.fv)) return;
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
  // Films you can already see go first: they're the ones to plan for now.
  if (past.length) parts.unshift(section('Already in cinemas', '', past.sort((a, b) => b.nl.localeCompare(a.nl))));
  const n = state.watchlist.length;
  const lbNote = state.letterboxd ? ` · synced with Letterboxd (${esc(state.letterboxd.user)})` : '';
  const empty = !parts.length ? `<div class="empty"><p>${state.wlFilter === 'together'
    ? `No films on both your list and ${esc(state.members.map(m => m.name).join(' & '))}'s yet.`
    : 'Every film on your list is also on someone else\'s.'}</p></div>` : '';
  $('main').innerHTML = `<div class="wl"><div class="wl-head"><h2>Watchlist</h2><p>${n} film${n === 1 ? '' : 's'} by the week they open in Dutch cinemas${lbNote}</p>${filterBar}</div>${parts.join('')}${empty}</div>`;
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
// All screenings of a film per cinema it plays at: [{ cinema, screenings }]
function filmRuns(f) {
  return cinemaList().map(cinema => ({
    cinema,
    screenings: cinema.films.filter(s => (f.tmdb && s.tmdb === f.tmdb) || s.fv === f.fv)
      .flatMap(s => s.screenings).sort((a, b) => a.start.localeCompare(b.start)),
  })).filter(r => r.screenings.length);
}

// Last-chance date, only when we're sure: at every cinema showing the film, its last screening falls before the
// last day of the fully published programme (so it's really not on later days that are already out), and it
// played at least 3 days that week (so a once-a-week repertory screening isn't flagged). Otherwise null.
function lastChance(f) {
  const runs = filmRuns(f);
  if (!runs.length) return null;
  let last = null;
  for (const { cinema, screenings } of runs) {
    const until = cinema.publishedUntil;
    const days = new Set(screenings.map(s => s.start.slice(0, 10)));
    const end = screenings[screenings.length - 1];
    if (!until || days.size < 3 || end.start.slice(0, 10) >= until) return null;
    if (!last || end.start > last) last = end.start;
  }
  return last && toDate(last) > new Date() ? last.slice(0, 10) : null;
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
// Showtimes block in the film sheet, for one cinema at a time.
function showtimesSection(f, slug) {
  const runs = filmRuns(f);
  if (!runs.length) return '';
  const run = runs.find(r => r.cinema.slug === slug) || runs.find(r => r.cinema.slug === dbl.cinema) || runs[0];
  const now = new Date();
  const upcoming = run.screenings.filter(s => toDate(s.start) > now);
  const byDay = new Map();
  upcoming.forEach(s => { const d = s.start.slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(s); });
  const tabs = runs.length > 1 ? `<div class="seg" role="group" aria-label="Cinema">${runs.map(r =>
    `<button type="button" data-showcinema="${r.cinema.slug}" aria-pressed="${r === run}">${esc(r.cinema.name.replace(/^Pathé\s+/, ''))}</button>`).join('')}</div>` : `<span class="where">${esc(run.cinema.name)}</span>`;
  const last = lastChance(f);
  const rows = [...byDay].map(([d, list]) => `<div class="tday"><b>${esc(fmt(parseDay(d), { weekday: 'short', day: 'numeric', month: 'short' }))}</b><div class="tlist">${list.map(s => {
    const extra = [...s.formats, s.version !== 'OV' ? s.version : ''].filter(Boolean).join(' · ');
    const inner = `${hhmm(s.start)}${extra ? `<small>${esc(extra)}</small>` : ''}`;
    return s.book && !s.soldOut ? `<a class="tchip" href="${esc(s.book)}" target="_blank" rel="noopener">${inner}</a>` : `<span class="tchip off">${inner}${s.soldOut ? '<small>Sold out</small>' : ''}</span>`;
  }).join('')}</div></div>`).join('');
  return `<section id="dShowtimes" data-fv="${f.fv}"><div class="sthead"><h4>Showtimes</h4>${tabs}</div>
    ${last ? `<p class="lastnote">Last chance: final screening on ${esc(fmt(parseDay(last), { weekday: 'long', day: 'numeric', month: 'long' }))}.</p>` : ''}
    ${rows || '<p class="alt">No more screenings this week.</p>'}</section>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-showcinema]');
  if (!b) return;
  const sec = $('dShowtimes');
  sec.outerHTML = showtimesSection(filmFor(+sec.dataset.fv), b.dataset.showcinema);
});

function openDetail(fv) {
  const f = filmFor(fv);
  if (!f) return;
  const d = $('detail');
  const facts = [f.cert, f.runtime ? `${Math.floor(f.runtime / 60)}h ${f.runtime % 60}m` : '', ...(f.genres || [])].filter(Boolean);
  const lbLink = f.lb?.slug ? `<a class="lblink" href="https://letterboxd.com/film/${esc(f.lb.slug)}/" target="_blank" rel="noopener"><i></i><i></i><i></i>${f.lb.rating ? `${f.lb.rating.toFixed(2)} <small>/ 5</small>` : 'Letterboxd'}</a>` : '';
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
        ${facts.length || lbLink ? `<div class="facts">${lbLink}${facts.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
        <div class="actions">
          <button class="btn primary add" type="button" data-save="${f.fv}"></button>
          <button class="btn watched" type="button" data-watched="${f.fv}"></button>
        </div>
      </div>
      <div class="body">
        <div class="rel">
          <div class="nl"><div class="lbl">In Dutch cinemas</div><div class="val">${esc(fmt(parseDay(f.nl), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</div><div class="note">${esc(weekTitle(mondayOf(parseDay(f.nl))).replace(/<[^>]+>/g, ''))}</div></div>
          ${second}
        </div>
        ${showtimesSection(f)}
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
  updateWatchedButton(d.querySelector('[data-watched]'));
  d.querySelector('.close').addEventListener('click', () => d.close());
  if (!d.open) d.showModal();
  d.scrollTop = 0;
}

// ---------- events ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-save], [data-open], [data-watched]');
  if (!t) return;
  if (t.dataset.save) toggleSave(+t.dataset.save);
  else if (t.dataset.watched) toggleWatched(+t.dataset.watched);
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

// ---------- account sheet ----------
let authMode = 'login';
const AUTH_ERRORS = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'Email or password is incorrect.',
  'auth/invalid-email': 'That doesn\'t look like an email address.',
  'auth/email-already-in-use': 'There\'s already an account with this email. Log in instead.',
  'auth/weak-password': 'Use a password of at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/network-request-failed': 'No connection. Check your internet and try again.',
  'group/not-found': 'No group with that code. Check the code and try again.',
  'group/full': 'That group is full.',
  'permission-denied': 'That isn\'t allowed. Check the code and try again.',
};
const authError = e => AUTH_ERRORS[e?.code] || 'Something went wrong. Try again.';

function renderAccountSheet() {
  const d = $('acct');
  if (!d.open) return;
  const a = state.account;
  let body;
  if (!a) {
    const signup = authMode === 'signup';
    body = `<h2 id="acctTitle">${signup ? 'Create account' : 'Log in'}</h2>
      <p class="muted">${signup ? 'Keep your watchlist in an account and share it with someone, like your sister.' : 'Log in to see your watchlist on any device.'}${state.watchlist.length ? ' The films saved on this phone are added to your account.' : ''}</p>
      <form id="authForm" class="form" novalidate>
        ${signup ? '<label class="field">Name<input id="fName" autocomplete="given-name" required></label>' : ''}
        <label class="field">Email<input id="fEmail" type="email" autocomplete="email" required></label>
        <label class="field">Password<input id="fPass" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>${signup ? '<small>At least 6 characters.</small>' : ''}</label>
        <p class="form-error" id="fError" role="alert"></p>
        <button class="btn primary" type="submit" id="fSubmit">${signup ? 'Create account' : 'Log in'}</button>
      </form>
      <p class="switch">${signup ? 'Already have an account? <button type="button" data-authmode="login">Log in</button>'
        : 'New here? <button type="button" data-authmode="signup">Create an account</button> · <button type="button" id="forgot">Forgot password?</button>'}</p>`;
  } else {
    const others = state.members.map(m => esc(m.name)).join(', ');
    body = `<h2 id="acctTitle">Hi ${esc(a.name || 'there')}</h2>
      <section class="acct-sec"><h4>Sharing</h4>
      ${a.group ? `<p>${others ? `Sharing watchlists with <b>${others}</b>.` : 'Nobody has joined yet.'} Invite someone with this code:</p>
          <div class="codebox"><code id="gCode">${esc(a.group)}</code><button class="btn" type="button" id="copyCode">Copy</button></div>
          <p class="muted small">They create an account in this app, tap <b>Join with a code</b> and enter it.</p>
          <button class="btn" type="button" id="leaveGroup">Stop sharing</button>`
        : `<p>Share watchlists with someone to see which films you'll see together.</p>
          <button class="btn primary" type="button" id="newGroup">Create an invite code</button>
          <form id="joinForm" class="joinrow" novalidate><input id="joinCode" placeholder="Join with a code" autocapitalize="characters" autocomplete="off" maxlength="12"><button class="btn" type="submit">Join</button></form>`}
        <p class="form-error" id="gError" role="alert"></p></section>
      <section class="acct-sec"><h4>Letterboxd</h4>
        <form id="lbForm" class="joinrow" novalidate><input id="lbUser" placeholder="Letterboxd username" value="${esc(a.lbUser)}" autocapitalize="none" autocomplete="off"><button class="btn" type="submit">Save</button></form>
        <p class="muted small">Your Letterboxd watchlist and logged films sync daily. Only the profile set up in the app's settings (${esc(state.lbData?.user || 'yaelooo')}) is synced.</p></section>
      <button class="btn" type="button" id="signOut">Log out</button>`;
  }
  d.querySelector('.acct-body').innerHTML = body;
  d.querySelector('#fName, #fEmail')?.focus();
}
function openAccount() {
  const d = $('acct');
  if (!d.open) d.showModal();
  renderAccountSheet();
}
$('acctBtn').addEventListener('click', openAccount);
$('acct').addEventListener('click', async e => {
  const d = $('acct');
  if (e.target === d || e.target.closest('.close')) return d.close();
  const t = e.target;
  if (t.dataset.authmode) { authMode = t.dataset.authmode; renderAccountSheet(); }
  else if (t.id === 'forgot') {
    const email = $('fEmail').value.trim();
    if (!email) { $('fError').textContent = 'Enter your email first, then tap "Forgot password?" again.'; return; }
    try { await cloud.call('resetPassword', email); $('fError').textContent = `If there's an account for ${email}, a reset link is on its way.`; }
    catch (err) { $('fError').textContent = authError(err); }
  }
  else if (t.id === 'signOut') { await cloud.call('signOut'); d.close(); }
  else if (t.id === 'newGroup') { try { await cloud.call('createGroup'); } catch (err) { $('gError').textContent = authError(err); } }
  else if (t.id === 'leaveGroup') { try { await cloud.call('leaveGroup', state.account.group); } catch (err) { $('gError').textContent = authError(err); } }
  else if (t.id === 'copyCode') {
    try { await navigator.clipboard.writeText(state.account.group); t.textContent = 'Copied'; }
    catch { getSelection().selectAllChildren($('gCode')); }
  }
});
$('acct').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'authForm') {
    const btn = $('fSubmit');
    btn.disabled = true; $('fError').textContent = '';
    try {
      if (authMode === 'signup') {
        const name = $('fName').value.trim();
        if (!name) throw { code: 'name' };
        await cloud.call('signUp', name, $('fEmail').value.trim(), $('fPass').value);
      } else await cloud.call('signIn', $('fEmail').value.trim(), $('fPass').value);
    } catch (err) { $('fError').textContent = err.code === 'name' ? 'Enter your name.' : authError(err); btn.disabled = false; }
  } else if (f.id === 'joinForm') {
    const code = $('joinCode').value.trim().toUpperCase();
    if (!code) return;
    try { await cloud.call('joinGroup', code); } catch (err) { $('gError').textContent = authError(err); }
  } else if (f.id === 'lbForm') {
    const lbUser = $('lbUser').value.trim().toLowerCase();
    await cloud.call('saveMe', { lbUser }).catch(() => {});
    state.account.lbUser = lbUser; lbAppliedFor = null;
    if (state.lbData) { lbAppliedFor = state.account.uid; applyLetterboxd(state.lbData); render(); }
  }
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-wlfilter]');
  if (!b) return;
  state.wlFilter = b.dataset.wlfilter;
  renderWatchlist();
});

updateCount();
render();
startAccounts();
load()
  .then(() => fetch('data/letterboxd.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(lb => {
    if (!lb) return;
    if (state.account) lbAppliedFor = state.account.uid;
    applyLetterboxd(lb);
  }).catch(() => {}))
  .then(() => { render(); setStatus(); })
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
