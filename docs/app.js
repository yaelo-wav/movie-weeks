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
  members: [],        // your friends: [{ uid, name, username, watchlist: Set of fv }]
  requests: { incoming: [], outgoing: [] }, // friend requests
  requestsLoaded: false,
  authKnown: false,   // true once we know whether someone is logged in
  wlFilter: 'all',    // watchlist filter with friends: all | solo | a friend's uid
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
const onList = fv => hasList() && state.watchlist.some(i => i.fv === fv);
const isWatched = fv => hasList() && state.watched.has(fv);
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
  if (!state.account) return openAccount('Create an account (or log in) to keep a watchlist.');
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
  b.hidden = isWatched(fv); // no point saving a film you've already seen
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
  if (!state.account) return openAccount('Create an account (or log in) to mark films as watched.');
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
  // Only for a signed-in account that's linked to this Letterboxd profile.
  if (!state.account || (state.account.lbUser || '').toLowerCase() !== lb.user) { state.letterboxd = null; return; }
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

// ---------- account & friends ----------
// With an account (Firebase, see cloud.js) your watchlist, watched films and Letterboxd sync state live in the
// account and follow you across devices; this device keeps a copy for offline use. Friends (found by username,
// added once they accept your request) can see each other's watchlists; a film on yours and a friend's is
// "together" with that friend.
const MERGED_KEY = 'opening-weeks:account-merged'; // uid this device's own copy has been merged into
let pushTimer = null, unsubMe = null, unsubFriends = null, unsubRequests = null, friendKey = '', lbAppliedFor = null, groupMigrated = false;
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
  state.account = { uid, name: doc.name || '', username: doc.username || '', lbUser, friends: doc.friends || [] };
  state.watched = watched;
  state.watchlist = wl.filter(i => !watched.has(i.fv));
  Object.assign(lbSync, lbs);
  try {
    localStorage.setItem(WL_KEY, JSON.stringify(state.watchlist));
    localStorage.setItem(WATCHED_KEY, JSON.stringify([...state.watched]));
    localStorage.setItem(LB_SYNC_KEY, JSON.stringify(lbSync));
  } catch {}
  if (first) { if (lbUser !== (doc.lbUser || '')) cloud.call('saveMe', { lbUser }).catch(() => {}); pushAccount(); }
  // Sync Letterboxd once per account + linked profile (again when the profile changes).
  const lbKey = `${uid}:${lbUser}`;
  if (state.lbData && lbAppliedFor !== lbKey) { lbAppliedFor = lbKey; applyLetterboxd(state.lbData); }
  if (doc.group && !groupMigrated) { groupMigrated = true; migrateGroup(doc.group); }
  followFriends(state.account.friends);
  updateCount();
  updateAccountButton();
  render();
  renderAccountSheet();
}

// Earlier versions shared through an invite-code group: its members become friends (both sides do this).
async function migrateGroup(code) {
  const ids = await cloud.call('groupMembers', code).catch(() => []);
  const friends = [...new Set([...state.account.friends, ...ids])];
  await cloud.call('saveMe', { friends, group: null }).catch(() => {});
}

function followFriends(uids, force = false) {
  const k = [...uids].sort().join(',');
  if (k === friendKey && !force) return;
  friendKey = k;
  unsubFriends?.(); unsubFriends = null;
  if (!uids.length) { state.members = []; return; }
  unsubFriends = cloud.call('watchFriends', uids, docs => {
    state.members = docs.map(m => ({ uid: m.uid, name: m.name || 'Friend', username: m.username || '', watchlist: new Set((m.watchlist || []).map(i => i.fv)) }));
    render();
    renderAccountSheet();
  }, gone => {
    // Can't read their list: they removed you, or they're still finishing your request on their side.
    if (!state.requestsLoaded) return;
    const busy = [...state.requests.incoming, ...state.requests.outgoing].some(r => r.from === gone || r.to === gone);
    if (!busy) cloud.call('removeFriend', gone).catch(() => {});
  });
}

