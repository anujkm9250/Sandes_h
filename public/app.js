(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const el = {};
  [
    'auth', 'auth-form', 'auth-title', 'auth-tabs', 'tab-login', 'tab-signup', 'gsetup-note', 'username', 'password',
    'pw-toggle', 'pw-row', 'invite', 'invite-row', 'auth-error', 'auth-submit', 'forgot-link', 'forgot',
    'google-wrap', 'google-btn',
    'app', 'me-name', 'admin-btn', 'settings-btn', 'notif-bar', 'notif-enable', 'search', 'list',
    'empty', 'chat-pane', 'back', 'peer-name', 'peer-status', 'peer-avatar', 'rename-btn', 'clear-chat',
    'messages', 'emoji-panel', 'reply-bar', 'reply-text', 'reply-cancel', 'composer', 'emoji-btn', 'photo-btn',
    'photo', 'text', 'toast',
    'settings', 'settings-close', 'notif-status', 'notif-btn', 'pw-section', 'pw-form', 'cur-row', 'cur-pw',
    'new-pw', 'pw-msg', 'logout', 'admin', 'admin-close', 'admin-list',
  ].forEach((id) => { el[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id); });

  /* ---------- theme ---------- */
  const THEME_COLORS = { cyber: '#070b12', circuit: '#050e09', plasma: '#0e0a05', lab: '#edf1f5' };
  function applyTheme(t) {
    if (!THEME_COLORS[t]) t = 'cyber';
    document.documentElement.dataset.theme = t;
    localStorage.setItem('theme', t);
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', THEME_COLORS[t]);
    $$('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === t)));
  }
  $$('.swatch').forEach((b) => { b.onclick = () => applyTheme(b.dataset.theme); });
  applyTheme(localStorage.getItem('theme') || 'cyber');

  /* ---------- state ---------- */
  let token = localStorage.getItem('token');
  let me = localStorage.getItem('me');
  let isAdmin = localStorage.getItem('admin') === '1';
  let config = { googleClientId: null, vapidPublicKey: null };
  let socket = null;
  let peer = null;
  let mode = 'login';            // login | signup | gsetup
  let googleCredential = null;
  let searchResults = null;
  let searchTimer = null, typingStop = null, typingHide = null, peerTyping = false;
  let pendingChat = new URLSearchParams(location.search).get('chat');
  const convs = new Map();       // peer -> { peer, last, unread }
  const online = new Set();
  const lastSeen = new Map();
  const aliases = new Map();     // peer -> my private nickname
  const msgData = new Map();     // message id -> message
  let replyingTo = null;
  const notifPerm = () => ('Notification' in window ? Notification.permission : 'unsupported');

  /* ---------- helpers ---------- */
  const dn = (u) => aliases.get(u) || u;                       // display name (nickname or real username)
  const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function fmtShort(d) {
    const dt = new Date(d);
    return dt.toDateString() === new Date().toDateString()
      ? fmtTime(dt) : dt.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.toast.classList.remove('show'), 3200);
  }
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) { logout(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  function beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      beep.ctx = beep.ctx || new AC();
      const ctx = beep.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.26);
    } catch (e) { /* sound is optional */ }
  }

  /* ---------- auth ---------- */
  function setMode(m, extra = {}) {
    mode = m;
    const login = m === 'login', signup = m === 'signup', gsetup = m === 'gsetup';
    el.tabLogin.classList.toggle('active', login);
    el.tabSignup.classList.toggle('active', signup);
    el.tabLogin.setAttribute('aria-selected', String(login));
    el.tabSignup.setAttribute('aria-selected', String(signup));
    el.authTabs.hidden = gsetup;
    el.pwRow.hidden = gsetup;
    el.password.required = !gsetup;
    el.inviteRow.hidden = login;
    el.invite.required = !login;
    el.googleWrap.hidden = gsetup || !config.googleClientId;
    el.forgotLink.hidden = !login;
    el.forgot.hidden = true;
    el.gsetupNote.hidden = !gsetup;
    el.authTitle.textContent = gsetup ? 'FINISH SETUP' : 'ACCESS TERMINAL';
    el.password.autocomplete = signup ? 'new-password' : 'current-password';
    el.authSubmit.textContent = login ? 'Log in' : 'Create account';
    if (gsetup) {
      el.gsetupNote.textContent = 'Signed in as ' + (extra.email || 'your Google account') +
        '. Choose a username and enter the invite code to finish.';
      if (extra.suggested && !el.username.value) el.username.value = extra.suggested;
    }
    el.authError.textContent = '';
  }
  el.tabLogin.onclick = () => setMode('login');
  el.tabSignup.onclick = () => setMode('signup');
  el.forgotLink.onclick = () => { el.forgot.hidden = !el.forgot.hidden; };
  el.pwToggle.onclick = () => {
    const show = el.password.type === 'password';
    el.password.type = show ? 'text' : 'password';
    el.pwToggle.textContent = show ? 'HIDE' : 'SHOW';
  };

  function finishLogin(data) {
    token = data.token; me = data.username; isAdmin = !!data.isAdmin;
    localStorage.setItem('token', token);
    localStorage.setItem('me', me);
    localStorage.setItem('admin', isAdmin ? '1' : '0');
    el.password.value = ''; el.invite.value = '';
    start();
  }

  el.authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.authError.textContent = '';
    el.authSubmit.disabled = true;
    try {
      let data;
      if (mode === 'gsetup') {
        data = await api('/auth/google', { method: 'POST', body: {
          credential: googleCredential, username: el.username.value, invite: el.invite.value } });
      } else {
        const body = { username: el.username.value, password: el.password.value };
        if (mode === 'signup') body.invite = el.invite.value;
        data = await api('/auth/' + mode, { method: 'POST', body });
      }
      finishLogin(data);
    } catch (err) {
      el.authError.textContent = err.message;
    } finally {
      el.authSubmit.disabled = false;
    }
  });

  /* ---------- Google sign-in ---------- */
  async function onGoogleCredential(resp) {
    el.authError.textContent = '';
    try {
      googleCredential = resp.credential;
      const data = await api('/auth/google', { method: 'POST', body: { credential: googleCredential } });
      if (data.needsSetup) { el.username.value = ''; setMode('gsetup', data); return; }
      finishLogin(data);
    } catch (err) {
      el.authError.textContent = err.message;
    }
  }
  function initGoogle() {
    if (token || !config.googleClientId || initGoogle.done) return;
    initGoogle.done = true;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => {
      /* global google */
      google.accounts.id.initialize({ client_id: config.googleClientId, callback: onGoogleCredential });
      google.accounts.id.renderButton(el.googleBtn, {
        theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'continue_with', width: 300,
      });
      el.googleWrap.hidden = mode === 'gsetup';
    };
    document.head.appendChild(s);
  }

  async function logout() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub && token) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      }
    } catch (e) { /* best effort */ }
    ['token', 'me', 'admin'].forEach((k) => localStorage.removeItem(k));
    if (socket) socket.disconnect();
    location.reload();
  }
  el.logout.onclick = logout;

  /* ---------- start ---------- */
  async function start() {
    el.auth.hidden = true;
    el.app.hidden = false;
    el.meName.textContent = me;
    el.adminBtn.hidden = !isAdmin;
    try {
      const rows = await api('/aliases');
      aliases.clear();
      Object.entries(rows).forEach(([k, v]) => aliases.set(k, v));
    } catch (e) { /* non-fatal */ }
    connectSocket();
    updateNotifUi();
    if (notifPerm() === 'granted') subscribePush().catch(() => {});
  }

  function connectSocket() {
    socket = io({ auth: { token } });
    socket.on('connect_error', (err) => { if (err.message === 'unauthorized') logout(); });
    socket.on('disconnect', (reason) => { if (reason === 'io server disconnect') logout(); });
    socket.on('connect', async () => {
      socket.emit('visibility', { visible: document.visibilityState === 'visible' });
      await loadConversations();
      if (peer) loadMessages(peer);
      if (pendingChat) {
        openChat(pendingChat.toLowerCase());
        pendingChat = null;
        history.replaceState(null, '', '/');
      }
    });
    socket.on('presence:list', (list) => {
      online.clear(); list.forEach((u) => online.add(u));
      renderList(); updateHeader();
    });
    socket.on('presence', ({ username, online: on, lastSeen: ls }) => {
      if (on) online.add(username);
      else { online.delete(username); if (ls) lastSeen.set(username, ls); }
      renderList(); updateHeader();
    });
    socket.on('message:new', onNewMessage);
    socket.on('message:deleted', ({ id, from, to }) => {
      const old = msgData.get(id);
      if (old) replaceMsg({ ...old, text: '', kind: 'text', replyTo: null, deleted: true });
      const c = convs.get(from === me ? to : from);
      if (c && c.last && c.last.id === id) c.last = { ...c.last, text: '', kind: 'text', deleted: true };
      renderList();
    });
    socket.on('message:removed', ({ id }) => {
      msgData.delete(id);
      const node = el.messages.querySelector('[data-id="' + id + '"]');
      if (node) node.remove();
      loadConversations();
    });
    socket.on('chat:cleared', ({ peer: p }) => {
      convs.delete(p);
      if (peer === p) { el.messages.replaceChildren(); msgData.clear(); }
      renderList();
    });
    socket.on('user:deleted', ({ username }) => {
      convs.delete(username); aliases.delete(username);
      if (peer === username) { toast('This account was removed'); closeChat(); }
      renderList();
    });
    socket.on('message:status', ({ ids, status }) => ids.forEach((id) => setTick(id, status)));
    socket.on('typing', ({ from, typing }) => {
      if (from !== peer) return;
      peerTyping = typing;
      clearTimeout(typingHide);
      if (typing) typingHide = setTimeout(() => { peerTyping = false; updateHeader(); }, 4000);
      updateHeader();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (socket && socket.connected) socket.emit('visibility', { visible: document.visibilityState === 'visible' });
  });

  /* ---------- conversations list ---------- */
  async function loadConversations() {
    try {
      const list = await api('/conversations');
      convs.clear();
      list.forEach((c) => {
        convs.set(c.peer, { peer: c.peer, last: c.last, unread: peer === c.peer ? 0 : c.unread });
        if (c.lastSeen) lastSeen.set(c.peer, c.lastSeen);
      });
      renderList();
    } catch (e) { toast(e.message); }
  }

  function renderRow(name, last, unread) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    if (name === peer) btn.classList.add('active');
    btn.onclick = () => openChat(name);

    const av = document.createElement('div');
    av.className = 'avatar' + (online.has(name) ? ' on' : '');
    av.textContent = dn(name)[0];

    const main = document.createElement('div');
    main.className = 'row-main';
    const top = document.createElement('div');
    top.className = 'row-top';
    const nm = document.createElement('span');
    nm.className = 'row-name'; nm.textContent = dn(name);
    top.appendChild(nm);
    if (last) {
      const t = document.createElement('span');
      t.className = 'row-time'; t.textContent = fmtShort(last.createdAt);
      top.appendChild(t);
    }
    const bottom = document.createElement('div');
    bottom.className = 'row-bottom';
    const pv = document.createElement('span');
    pv.className = 'row-preview';
    const lastText = last ? (last.deleted ? 'This message was deleted'
      : last.kind === 'image' ? '\uD83D\uDCF7 Photo' + (last.text ? ' ' + last.text : '') : last.text) : '';
    pv.textContent = last ? (last.from === me ? 'You: ' : '') + lastText : '@' + name;
    bottom.appendChild(pv);
    if (unread > 0) {
      const b = document.createElement('span');
      b.className = 'badge'; b.textContent = unread > 99 ? '99+' : unread;
      bottom.appendChild(b);
    }
    main.append(top, bottom);
    btn.append(av, main);
    li.appendChild(btn);
    return li;
  }

  function updateTitle() {
    let n = 0;
    convs.forEach((c) => { n += c.unread || 0; });
    document.title = n ? '(' + n + ') Sandesh' : 'Sandesh';
  }

  function renderList() {
    updateTitle();
    el.list.replaceChildren();
    if (searchResults) {
      if (!searchResults.length) {
        const n = document.createElement('li');
        n.className = 'list-note'; n.textContent = 'No user found with that username.';
        el.list.appendChild(n);
      }
      searchResults.forEach((u) => el.list.appendChild(renderRow(u.username, null, 0)));
      return;
    }
    const items = [...convs.values()].sort((a, b) => new Date(b.last.createdAt) - new Date(a.last.createdAt));
    if (!items.length) {
      const n = document.createElement('li');
      n.className = 'list-note';
      n.textContent = 'No chats yet. Search a friend\u2019s exact username above to open a channel.';
      el.list.appendChild(n);
    }
    items.forEach((c) => el.list.appendChild(renderRow(c.peer, c.last, c.unread)));
  }

  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = el.search.value.trim();
    if (!q) { searchResults = null; renderList(); return; }
    searchTimer = setTimeout(async () => {
      try {
        // Search always uses the real username, never a nickname
        searchResults = await api('/users/search?q=' + encodeURIComponent(q));
        searchResults.forEach((u) => u.lastSeen && lastSeen.set(u.username, u.lastSeen));
        renderList();
      } catch (e) { toast(e.message); }
    }, 250);
  });

  /* ---------- chat header, nickname ---------- */
  function updateHeader() {
    if (!peer) return;
    el.peerName.textContent = dn(peer);
    el.peerAvatar.textContent = dn(peer)[0];
    el.peerAvatar.classList.toggle('on', online.has(peer));
    let s = 'offline';
    if (peerTyping) s = 'typing\u2026';
    else if (online.has(peer)) s = 'online';
    else if (lastSeen.get(peer)) s = 'last seen ' + fmtShort(lastSeen.get(peer)) + ', ' + fmtTime(lastSeen.get(peer));
    el.peerStatus.textContent = (aliases.has(peer) ? '@' + peer + ' \u00B7 ' : '') + s;
  }

  el.renameBtn.onclick = async () => {
    if (!peer) return;
    const input = prompt('Nickname for @' + peer + ' (only you can see it). Leave empty to reset:', aliases.get(peer) || '');
    if (input === null) return;
    try {
      const r = await api('/aliases/' + encodeURIComponent(peer), { method: 'PUT', body: { name: input } });
      if (r.name) aliases.set(peer, r.name); else aliases.delete(peer);
      updateHeader(); renderList(); refreshQuotes();
    } catch (e) { toast(e.message); }
  };

  /* ---------- messages ---------- */
  const tickText = (status) => (status === 'sent' ? '\u2713' : '\u2713\u2713');
  const quoteText = (r) => (r.kind === 'image' ? '\uD83D\uDCF7 Photo' + (r.text ? ' ' + r.text : '') : r.text);
  const quoteWho = (r) => (r.from === me ? 'You' : dn(r.from));

  function buildMsg(m) {
    msgData.set(m.id, m);
    const mine = m.from === me;
    const d = document.createElement('div');
    d.className = 'msg' + (mine ? ' mine' : '') + (m.deleted ? ' deleted' : '');
    d.dataset.id = m.id;
    if (m.deleted) {
      d.append(document.createTextNode('\uD83D\uDEAB This message was deleted'));
    } else {
      if (m.replyTo && m.replyTo.id) {
        const q = document.createElement('div');
        q.className = 'quote';
        const who = document.createElement('b');
        who.className = 'q-who'; who.dataset.from = m.replyTo.from;
        who.textContent = quoteWho(m.replyTo);
        const what = document.createElement('span');
        what.textContent = quoteText(m.replyTo);
        q.append(who, what);
        q.onclick = () => jumpTo(m.replyTo.id);
        d.appendChild(q);
      }
      if (m.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'photo'; img.alt = 'Photo';
        img.addEventListener('click', () => { if (img.src) window.open(img.src, '_blank'); });
        d.appendChild(img);
        if (m.localSrc) img.src = m.localSrc; else loadPhoto(img, m.id);
        if (m.text) { const c = document.createElement('div'); c.textContent = m.text; d.appendChild(c); }
      } else {
        d.append(document.createTextNode(m.text));
      }
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.append(document.createTextNode(fmtTime(m.createdAt)));
    if (mine && !m.deleted) {
      const t = document.createElement('span');
      t.className = 'tick ' + m.status;
      t.textContent = ' ' + tickText(m.status);
      meta.appendChild(t);
    }
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'more'; more.textContent = '\u22EF';
    more.setAttribute('aria-label', 'Message options');
    more.onclick = () => toggleActions(d, m.id);
    meta.appendChild(more);
    d.appendChild(meta);
    return d;
  }

  function refreshQuotes() {
    $$('.q-who').forEach((n) => { n.textContent = n.dataset.from === me ? 'You' : dn(n.dataset.from); });
  }

  function appendMsg(m) {
    if (el.messages.querySelector('[data-id="' + m.id + '"]')) return;
    el.messages.appendChild(buildMsg(m));
    el.messages.scrollTop = el.messages.scrollHeight;
  }
  function replaceMsg(m) {
    const old = el.messages.querySelector('[data-id="' + m.id + '"]');
    if (old) old.replaceWith(buildMsg(m)); else msgData.set(m.id, m);
  }

  async function loadPhoto(img, id) {
    try {
      const res = await fetch('/api/images/' + id, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error('load failed');
      img.src = URL.createObjectURL(await res.blob());
    } catch (e) { img.alt = 'Photo could not be loaded'; }
  }

  function setTick(id, status) {
    const md = msgData.get(id);
    if (md) md.status = status;
    const t = el.messages.querySelector('[data-id="' + id + '"] .tick');
    if (!t) return;
    t.className = 'tick ' + status;
    t.textContent = ' ' + tickText(status);
  }

  function toggleActions(node, id) {
    const open = node.querySelector('.actions');
    if (open) { open.remove(); return; }
    const m = msgData.get(id);
    if (!m) return;
    const row = document.createElement('div');
    row.className = 'actions';
    const add = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.onclick = () => { row.remove(); fn(); };
      row.appendChild(b);
    };
    if (!m.deleted) add('Reply', () => startReply(m));
    if (!m.deleted && m.kind === 'text' && m.text) add('Copy', () => copyText(m.text));
    add('Delete for me', () => deleteMsg(id, 'me'));
    if (!m.deleted && m.from === me) add('Delete for everyone', () => deleteMsg(id, 'all'));
    node.appendChild(row);
  }
  function copyText(text) {
    if (!navigator.clipboard) { toast('Copy is not available here'); return; }
    navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy'));
  }
  function deleteMsg(id, scope) {
    if (!socket || !socket.connected) { toast('Connecting\u2026 try again in a moment'); return; }
    socket.emit('message:delete', { id, scope }, (res) => { if (res && res.error) toast(res.error); });
  }
  function jumpTo(id) {
    const node = el.messages.querySelector('[data-id="' + id + '"]');
    if (!node) { toast('Original message is not loaded'); return; }
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1200);
  }
  function startReply(m) {
    replyingTo = m;
    el.replyText.textContent = (m.from === me ? 'You' : dn(m.from)) + ': ' + quoteText(m);
    el.replyBar.hidden = false;
    el.text.focus();
  }
  function cancelReply() { replyingTo = null; el.replyBar.hidden = true; }
  el.replyCancel.onclick = cancelReply;

  el.clearChat.onclick = () => {
    if (!peer) return;
    if (!confirm('Delete this whole chat from your side? ' + dn(peer) + ' will still keep their copy.')) return;
    socket.emit('chat:clear', { peer }, (res) => { if (res && res.error) toast(res.error); });
  };

  async function loadMessages(p) {
    try {
      const msgs = await api('/messages/' + encodeURIComponent(p));
      if (p !== peer) return;
      el.messages.replaceChildren();
      msgData.clear();
      msgs.forEach(appendMsg);
      if (msgs.some((m) => m.from === p && m.status !== 'read')) socket.emit('messages:read', { peer: p });
    } catch (e) { toast(e.message); }
  }

  function openChat(p) {
    peer = p;
    peerTyping = false;
    el.search.value = ''; searchResults = null;
    const c = convs.get(p);
    if (c) c.unread = 0;
    el.empty.hidden = true;
    el.chatPane.hidden = false;
    el.app.classList.add('chat-open');
    el.messages.replaceChildren();
    msgData.clear();
    cancelReply();
    updateHeader();
    renderList();
    loadMessages(p);
    el.text.focus();
  }
  function closeChat() {
    peer = null;
    el.app.classList.remove('chat-open');
    el.chatPane.hidden = true; el.empty.hidden = false;
    renderList();
  }
  el.back.onclick = closeChat;

  function onNewMessage(m) {
    const other = m.from === me ? m.to : m.from;
    const c = convs.get(other) || { peer: other, unread: 0 };
    c.last = m;
    if (other === peer) {
      appendMsg(m);
      if (m.from !== me && document.visibilityState === 'visible') socket.emit('messages:read', { peer });
      else if (m.from !== me) c.unread++;
    } else if (m.from !== me) {
      c.unread++;
    }
    if (m.from !== me && (other !== peer || document.visibilityState !== 'visible')) beep();
    convs.set(other, c);
    renderList();
  }

  function sendPayload(payload, localSrc) {
    if (!socket || !socket.connected) { toast('Connecting\u2026 try again in a moment'); return false; }
    const to = peer;
    const replyTo = replyingTo ? replyingTo.id : undefined;
    cancelReply();
    socket.emit('message:send', { to, replyTo, ...payload }, (res) => {
      if (!res || res.error) { toast((res && res.error) || 'Could not send'); return; }
      if (to === peer) appendMsg(localSrc ? { ...res.message, localSrc } : res.message);
      const c = convs.get(to) || { peer: to, unread: 0 };
      c.last = res.message;
      convs.set(to, c);
      renderList();
    });
    return true;
  }

  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.text.value.trim();
    if (!text || !peer) return;
    if (sendPayload({ text })) { el.text.value = ''; stopTyping(); }
    closeEmoji();
  });

  function stopTyping() {
    clearTimeout(typingStop);
    if (socket && peer) socket.emit('typing', { to: peer, typing: false });
  }
  el.text.addEventListener('input', () => {
    if (!socket || !peer) return;
    socket.emit('typing', { to: peer, typing: true });
    clearTimeout(typingStop);
    typingStop = setTimeout(stopTyping, 1500);
  });

  /* ---------- photos ---------- */
  function compress(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let max = 1280, q = 0.8;
        for (let i = 0; i < 4; i++) {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          const data = c.toDataURL('image/jpeg', q);
          if (data.length < 1600000) return resolve(data);
          max = Math.round(max * 0.75); q -= 0.1;
        }
        reject(new Error('Photo is too large'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this photo')); };
      img.src = url;
    });
  }
  el.photoBtn.onclick = () => { if (peer) el.photo.click(); };
  el.photo.addEventListener('change', async () => {
    const file = el.photo.files[0];
    el.photo.value = '';
    if (!file || !peer) return;
    if (!file.type.startsWith('image/')) { toast('Please choose an image'); return; }
    try {
      toast('Sending photo\u2026');
      const dataUrl = await compress(file);
      const caption = el.text.value.trim();
      if (sendPayload({ image: dataUrl, text: caption }, dataUrl)) { el.text.value = ''; stopTyping(); }
    } catch (err) { toast(err.message); }
  });

  /* ---------- emoji ---------- */
  const EMOJIS = ('😀 😁 😂 🤣 😊 😍 😘 😎 🤔 😅 😢 😭 😡 🥳 😴 🙏 👍 👎 👏 🙌 💪 🔥 ❤️ 💔 🎉 ✨ 💯 ✅ ❌ 👋 🤝 🙈 ' +
    '😉 😇 🥺 😜 🤗 😬 🙄 😮 😋 😌 😤 😱 👌 ✌️ 🤖 🚀').split(' ');
  EMOJIS.forEach((ch) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = ch; b.setAttribute('aria-label', 'Insert ' + ch);
    b.onclick = () => {
      const i = el.text.selectionStart == null ? el.text.value.length : el.text.selectionStart;
      const j = el.text.selectionEnd == null ? i : el.text.selectionEnd;
      el.text.setRangeText(ch, i, j, 'end');
      el.text.focus();
    };
    el.emojiPanel.appendChild(b);
  });
  function closeEmoji() { el.emojiPanel.hidden = true; }
  el.emojiBtn.onclick = () => { el.emojiPanel.hidden = !el.emojiPanel.hidden; };

  /* ---------- push notifications ---------- */
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  function urlB64ToUint8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }
  function updateNotifUi() {
    const perm = notifPerm();
    let msg = '';
    if (!pushSupported()) msg = 'This browser does not support notifications. On iPhone, first use Share \u2192 Add to Home Screen, then open Sandesh from the home screen.';
    else if (perm === 'granted') msg = 'Notifications are ON for this device.';
    else if (perm === 'denied') msg = 'Notifications are blocked. Allow them from the browser\u2019s site settings (lock icon near the address bar).';
    else msg = 'Get a ping when a message arrives, even when Sandesh is closed.';
    el.notifStatus.textContent = msg;
    const show = pushSupported() && perm === 'default';
    el.notifBar.hidden = !show;
    el.notifBtn.hidden = !show;
  }
  async function subscribePush() {
    if (!pushSupported() || !config.vapidPublicKey) return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: urlB64ToUint8(config.vapidPublicKey),
      });
    }
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  }
  async function enableNotifications() {
    if (!pushSupported()) { updateNotifUi(); toast('Notifications are not supported here'); return; }
    try {
      const perm = await Notification.requestPermission();
      updateNotifUi();
      if (perm !== 'granted') { toast('Notifications were not allowed'); return; }
      await subscribePush();
      toast('Notifications enabled');
    } catch (e) { toast('Could not enable notifications'); }
  }
  el.notifEnable.onclick = enableNotifications;
  el.notifBtn.onclick = enableNotifications;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-chat' && e.data.peer && token) openChat(e.data.peer);
    });
  }

  /* ---------- settings ---------- */
  el.settingsBtn.onclick = async () => {
    el.pwMsg.textContent = '';
    updateNotifUi();
    el.settings.showModal();
    try {
      const info = await api('/me');
      el.pwSection.hidden = info.isAdmin;
      el.curRow.hidden = !info.hasPassword;
    } catch (e) { /* ignore */ }
  };
  el.settingsClose.onclick = () => el.settings.close();
  el.pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.pwMsg.textContent = '';
    try {
      await api('/me/password', { method: 'POST', body: { current: el.curPw.value, next: el.newPw.value } });
      el.curPw.value = ''; el.newPw.value = '';
      el.pwMsg.textContent = 'Password updated.';
    } catch (err) { el.pwMsg.textContent = err.message; }
  });

  /* ---------- admin console ---------- */
  async function loadAdmin() {
    el.adminList.replaceChildren();
    try {
      const users = await api('/admin/users');
      users.forEach((u) => {
        const li = document.createElement('li');
        const info = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'au-name';
        name.textContent = u.username;
        if (u.isAdmin) { const t = document.createElement('em'); t.textContent = 'ADMIN'; name.appendChild(t); }
        if (u.online) { const t = document.createElement('em'); t.textContent = 'ONLINE'; name.appendChild(t); }
        const meta = document.createElement('div');
        meta.className = 'au-meta';
        meta.textContent = (u.email || 'password login') + ' \u00B7 joined ' + new Date(u.createdAt).toLocaleDateString();
        info.append(name, meta);
        li.appendChild(info);
        if (!u.isAdmin) {
          const act = document.createElement('div');
          act.className = 'au-actions';
          const reset = document.createElement('button');
          reset.type = 'button'; reset.textContent = 'Reset password';
          reset.onclick = async () => {
            const pw = prompt('Set a temporary password for ' + u.username + ' (at least 6 characters):');
            if (!pw) return;
            try {
              await api('/admin/users/' + encodeURIComponent(u.username) + '/reset', { method: 'POST', body: { password: pw } });
              toast('Password reset. Share it with ' + u.username);
            } catch (e) { toast(e.message); }
          };
          const del = document.createElement('button');
          del.type = 'button'; del.className = 'del'; del.textContent = 'Delete';
          del.onclick = async () => {
            if (!confirm('Delete account "' + u.username + '" and all their messages? This cannot be undone.')) return;
            try {
              await api('/admin/users/' + encodeURIComponent(u.username), { method: 'DELETE' });
              toast('Account deleted');
              loadAdmin();
            } catch (e) { toast(e.message); }
          };
          act.append(reset, del);
          li.appendChild(act);
        }
        el.adminList.appendChild(li);
      });
    } catch (e) { toast(e.message); }
  }
  el.adminBtn.onclick = () => { el.admin.showModal(); loadAdmin(); };
  el.adminClose.onclick = () => el.admin.close();

  /* ---------- boot ---------- */
  fetch('/api/config').then((r) => r.json()).then((c) => {
    config = c;
    if (!token) { el.googleWrap.hidden = !config.googleClientId || mode === 'gsetup'; initGoogle(); }
    else if (notifPerm() === 'granted') subscribePush().catch(() => {});
  }).catch(() => {});

  setMode('login');
  if (token && me) start();
})();
