// Accounts and shared watchlists for Opening Weeks, on Firebase (Auth + Firestore). Exposes window.cloud.
// Without a config in firebase-config.js the app runs device-only and cloud.available stays false.
// On localhost, add ?mockcloud to the URL to use an in-browser stand-in (for testing the UI without Firebase).
(function () {
  const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const listeners = { auth: [] };
  let lastAuth; // last signed-in state, replayed to late listeners
  const emit = u => { lastAuth = u; listeners.auth.forEach(cb => cb(u)); };
  let impl = null;

  const loadScript = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(s);
  });
  const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

  // ---------- Firebase ----------
  async function firebaseImpl(config) {
    for (const f of ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js']) await loadScript(FIREBASE + f);
    const app = firebase.initializeApp(config);
    const auth = app.auth();
    const db = app.firestore();
    try { await db.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* another tab or unsupported: online only */ }
    const users = db.collection('users'), groups = db.collection('groups');

    auth.onAuthStateChanged(u => emit(u ? { uid: u.uid, email: u.email } : null));
    return {
      currentUid: () => auth.currentUser?.uid || null,
      async signUp(name, email, password) {
        const { user } = await auth.createUserWithEmailAndPassword(email, password);
        await users.doc(user.uid).set({ name, createdAt: new Date().toISOString() }, { merge: true });
      },
      signIn: (email, password) => auth.signInWithEmailAndPassword(email, password),
      signOut: () => auth.signOut(),
      resetPassword: email => auth.sendPasswordResetEmail(email),
      watchMe(cb) { return users.doc(auth.currentUser.uid).onSnapshot(d => cb(d.exists ? d.data() : null), () => cb(null)); },
      saveMe: patch => users.doc(auth.currentUser.uid).set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true }),
      async createGroup() {
        const code = randomCode();
        await groups.doc(code).set({ members: [auth.currentUser.uid] });
        await users.doc(auth.currentUser.uid).set({ group: code }, { merge: true });
        return code;
      },
      async joinGroup(code) {
        const ref = groups.doc(code);
        const snap = await ref.get();
        if (!snap.exists) throw Object.assign(new Error('No group with that code.'), { code: 'group/not-found' });
        if (!(snap.data().members || []).includes(auth.currentUser.uid)) {
          if ((snap.data().members || []).length >= 6) throw Object.assign(new Error('That group is full.'), { code: 'group/full' });
          await ref.update({ members: firebase.firestore.FieldValue.arrayUnion(auth.currentUser.uid) });
        }
        await users.doc(auth.currentUser.uid).set({ group: code }, { merge: true });
      },
      async leaveGroup(code) {
        await groups.doc(code).update({ members: firebase.firestore.FieldValue.arrayRemove(auth.currentUser.uid) }).catch(() => {});
        await users.doc(auth.currentUser.uid).set({ group: null }, { merge: true });
      },
      // Calls cb with the other members' documents whenever any of them changes.
      watchGroup(code, cb) {
        const subs = new Map(), docs = new Map();
        const emit = () => cb([...docs.entries()].map(([uid, d]) => ({ uid, ...d })));
        const unsubGroup = groups.doc(code).onSnapshot(g => {
          const others = (g.data()?.members || []).filter(uid => uid !== auth.currentUser?.uid);
          for (const [uid, un] of subs) if (!others.includes(uid)) { un(); subs.delete(uid); docs.delete(uid); }
          for (const uid of others) if (!subs.has(uid)) {
            subs.set(uid, users.doc(uid).onSnapshot(d => { if (d.exists) docs.set(uid, d.data()); else docs.delete(uid); emit(); }, () => { docs.delete(uid); emit(); }));
          }
          emit();
        }, () => cb([]));
        return () => { unsubGroup(); subs.forEach(un => un()); };
      },
    };
  }

  // ---------- local stand-in for testing ----------
  function mockImpl() {
    const KEY = 'mockcloud';
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { users: {}, groups: {}, session: null }; } catch { return { users: {}, groups: {}, session: null }; } };
    const store = load();
    const watchers = new Set();
    const save = () => { localStorage.setItem(KEY, JSON.stringify(store)); watchers.forEach(w => w()); };
    const fail = (code, msg) => Object.assign(new Error(msg), { code });
    const me = () => store.session;
    const emitAuth = () => setTimeout(() => emit(me() ? { uid: me(), email: store.users[me()].email } : null), 0);
    emitAuth();
    const watch = fn => { watchers.add(fn); setTimeout(fn, 0); return () => watchers.delete(fn); };
    return {
      currentUid: me,
      async signUp(name, email, password) {
        if (Object.values(store.users).some(u => u.email === email)) throw fail('auth/email-already-in-use', 'in use');
        if (password.length < 6) throw fail('auth/weak-password', 'weak');
        const uid = 'u' + Math.random().toString(36).slice(2, 10);
        store.users[uid] = { email, password, doc: { name } };
        store.session = uid; save(); emitAuth();
      },
      async signIn(email, password) {
        const uid = Object.keys(store.users).find(k => store.users[k].email === email);
        if (!uid || store.users[uid].password !== password) throw fail('auth/invalid-credential', 'bad');
        store.session = uid; save(); emitAuth();
      },
      async signOut() { store.session = null; save(); emitAuth(); },
      async resetPassword() {},
      watchMe(cb) { const uid = me(); return watch(() => cb(store.users[uid]?.doc || null)); },
      async saveMe(patch) { Object.assign(store.users[me()].doc, patch); save(); },
      async createGroup() { const code = randomCode(); store.groups[code] = { members: [me()] }; store.users[me()].doc.group = code; save(); return code; },
      async joinGroup(code) {
        const g = store.groups[code];
        if (!g) throw fail('group/not-found', 'not found');
        if (!g.members.includes(me())) g.members.push(me());
        store.users[me()].doc.group = code; save();
      },
      async leaveGroup(code) { const g = store.groups[code]; if (g) g.members = g.members.filter(u => u !== me()); store.users[me()].doc.group = null; save(); },
      watchGroup(code, cb) {
        const uid = me();
        return watch(() => cb((store.groups[code]?.members || []).filter(u => u !== uid).map(u => ({ uid: u, ...store.users[u].doc }))));
      },
    };
  }

  const cloud = window.cloud = {
    available: false,
    ready: null,
    onAuth(cb) { listeners.auth.push(cb); if (lastAuth !== undefined) cb(lastAuth); },
    call(name, ...args) { return impl[name](...args); },
  };
  cloud.ready = (async () => {
    const mock = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]mockcloud/.test(location.search);
    try {
      if (mock) impl = mockImpl();
      else if (window.FIREBASE_CONFIG) impl = await firebaseImpl(window.FIREBASE_CONFIG);
    } catch (e) { console.warn('Accounts unavailable:', e.message); impl = null; }
    cloud.available = !!impl;
    return cloud.available;
  })();
})();
