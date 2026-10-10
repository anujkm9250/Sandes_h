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
    clearChat: $('#clear-chat'), replyBar: $('#reply-bar'), replyText: $('#reply-text'), replyCancel: $('#reply-cancel'),
    photo: $('#photo'), photoBtn: $('#photo-btn'), emojiBtn: $('#emoji-btn'), emojiPanel: $('#emoji-panel'),
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
    const lastText = last ? (last.deleted ? 'This message was deleted' : last.kind === 'image' ? '\uD83D\uDCF7 Photo' + (last.text ? ' ' + last.text : '') : last.text) : '';
    pv.textContent = last ? (last.from === me ? 'You: ' : '') + lastText : 'Start a conversation';
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

  const msgData = new Map();   // message id -> message object
  let replyingTo = null;

  const quoteText = (r) => (r.kind === 'image' ? '\uD83D\uDCF7 Photo' + (r.text ? ' ' + r.text : '') : r.text);

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
        who.textContent = m.replyTo.from === me ? 'You' : m.replyTo.from;
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

  function appendMsg(m) {
    if (el.messages.querySelector('[data-id="' + m.id + '"]')) return;
    el.messages.appendChild(buildMsg(m));
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function replaceMsg(m) {
    const old = el.messages.querySelector('[data-id="' + m.id + '"]');
    if (old) old.replaceWith(buildMsg(m)); else msgData.set(m.id, m);
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
    el.replyText.textContent = (m.from === me ? 'You' : m.from) + ': ' + quoteText(m);
    el.replyBar.hidden = false;
    el.text.focus();
  }
  function cancelReply() { replyingTo = null; el.replyBar.hidden = true; }
  el.replyCancel.onclick = cancelReply;

  el.clearChat.onclick = () => {
    if (!peer) return;
    if (!confirm('Delete this whole chat from your side? ' + peer + ' will still keep their copy.')) return;
    socket.emit('chat:clear', { peer }, (res) => { if (res && res.error) toast(res.error); });
  };

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
    el.pane.hidden = false;
    el.app.classList.add('chat-open');
    el.messages.replaceChildren();
    msgData.clear();
    cancelReply();
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
  const EMOJIS = ('😀 😁 😂 🤣 😊 😍 😘 😎 🤔 😅 😢 😭 😡 🥳 😴 🙏 ' +
    '👍 👎 👏 🙌 💪 🔥 ❤️ 💔 🎉 ✨ 💯 ✅ ❌ 👋 🤝 🙈 ' +
    '😉 😇 🥺 😜 🤗 😬 🙄 😮 😋 😌 😤 😱 👌 ✌️ 🍀 🎂').split(' ');
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

  /* ---------- boot ---------- */
  if (token && me) start();
})();
