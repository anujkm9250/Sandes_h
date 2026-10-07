(() => {
  const $ = (s) => document.querySelector(s);
  const el = {
    auth: $('#auth'), form: $('#auth-form'), tabLogin: $('#tab-login'), tabSignup: $('#tab-signup'),
    username: $('#username'), password: $('#password'), invite: $('#invite'), inviteRow: $('#invite-row'),
    error: $('#auth-error'), submit: $('#auth-submit'),
    app: $('#app'), meName: $('#me-name'), logout: $('#logout'), search: $('#search'), list: $('#list'),
    empty: $('#empty'), pane: $('#chat-pane'), back: $('#back'), peerName: $('#peer-name'),
    peerStatus: $('#peer-status'), peerAvatar: $('#peer-avatar'), messages: $('#messages'),
    composer: $('#composer'), text: $('#text'), toast: $('#toast'),
  };

  let token = localStorage.getItem('token');
  let me = localStorage.getItem('me');
  let socket = null;
  let peer = null;
  let mode = 'login';
  let searchResults = null;
  let searchTimer = null, typingStop = null, typingHide = null, peerTyping = false;
  const convs = new Map();      // peer -> { peer, last, unread }
  const online = new Set();
  const lastSeen = new Map();   // peer -> ISO date

  /* ---------- helpers ---------- */
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
    toast.t = setTimeout(() => el.toast.classList.remove('show'), 3000);
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

  /* ---------- auth ---------- */
  function setMode(m) {
    mode = m;
    const isSignup = m === 'signup';
    el.tabLogin.classList.toggle('active', !isSignup);
    el.tabSignup.classList.toggle('active', isSignup);
    el.tabLogin.setAttribute('aria-selected', String(!isSignup));
    el.tabSignup.setAttribute('aria-selected', String(isSignup));
    el.inviteRow.hidden = !isSignup;
    el.invite.required = isSignup;
    el.password.autocomplete = isSignup ? 'new-password' : 'current-password';
    el.submit.textContent = isSignup ? 'Create account' : 'Log in';
    el.error.textContent = '';
  }
  el.tabLogin.onclick = () => setMode('login');
  el.tabSignup.onclick = () => setMode('signup');

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.error.textContent = '';
    el.submit.disabled = true;
    try {
      const body = { username: el.username.value, password: el.password.value };
      if (mode === 'signup') body.invite = el.invite.value;
      const data = await api('/auth/' + mode, { method: 'POST', body });
      token = data.token; me = data.username;
      localStorage.setItem('token', token);
      localStorage.setItem('me', me);
      el.password.value = ''; el.invite.value = '';
      start();
    } catch (err) {
      el.error.textContent = err.message;
    } finally {
      el.submit.disabled = false;
    }
  });

  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('me');
    if (socket) socket.disconnect();
    location.reload();
  }
  el.logout.onclick = logout;

  /* ---------- app start ---------- */
  function start() {
    el.auth.hidden = true;
    el.app.hidden = false;
    el.meName.textContent = me;
    connectSocket();
  }

  function connectSocket() {
    socket = io({ auth: { token } });
    socket.on('connect_error', (err) => { if (err.message === 'unauthorized') logout(); });
    socket.on('connect', () => {
      loadConversations();
      if (peer) loadMessages(peer);
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
    socket.on('message:status', ({ ids, status }) => ids.forEach((id) => setTick(id, status)));
    socket.on('typing', ({ from, typing }) => {
      if (from !== peer) return;
      peerTyping = typing;
      clearTimeout(typingHide);
      if (typing) typingHide = setTimeout(() => { peerTyping = false; updateHeader(); }, 4000);
      updateHeader();
    });
  }

  /* ---------- conversations list ---------- */
  async function loadConversations() {
    try {
      const list = await api('/conversations');
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
    av.textContent = name[0];

    const main = document.createElement('div');
    main.className = 'row-main';
    const top = document.createElement('div');
    top.className = 'row-top';
    const nm = document.createElement('span');
    nm.className = 'row-name'; nm.textContent = name;
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
    pv.textContent = last ? (last.from === me ? 'You: ' : '') + last.text : 'Start a conversation';
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

  function renderList() {
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
      n.textContent = 'No chats yet. Search for a friend\u2019s username above to start.';
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
        searchResults = await api('/users/search?q=' + encodeURIComponent(q));
        searchResults.forEach((u) => u.lastSeen && lastSeen.set(u.username, u.lastSeen));
        renderList();
      } catch (e) { toast(e.message); }
    }, 250);
  });

  /* ---------- chat ---------- */
  function updateHeader() {
    if (!peer) return;
    el.peerName.textContent = peer;
    el.peerAvatar.textContent = peer[0];
    el.peerAvatar.classList.toggle('on', online.has(peer));
    let s = 'offline';
    if (peerTyping) s = 'typing\u2026';
    else if (online.has(peer)) s = 'online';
    else if (lastSeen.get(peer)) s = 'last seen ' + fmtShort(lastSeen.get(peer)) + ', ' + fmtTime(lastSeen.get(peer));
    el.peerStatus.textContent = s;
  }

  function tickText(status) { return status === 'sent' ? '\u2713' : '\u2713\u2713'; }

  function appendMsg(m) {
    if (el.messages.querySelector('[data-id="' + m.id + '"]')) return;
    const mine = m.from === me;
    const d = document.createElement('div');
    d.className = 'msg' + (mine ? ' mine' : '');
    d.dataset.id = m.id;
    d.append(document.createTextNode(m.text));
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.append(document.createTextNode(fmtTime(m.createdAt)));
    if (mine) {
      const t = document.createElement('span');
      t.className = 'tick ' + m.status;
      t.textContent = ' ' + tickText(m.status);
      meta.appendChild(t);
    }
    d.appendChild(meta);
    el.messages.appendChild(d);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function setTick(id, status) {
    const t = el.messages.querySelector('[data-id="' + id + '"] .tick');
    if (!t) return;
    t.className = 'tick ' + status;
    t.textContent = ' ' + tickText(status);
  }

  async function loadMessages(p) {
    try {
      const msgs = await api('/messages/' + encodeURIComponent(p));
      if (p !== peer) return;
      el.messages.replaceChildren();
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
    el.pane.hidden = false;
    el.app.classList.add('chat-open');
    el.messages.replaceChildren();
    updateHeader();
    renderList();
    loadMessages(p);
    el.text.focus();
  }

  el.back.onclick = () => {
    peer = null;
    el.app.classList.remove('chat-open');
    el.pane.hidden = true; el.empty.hidden = false;
    renderList();
  };

  function onNewMessage(m) {
    const other = m.from === me ? m.to : m.from;
    const c = convs.get(other) || { peer: other, unread: 0 };
    c.last = m;
    if (other === peer) {
      appendMsg(m);
      if (m.from !== me) socket.emit('messages:read', { peer });
    } else if (m.from !== me) {
      c.unread++;
    }
    convs.set(other, c);
    renderList();
  }

  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.text.value.trim();
    if (!text || !peer) return;
    if (!socket || !socket.connected) { toast('Connecting\u2026 try again in a moment'); return; }
    socket.emit('message:send', { to: peer, text }, (res) => {
      if (!res || res.error) { toast((res && res.error) || 'Could not send'); return; }
      appendMsg(res.message);
      const c = convs.get(peer) || { peer, unread: 0 };
      c.last = res.message;
      convs.set(peer, c);
      renderList();
    });
    el.text.value = '';
    stopTyping();
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

  /* ---------- boot ---------- */
  if (token && me) start();
})();