// Names of your friends who have this film on their watchlist.
const fansOf = fv => (state.members || []).filter(m => m.watchlist.has(fv)).map(m => m.name);

function startAccounts() {
  const unknown = () => { state.authKnown = true; updateCount(); render(); };
  if (!window.cloud) return unknown();
  cloud.ready.then(ok => {
    if (!ok) return unknown();
    $('acctBtn').hidden = false;
    cloud.onAuth(user => {
      state.authKnown = true;
      unsubMe?.(); unsubRequests?.(); unsubFriends?.();
      unsubMe = unsubRequests = unsubFriends = null;
      friendKey = ''; lbAppliedFor = null; groupMigrated = false;
      state.members = []; state.requests = { incoming: [], outgoing: [] }; state.requestsLoaded = false; searchResults = []; confirmRemove = null;
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
        if (state.lbData) applyLetterboxd(state.lbData);
        updateAccountButton(); render(); renderAccountSheet();
        return;
      }
      unsubRequests = cloud.call('watchRequests', ({ incoming, outgoing }) => {
        state.requests = { incoming, outgoing };
        state.requestsLoaded = true;
        // Requests you sent that were accepted: add them to your friends and clear the request.
        outgoing.filter(r => r.status === 'accepted').forEach(r => cloud.call('finishRequest', r).catch(() => {}));
        if (state.account) followFriends(state.account.friends, true);
        updateAccountButton();
        renderAccountSheet();
      });
      unsubMe = cloud.call('watchMe', doc => applyAccountDoc(doc, user.uid));
    });
  });
}
function updateAccountButton() {
  const b = $('acctBtn');
  const name = state.account?.name;
  const waiting = (state.requests?.incoming || []).filter(r => r.status === 'pending').length;
  b.innerHTML = (name ? esc(name.trim()[0].toUpperCase()) : ICON.user) + (waiting ? '<i class="dot"></i>' : '');
  b.setAttribute('aria-label', state.account ? `Account: ${name || 'signed in'}${waiting ? `, ${waiting} friend request${waiting > 1 ? 's' : ''}` : ''}` : 'Log in or create an account');
  b.classList.toggle('in', !!state.account);
}

function updateWatchedButton(b) {
  const seen = isWatched(+b.dataset.watched);
  b.setAttribute('aria-pressed', seen);
  b.innerHTML = `${ICON.eye}<span>${seen ? 'Watched' : 'Mark as watched'}</span>`;
}

