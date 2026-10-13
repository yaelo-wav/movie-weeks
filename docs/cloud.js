// Accounts and friends for Opening Weeks, on Firebase (Auth + Firestore). Exposes window.cloud.
// Without a config in firebase-config.js the app runs device-only and cloud.available stays false.
// On localhost, add ?mockcloud to the URL to use an in-browser stand-in (for testing the UI without Firebase).
//
// Data (see firestore.rules):
//   users/{uid}          name, username, watchlist, watched, lbUser, friends: [uid]. Owner writes; friends read.
//   usernames/{username} { uid, name }: unique usernames, searchable by people who are signed in.
//   requests/{from_to}   friend request { from, to, fromName, fromUsername, toName, toUsername, status }.
(function () {
  const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const listeners = { auth: [] };
  let impl = null;
  let lastAuth; // last signed-in state, replayed to late listeners
  const emit = u => { lastAuth = u; listeners.auth.forEach(cb => cb(u)); };
  const fail = (code, msg) => Object.assign(new Error(msg || code), { code });
  const USERNAME = /^[a-z0-9_.]{3,20}$/;

  const loadScript = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(s);
  });

  // ---------- Firebase ----------
  async function firebaseImpl(config) {
    for (const f of ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js']) await loadScript(FIREBASE + f);
    const app = firebase.initializeApp(config);
    const auth = app.auth();
    const db = app.firestore();
    try { await db.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* another tab or unsupported: online only */ }
    const users = db.collection('users'), names = db.collection('usernames'), requests = db.collection('requests');
    const FV = firebase.firestore.FieldValue;
    const uid = () => auth.currentUser.uid;

    auth.onAuthStateChanged(u => emit(u ? { uid: u.uid, email: u.email } : null));
    const api = {
      async signUp(name, username, email, password) {
        username = username.toLowerCase();
        if (!USERNAME.test(username)) throw fail('username/invalid');
        if ((await names.doc(username).get().catch(() => null))?.exists) throw fail('username/taken');
        const { user } = await auth.createUserWithEmailAndPassword(email, password);
        await users.doc(user.uid).set({ name, createdAt: new Date().toISOString() }, { merge: true });
        await api.setUsername(username, name).catch(() => {}); // can be picked later if it got taken meanwhile
      },
      signIn: (email, password) => auth.signInWithEmailAndPassword(email, password),
      signOut: () => auth.signOut(),
      resetPassword: email => auth.sendPasswordResetEmail(email),
      watchMe(cb) { return users.doc(uid()).onSnapshot(d => cb(d.exists ? d.data() : null), () => cb(null)); },
      saveMe: patch => users.doc(uid()).set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true }),

      async setUsername(username, name) {
        username = username.toLowerCase();
        if (!USERNAME.test(username)) throw fail('username/invalid');
        const me = uid();
        await db.runTransaction(async t => {
          const ref = names.doc(username), snap = await t.get(ref);
          if (snap.exists && snap.data().uid !== me) throw fail('username/taken');
          const old = (await t.get(users.doc(me))).data()?.username;
          if (old && old !== username) t.delete(names.doc(old));
          t.set(ref, { uid: me, name });
          t.set(users.doc(me), { username }, { merge: true });
        });
      },
      async searchUsers(prefix) {
        prefix = prefix.toLowerCase().replace(/^@/, '');
        if (prefix.length < 2) return [];
        const id = firebase.firestore.FieldPath.documentId();
        const res = await names.where(id, '>=', prefix).where(id, '<=', prefix + '').limit(8).get();
        return res.docs.map(d => ({ username: d.id, ...d.data() })).filter(u => u.uid !== uid());
      },

      async sendRequest(to, me) {
        await requests.doc(`${uid()}_${to.uid}`).set({
          from: uid(), to: to.uid, fromName: me.name || '', fromUsername: me.username || '',
          toName: to.name || '', toUsername: to.username || '', status: 'pending', createdAt: new Date().toISOString(),
        });
      },
      // Accept: mark the request accepted and add them to your friends. Their app then adds you and removes the request.
      async acceptRequest(r) {
        await requests.doc(r.id).update({ status: 'accepted' });
        await users.doc(uid()).set({ friends: FV.arrayUnion(r.from) }, { merge: true });
      },
      declineRequest: r => requests.doc(r.id).delete(),
      async finishRequest(r) { // you sent it and they accepted
        await users.doc(uid()).set({ friends: FV.arrayUnion(r.to) }, { merge: true });
        await requests.doc(r.id).delete();
      },
      removeFriend: friendUid => users.doc(uid()).set({ friends: FV.arrayRemove(friendUid) }, { merge: true }),
      watchRequests(cb) {
        let incoming = [], outgoing = [];
        const send = () => cb({ incoming, outgoing });
        const map = s => s.docs.map(d => ({ id: d.id, ...d.data() }));
        const a = requests.where('to', '==', uid()).onSnapshot(s => { incoming = map(s); send(); }, () => {});
        const b = requests.where('from', '==', uid()).onSnapshot(s => { outgoing = map(s); send(); }, () => {});
        return () => { a(); b(); };
      },
      // Live documents of the given friends; a friend whose document you can't read (they removed you) is reported as gone.
      watchFriends(uids, cb, onGone) {
        const docs = new Map();
        const send = () => cb([...docs.entries()].map(([id, d]) => ({ uid: id, ...d })));
        const subs = uids.map(id => users.doc(id).onSnapshot(
          d => { if (d.exists) docs.set(id, d.data()); else docs.delete(id); send(); },
          err => { docs.delete(id); send(); if (err.code === 'permission-denied') onGone(id); }));
        send();
        return () => subs.forEach(un => un());
      },
      // Earlier versions shared through an invite-code group: turn its members into friends.
      async groupMembers(code) {
        const g = await db.collection('groups').doc(code).get().catch(() => null);
        return (g?.data()?.members || []).filter(m => m !== uid());
      },
    };
    return api;
  }

  // ---------- local stand-in for testing ----------
  function mockImpl() {
    const KEY = 'mockcloud';
    const blank = () => ({ users: {}, names: {}, requests: {}, session: null });
    let store; try { store = JSON.parse(localStorage.getItem(KEY)) || blank(); } catch { store = blank(); }
    for (const k of ['names', 'requests']) store[k] = store[k] || {};
    const watchers = new Set();
    const save = () => { localStorage.setItem(KEY, JSON.stringify(store)); watchers.forEach(w => w()); };
    const me = () => store.session;
    const doc = id => store.users[id]?.doc;
    const emitAuth = () => setTimeout(() => emit(me() ? { uid: me(), email: store.users[me()].email } : null), 0);
    emitAuth();
    const watch = fn => { watchers.add(fn); setTimeout(fn, 0); return () => watchers.delete(fn); };
    const api = {
      async signUp(name, username, email, password) {
        username = username.toLowerCase();
        if (!USERNAME.test(username)) throw fail('username/invalid');
        if (store.names[username]) throw fail('username/taken');
        if (Object.values(store.users).some(u => u.email === email)) throw fail('auth/email-already-in-use');
        if (password.length < 6) throw fail('auth/weak-password');
        const id = 'u' + Math.random().toString(36).slice(2, 10);
        store.users[id] = { email, password, doc: { name, username, friends: [] } };
        store.names[username] = { uid: id, name };
        store.session = id; save(); emitAuth();
      },
      async signIn(email, password) {
        const id = Object.keys(store.users).find(k => store.users[k].email === email);
        if (!id || store.users[id].password !== password) throw fail('auth/invalid-credential');
        store.session = id; save(); emitAuth();
      },
      async signOut() { store.session = null; save(); emitAuth(); },
      async resetPassword() {},
      watchMe(cb) { const id = me(); return watch(() => cb(doc(id) || null)); },
      async saveMe(patch) { Object.assign(doc(me()), patch); save(); },
      async setUsername(username, name) {
        username = username.toLowerCase();
        if (!USERNAME.test(username)) throw fail('username/invalid');
        if (store.names[username] && store.names[username].uid !== me()) throw fail('username/taken');
        const old = doc(me()).username; if (old) delete store.names[old];
        store.names[username] = { uid: me(), name }; doc(me()).username = username; save();
      },
      async searchUsers(prefix) {
        prefix = prefix.toLowerCase().replace(/^@/, '');
        if (prefix.length < 2) return [];
        return Object.entries(store.names).filter(([n, v]) => n.startsWith(prefix) && v.uid !== me()).map(([n, v]) => ({ username: n, ...v }));
      },
      async sendRequest(to, m) {
        store.requests[`${me()}_${to.uid}`] = { from: me(), to: to.uid, fromName: m.name, fromUsername: m.username, toName: to.name, toUsername: to.username, status: 'pending' };
        save();
      },
      async acceptRequest(r) { store.requests[r.id].status = 'accepted'; const d = doc(me()); d.friends = [...new Set([...(d.friends || []), r.from])]; save(); },
      async declineRequest(r) { delete store.requests[r.id]; save(); },
      async finishRequest(r) { const d = doc(me()); d.friends = [...new Set([...(d.friends || []), r.to])]; delete store.requests[r.id]; save(); },
      async removeFriend(id) { const d = doc(me()); d.friends = (d.friends || []).filter(x => x !== id); save(); },
      watchRequests(cb) {
        const id = me();
        return watch(() => {
          const all = Object.entries(store.requests).map(([rid, r]) => ({ id: rid, ...r }));
          cb({ incoming: all.filter(r => r.to === id), outgoing: all.filter(r => r.from === id) });
        });
      },
      watchFriends(uids, cb, onGone) {
        const id = me();
        return watch(() => {
          const ok = uids.filter(u => (doc(u)?.friends || []).includes(id));
          uids.filter(u => !ok.includes(u)).forEach(onGone);
          cb(ok.map(u => ({ uid: u, ...doc(u) })));
        });
      },
      async groupMembers() { return []; },
    };
    return api;
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