function updateCount() {
  const n = hasList() ? state.watchlist.length : 0;
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
  const seen = isWatched(f.fv);
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
// Watchlist, watched and double screenings need an account. While the login state is still loading, a device
// that was signed in before keeps showing its saved copy.
function hasList() {
  if (state.account) return true;
  if (state.authKnown) return false;
  try { return !!localStorage.getItem(MERGED_KEY); } catch { return false; }
}
function loginPrompt(what) {
  $('main').innerHTML = `<div class="empty"><p>Log in or create an account to ${what}.</p>
    <div class="factions"><button class="btn primary" type="button" data-login="signup">Create account</button><button class="btn" type="button" data-login="login">Log in</button></div></div>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-login]');
  if (!b) return;
  authMode = b.dataset.login;
  openAccount();
});

function renderWatchlist() {
  if (!hasList()) return loginPrompt('keep a watchlist and see which films you want to see with friends');
  if (!state.watchlist.length) {
    $('main').innerHTML = `<div class="empty"><p>Nothing here yet. Tap the <b>+</b> on any poster to save it, and it shows up here under the week it opens.</p><button class="btn primary" type="button" id="toReleases">Browse releases</button></div>`;
    $('toReleases').addEventListener('click', () => setView('releases'));
    return;
  }
  const thisMonday = key(mondayOf(new Date()));
  const groups = new Map(), past = [];
  // With friends: All / Just me (on nobody else's list) / with <friend> (also on that friend's list).
  const friends = state.members || [];
  if (state.wlFilter !== 'all' && state.wlFilter !== 'solo' && !friends.some(m => m.uid === state.wlFilter)) state.wlFilter = 'all';
  const keep = fv => state.wlFilter === 'all' ? true
    : state.wlFilter === 'solo' ? !fansOf(fv).length
    : friends.find(m => m.uid === state.wlFilter)?.watchlist.has(fv);
  const options = [['all', 'All'], ['solo', 'Just me'], ...friends.map(m => [m.uid, `With ${m.name}`])];
  const filterBar = friends.length ? `<div class="seg wlfilter" role="group" aria-label="Show">${options.map(([v, t]) =>
    `<button type="button" data-wlfilter="${esc(v)}" aria-pressed="${state.wlFilter === v}">${esc(t)}</button>`).join('')}</div>` : '';
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
  const friend = friends.find(m => m.uid === state.wlFilter);
  const empty = !parts.length ? `<div class="empty"><p>${friend
    ? `None of your films are on ${esc(friend.name)}'s watchlist yet.`
    : 'Every film on your list is also on a friend\'s list.'}</p></div>` : '';
  $('main').innerHTML = `<div class="wl"><div class="wl-head"><h2>Watchlist</h2>${filterBar}</div>${parts.join('')}${empty}</div>`;
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
  if (!hasList()) return loginPrompt('find double screenings of films on your watchlist');
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
let authMode = 'login', authNote = '', searchResults = [], searchTimer = null, confirmRemove = null;
const AUTH_ERRORS = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'Email or password is incorrect.',
  'auth/invalid-email': 'That doesn\'t look like an email address.',
  'auth/email-already-in-use': 'There\'s already an account with this email. Log in instead.',
  'auth/weak-password': 'Use a password of at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/network-request-failed': 'No connection. Check your internet and try again.',
  'username/invalid': 'Usernames are 3–20 characters: lowercase letters, numbers, dots and underscores.',
  'username/taken': 'That username is taken. Try another one.',
  'permission-denied': 'That isn\'t allowed right now. Try again later.',
};
const authError = e => AUTH_ERRORS[e?.code] || 'Something went wrong. Try again.';
const at = u => u ? `<span class="handle">@${esc(u)}</span>` : '';

function friendRows() {
  const a = state.account;
  const loaded = new Map(state.members.map(m => [m.uid, m]));
  const incoming = state.requests.incoming.filter(r => r.status === 'pending');
  const outgoing = state.requests.outgoing.filter(r => r.status === 'pending');
  const rows = [];
  for (const r of incoming) rows.push(`<li class="frow"><div><b>${esc(r.fromName || r.fromUsername)}</b>${at(r.fromUsername)}<span class="sub">wants to be friends</span></div>
    <div class="factions"><button class="btn primary" type="button" data-accept="${esc(r.id)}">Accept</button><button class="btn" type="button" data-decline="${esc(r.id)}">Decline</button></div></li>`);
  for (const uid of a.friends) {
    const m = loaded.get(uid);
    const sure = confirmRemove === uid;
    rows.push(`<li class="frow"><div><b>${esc(m?.name || 'Friend')}</b>${at(m?.username)}${m ? '' : '<span class="sub">connecting…</span>'}</div>
      <div class="factions"><button class="btn${sure ? ' danger' : ''}" type="button" data-unfriend="${esc(uid)}">${sure ? 'Remove?' : 'Remove'}</button></div></li>`);
  }
  for (const r of outgoing) rows.push(`<li class="frow"><div><b>${esc(r.toName || r.toUsername)}</b>${at(r.toUsername)}<span class="sub">request sent</span></div>
    <div class="factions"><button class="btn" type="button" data-cancel="${esc(r.id)}">Cancel</button></div></li>`);
  return rows.length ? `<ul class="flist">${rows.join('')}</ul>` : '<p class="muted small">No friends yet. Search for someone\'s username below.</p>';
}

function searchRows() {
  const a = state.account;
  if (!searchResults.length) return '';
  return `<ul class="flist">${searchResults.map(u => {
    const friend = a.friends.includes(u.uid);
    const sent = state.requests.outgoing.some(r => r.to === u.uid);
    const asked = state.requests.incoming.find(r => r.from === u.uid && r.status === 'pending');
    const action = friend ? '<span class="sub">Friends</span>'
      : sent ? '<span class="sub">Request sent</span>'
      : asked ? `<button class="btn primary" type="button" data-accept="${esc(asked.id)}">Accept</button>`
      : `<button class="btn primary" type="button" data-add="${esc(u.uid)}" data-name="${esc(u.name || '')}" data-username="${esc(u.username)}">Add</button>`;
    return `<li class="frow"><div><b>${esc(u.name || u.username)}</b>${at(u.username)}</div><div class="factions">${action}</div></li>`;
  }).join('')}</ul>`;
}

function renderAccountSheet() {
  const d = $('acct');
  if (!d.open) return;
  const a = state.account;
  // Keep the friend search field as it was across re-renders (friends' lists update live).
  const search = $('friendSearch'), q = search?.value || '', focused = document.activeElement === search;
  let body;
  if (!a) {
    const signup = authMode === 'signup';
    body = `<h2 id="acctTitle">${signup ? 'Create account' : 'Log in'}</h2>
      <p class="muted">${authNote || (signup ? 'With an account you keep a watchlist, and you can add friends to see which films you want to see together.' : 'Log in to see your watchlist and friends.')}</p>
      <form id="authForm" class="form" novalidate>
        <label class="field">Email<input id="fEmail" type="email" autocomplete="email" required></label>
        <label class="field">Password<input id="fPass" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>${signup ? '<small>At least 6 characters.</small>' : ''}</label>
        ${signup ? `<label class="field">Username<input id="fUser" autocapitalize="none" autocomplete="username" spellcheck="false" required><small>This is how friends find you. Lowercase letters, numbers, dots and underscores.</small></label>
        <label class="field">Letterboxd username <span class="opt">(optional)</span><input id="fLb" autocapitalize="none" autocomplete="off" spellcheck="false"><small>Syncs your Letterboxd watchlist and watched films.</small></label>` : ''}
        <p class="form-error" id="fError" role="alert"></p>
        <button class="btn primary" type="submit" id="fSubmit">${signup ? 'Create account' : 'Log in'}</button>
      </form>
      <p class="switch">${signup ? 'Already have an account? <button type="button" data-authmode="login">Log in</button>'
        : 'New here? <button type="button" data-authmode="signup">Create an account</button> · <button type="button" id="forgot">Forgot password?</button>'}</p>`;
  } else {
    body = `<h2 id="acctTitle">Hi ${esc(a.name || 'there')}</h2>
      ${a.username ? (a.username !== a.name ? `<p class="muted">${at(a.username)}</p>` : '') : `<form id="userForm" class="form" novalidate>
        <p>Pick a username so friends can find you.</p>
        <div class="joinrow"><input id="pickUser" placeholder="username" autocapitalize="none" spellcheck="false" autocomplete="off"><button class="btn primary" type="submit">Save</button></div>
        <p class="form-error" id="uError" role="alert"></p></form>`}
      <section class="acct-sec"><h4>Friends</h4>
        ${friendRows()}
        <div class="searchbox"><input id="friendSearch" type="search" placeholder="Add a friend by username" autocapitalize="none" spellcheck="false" autocomplete="off"></div>
        <div id="searchResults">${searchRows()}</div>
        <p class="form-error" id="gError" role="alert"></p></section>
      <section class="acct-sec"><h4>Letterboxd</h4>
        <form id="lbForm" class="joinrow" novalidate><input id="lbUser" placeholder="Letterboxd username" value="${esc(a.lbUser)}" autocapitalize="none" autocomplete="off"><button class="btn" type="submit">Save</button></form>
        <p class="muted small">Your Letterboxd watchlist and logged films sync daily. Only the profile set up in the app's settings (${esc(state.lbData?.user || 'yaelooo')}) is synced.</p></section>
      <button class="btn" type="button" id="signOut">Log out</button>`;
  }
  d.querySelector('.acct-body').innerHTML = body;
  const s = $('friendSearch');
  if (s) { s.value = q; if (focused) s.focus(); }
  else d.querySelector('#fEmail')?.focus();
}
function openAccount(note = '') {
  authNote = note;
  if (note) authMode = 'signup';
  const d = $('acct');
  if (!d.open) d.showModal();
  renderAccountSheet();
}
$('acctBtn').addEventListener('click', () => openAccount());
$('acct').addEventListener('close', () => { authNote = ''; searchResults = []; confirmRemove = null; });
$('acct').addEventListener('input', e => {
  if (e.target.id !== 'friendSearch') return;
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(async () => {
    searchResults = q.length < 2 ? [] : await cloud.call('searchUsers', q).catch(() => []);
    $('searchResults') && ($('searchResults').innerHTML = searchRows() || (q.length >= 2 ? '<p class="muted small">Nobody with that username.</p>' : ''));
  }, 250);
});
$('acct').addEventListener('click', async e => {
  const d = $('acct');
  if (e.target === d || e.target.closest('.close')) return d.close();
  const t = e.target.closest('button');
  if (!t) return;
  const err = el => x => { if ($(el)) $(el).textContent = authError(x); };
  const req = id => [...state.requests.incoming, ...state.requests.outgoing].find(r => r.id === id);
  if (t.dataset.authmode) { authMode = t.dataset.authmode; renderAccountSheet(); }
  else if (t.id === 'forgot') {
    const email = $('fEmail').value.trim();
    if (!email) { $('fError').textContent = 'Enter your email first, then tap "Forgot password?" again.'; return; }
    try { await cloud.call('resetPassword', email); $('fError').textContent = `If there's an account for ${email}, a reset link is on its way.`; }
    catch (x) { $('fError').textContent = authError(x); }
  }
  else if (t.id === 'signOut') { await cloud.call('signOut'); d.close(); }
  else if (t.dataset.add) {
    t.disabled = true;
    await cloud.call('sendRequest', { uid: t.dataset.add, name: t.dataset.name, username: t.dataset.username }, state.account).catch(err('gError'));
  }
  else if (t.dataset.accept) await cloud.call('acceptRequest', req(t.dataset.accept)).catch(err('gError'));
  else if (t.dataset.decline) await cloud.call('declineRequest', req(t.dataset.decline)).catch(err('gError'));
  else if (t.dataset.cancel) await cloud.call('declineRequest', req(t.dataset.cancel)).catch(err('gError'));
  else if (t.dataset.unfriend) {
    if (confirmRemove !== t.dataset.unfriend) { confirmRemove = t.dataset.unfriend; renderAccountSheet(); return; }
    confirmRemove = null;
    await cloud.call('removeFriend', t.dataset.unfriend).catch(err('gError'));
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
        // Your username doubles as the name friends see.
        const username = $('fUser').value.trim().toLowerCase().replace(/^@/, '');
        const lbUser = $('fLb').value.trim().toLowerCase().replace(/^@/, '');
        await cloud.call('signUp', username, username, $('fEmail').value.trim(), $('fPass').value);
        if (lbUser) await cloud.call('saveMe', { lbUser }).catch(() => {});
      } else await cloud.call('signIn', $('fEmail').value.trim(), $('fPass').value);
      authNote = '';
    } catch (x) { $('fError').textContent = authError(x); btn.disabled = false; }
  } else if (f.id === 'userForm') {
    try { await cloud.call('setUsername', $('pickUser').value.trim(), state.account.name); }
    catch (x) { $('uError').textContent = authError(x); }
  } else if (f.id === 'lbForm') {
    const lbUser = $('lbUser').value.trim().toLowerCase();
    await cloud.call('saveMe', { lbUser }).catch(() => {});
    state.account.lbUser = lbUser;
    if (state.lbData) { lbAppliedFor = `${state.account.uid}:${lbUser}`; applyLetterboxd(state.lbData); render(); }
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
    if (state.account) lbAppliedFor = `${state.account.uid}:${state.account.lbUser}`;
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
