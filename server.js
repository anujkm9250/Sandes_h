require('dotenv').config();
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const { OAuth2Client } = require('google-auth-library');
const { Server } = require('socket.io');

const { MONGO_URI, JWT_SECRET, INVITE_CODE, GOOGLE_CLIENT_ID, ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
const PORT = process.env.PORT || 3000;

if (!MONGO_URI || !JWT_SECRET || !INVITE_CODE) {
  console.error('Missing env vars: MONGO_URI, JWT_SECRET and INVITE_CODE are all required.');
  process.exit(1);
}

/* ---------- Database models ---------- */
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String },
  email: { type: String, lowercase: true, trim: true, index: { unique: true, sparse: true } },
  googleId: { type: String, index: { unique: true, sparse: true } },
  isAdmin: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
}));

const messageSchema = new mongoose.Schema({
  from: { type: String, required: true, index: true },
  to: { type: String, required: true, index: true },
  text: { type: String, default: '', maxlength: 2000 },
  kind: { type: String, enum: ['text', 'image'], default: 'text' },
  imageData: { type: Buffer, select: false },
  deletedForAll: { type: Boolean, default: false },
  hiddenFor: { type: [String], default: [] },
  replyTo: { id: String, from: String, text: String, kind: String },
  status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  createdAt: { type: Date, default: Date.now },
});
messageSchema.index({ from: 1, to: 1, createdAt: 1 });
const Message = mongoose.model('Message', messageSchema);

// A user's private nickname for a contact. Never used for search.
const aliasSchema = new mongoose.Schema({
  owner: { type: String, required: true },
  peer: { type: String, required: true },
  name: { type: String, required: true, maxlength: 30 },
});
aliasSchema.index({ owner: 1, peer: 1 }, { unique: true });
const Alias = mongoose.model('Alias', aliasSchema);

const PushSub = mongoose.model('PushSub', new mongoose.Schema({
  username: { type: String, required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  p256dh: String,
  auth: String,
}));

const Config = mongoose.model('Config', new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed,
}));

const ser = (m) => {
  const base = { id: String(m._id), from: m.from, to: m.to, status: m.status, createdAt: m.createdAt };
  if (m.deletedForAll) return { ...base, text: '', kind: 'text', deleted: true, replyTo: null };
  const r = m.replyTo && m.replyTo.id
    ? { id: m.replyTo.id, from: m.replyTo.from, text: m.replyTo.text, kind: m.replyTo.kind } : null;
  return { ...base, text: m.text, kind: m.kind || 'text', deleted: false, replyTo: r };
};

/* ---------- Helpers ---------- */
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const signToken = (username) => jwt.sign({ u: username }, JWT_SECRET, { expiresIn: '30d' });
// Any characters are allowed. Length 6-72 bytes (bcrypt reads at most 72 bytes).
const validPassword = (p) => typeof p === 'string' && p.length >= 6 && Buffer.byteLength(p) <= 72;
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Server error' });
});

async function auth(req, res, next) {
  try {
    const payload = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), JWT_SECRET);
    const u = await User.findOne({ username: payload.u }).select('username isAdmin').lean();
    if (!u) throw new Error('account removed');
    req.user = u.username;
    req.isAdmin = !!u.isAdmin;
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again' });
  }
}
function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

/* ---------- Express app ---------- */
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy
app.use(helmet({
  // Google sign-in opens a popup, so the opener must stay reachable
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', 'https://accounts.google.com/gsi/style'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://accounts.google.com/gsi/'],
      frameSrc: ['https://accounts.google.com/gsi/'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => { if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); },
}));

app.get('/health', (_req, res) => res.send('ok')); // for UptimeRobot

let vapidPublicKey = null;
let pushReady = false;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

app.get('/api/config', (_req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, vapidPublicKey });
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

const userInfo = (u) => ({ username: u.username, isAdmin: !!u.isAdmin });

app.post('/api/auth/signup', authLimiter, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = req.body.password;
  const invite = String(req.body.invite || '');
  if (!safeEqual(invite, INVITE_CODE)) return res.status(403).json({ error: 'Wrong invite code' });
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username: 3-20 letters, numbers or underscore' });
  }
  if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const user = await User.create({ username, passwordHash: await bcrypt.hash(password, 11) });
    res.json({ token: signToken(username), ...userInfo(user) });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Username already taken' });
    throw e;
  }
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await User.findOne({ username });
  const ok = user && user.passwordHash && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Wrong username or password' });
  res.json({ token: signToken(username), ...userInfo(user) });
}));

app.post('/api/auth/google', authLimiter, wrap(async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'Google sign-in is not set up yet' });
  let p;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: String(req.body.credential || ''), audience: GOOGLE_CLIENT_ID,
    });
    p = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
  if (!p || !p.email || !p.email_verified) return res.status(400).json({ error: 'Google email is not verified' });
  const email = p.email.toLowerCase();

  let user = await User.findOne({ $or: [{ googleId: p.sub }, { email }] });
  if (!user) {
    const username = String(req.body.username || '').trim().toLowerCase();
    if (!username) {
      const suggested = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
      return res.json({ needsSetup: true, email, suggested });
    }
    if (!safeEqual(String(req.body.invite || ''), INVITE_CODE)) return res.status(403).json({ error: 'Wrong invite code' });
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username: 3-20 letters, numbers or underscore' });
    }
    try {
      user = await User.create({ username, email, googleId: p.sub });
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: 'Username already taken' });
      throw e;
    }
  } else if (!user.googleId) {
    user.googleId = p.sub;
    await user.save();
  }
  res.json({ token: signToken(user.username), ...userInfo(user) });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const u = await User.findOne({ username: req.user }).lean();
  res.json({ username: u.username, isAdmin: !!u.isAdmin, email: u.email || null, hasPassword: !!u.passwordHash });
}));

app.post('/api/me/password', authLimiter, auth, wrap(async (req, res) => {
  const u = await User.findOne({ username: req.user });
  if (u.isAdmin) return res.status(400).json({ error: 'Admin password is set in Render (ADMIN_PASSWORD)' });
  const { current, next } = req.body || {};
  if (u.passwordHash && !(await bcrypt.compare(String(current || ''), u.passwordHash))) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  if (!validPassword(next)) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  u.passwordHash = await bcrypt.hash(next, 11);
  await u.save();
  res.json({ ok: true });
}));

/* ----- nicknames (private to each user) ----- */
app.get('/api/aliases', auth, wrap(async (req, res) => {
  const rows = await Alias.find({ owner: req.user }).lean();
  res.json(Object.fromEntries(rows.map((a) => [a.peer, a.name])));
}));

app.put('/api/aliases/:peer', auth, wrap(async (req, res) => {
  const peer = String(req.params.peer).toLowerCase();
  const name = String((req.body && req.body.name) || '').trim().slice(0, 30);
  if (!name) {
    await Alias.deleteOne({ owner: req.user, peer });
    return res.json({ name: null });
  }
  if (!(await User.exists({ username: peer }))) return res.status(404).json({ error: 'User not found' });
  await Alias.updateOne({ owner: req.user, peer }, { $set: { name } }, { upsert: true });
  res.json({ name });
}));

/* ----- push notifications ----- */
app.post('/api/push/subscribe', auth, wrap(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (typeof endpoint !== 'string' || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  await PushSub.updateOne({ endpoint }, { $set: { username: req.user, p256dh: keys.p256dh, auth: keys.auth } }, { upsert: true });
  res.json({ ok: true });
}));

app.post('/api/push/unsubscribe', auth, wrap(async (req, res) => {
  await PushSub.deleteOne({ endpoint: String((req.body && req.body.endpoint) || ''), username: req.user });
  res.json({ ok: true });
}));

/* ----- chat data ----- */
app.get('/api/users/search', auth, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!q) return res.json([]);
  const users = await User.find({ username: { $regex: '^' + q } }).limit(10).lean();
  res.json(users.filter((u) => u.username !== req.user)
    .map((u) => ({ username: u.username, lastSeen: u.lastSeen })));
}));

app.get('/api/conversations', auth, wrap(async (req, res) => {
  const me = req.user;
  const msgs = await Message.find({ $or: [{ from: me }, { to: me }], hiddenFor: { $ne: me } })
    .sort({ createdAt: -1 }).limit(1000).lean();
  const map = new Map();
  for (const m of msgs) {
    const peer = m.from === me ? m.to : m.from;
    if (!map.has(peer)) map.set(peer, { peer, last: ser(m), unread: 0 });
    if (m.to === me && m.status !== 'read' && !m.deletedForAll) map.get(peer).unread++;
  }
  const users = await User.find({ username: { $in: [...map.keys()] } }).lean();
  const seen = new Map(users.map((u) => [u.username, u.lastSeen]));
  res.json([...map.values()].map((c) => ({ ...c, lastSeen: seen.get(c.peer) })));
}));

app.get('/api/messages/:peer', auth, wrap(async (req, res) => {
  const me = req.user;
  const peer = String(req.params.peer).toLowerCase();
  const msgs = await Message.find({
    $or: [{ from: me, to: peer }, { from: peer, to: me }],
    hiddenFor: { $ne: me },
  }).sort({ createdAt: -1 }).limit(200).lean();
  res.json(msgs.reverse().map(ser));
}));

app.get('/api/images/:id', auth, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).end();
  const m = await Message.findById(req.params.id).select('+imageData from to kind hiddenFor deletedForAll');
  if (!m || m.kind !== 'image' || m.deletedForAll || m.hiddenFor.includes(req.user)
      || (m.from !== req.user && m.to !== req.user)) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(m.imageData);
}));

/* ----- admin ----- */
app.get('/api/admin/users', auth, adminOnly, wrap(async (_req, res) => {
  const users = await User.find().sort({ createdAt: -1 }).limit(500).lean();
  res.json(users.map((u) => ({
    username: u.username, email: u.email || null, isAdmin: !!u.isAdmin, hasPassword: !!u.passwordHash,
    createdAt: u.createdAt, lastSeen: u.lastSeen, online: online.has(u.username),
  })));
}));

app.post('/api/admin/users/:username/reset', auth, adminOnly, wrap(async (req, res) => {
  const username = String(req.params.username).toLowerCase();
  const target = await User.findOne({ username });
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.isAdmin) return res.status(400).json({ error: 'Admin password is set in Render (ADMIN_PASSWORD)' });
  const password = req.body && req.body.password;
  if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  target.passwordHash = await bcrypt.hash(password, 11);
  await target.save();
  res.json({ ok: true });
}));

app.delete('/api/admin/users/:username', auth, adminOnly, wrap(async (req, res) => {
  const username = String(req.params.username).toLowerCase();
  const target = await User.findOne({ username }).lean();
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.isAdmin) return res.status(400).json({ error: 'The admin account cannot be deleted' });
  await Promise.all([
    User.deleteOne({ username }),
    Message.deleteMany({ $or: [{ from: username }, { to: username }] }),
    Alias.deleteMany({ $or: [{ owner: username }, { peer: username }] }),
    PushSub.deleteMany({ username }),
  ]);
  io.in('u:' + username).disconnectSockets(true);
  online.delete(username);
  io.emit('user:deleted', { username });
  res.json({ ok: true });
}));

/* ---------- Real-time (Socket.IO) ---------- */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
const online = new Map(); // username -> Set(socket ids)

io.use(async (socket, next) => {
  try {
    const username = jwt.verify(socket.handshake.auth.token, JWT_SECRET).u;
    if (!(await User.exists({ username }))) throw new Error('gone');
    socket.username = username;
    socket.data.visible = true; // is the app on screen right now?
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

async function notifyPush(to, from, m) {
  if (!pushReady) return;
  const sockets = await io.in('u:' + to).fetchSockets();
  if (sockets.some((s) => s.data.visible)) return; // they are looking at the app
  const subs = await PushSub.find({ username: to }).lean();
  if (!subs.length) return;
  const body = m.kind === 'image' ? '\uD83D\uDCF7 Photo' + (m.text ? ' ' + m.text : '') : m.text;
  const payload = JSON.stringify({ title: from, body: body.slice(0, 140), peer: from, tag: 'chat-' + from });
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await PushSub.deleteOne({ _id: s._id });
    }
  }));
}

io.on('connection', async (socket) => {
  const me = socket.username;
  socket.join('u:' + me);
  if (!online.has(me)) online.set(me, new Set());
  online.get(me).add(socket.id);
  if (online.get(me).size === 1) io.emit('presence', { username: me, online: true });
  socket.emit('presence:list', [...online.keys()]);

  // Messages that arrived while I was offline are now "delivered"
  try {
    const pending = await Message.find({ to: me, status: 'sent' }).lean();
    if (pending.length) {
      await Message.updateMany({ to: me, status: 'sent' }, { status: 'delivered' });
      const bySender = {};
      pending.forEach((m) => (bySender[m.from] = bySender[m.from] || []).push(String(m._id)));
      for (const [sender, ids] of Object.entries(bySender)) {
        io.to('u:' + sender).emit('message:status', { peer: me, ids, status: 'delivered' });
      }
    }
  } catch (e) { console.error(e); }

  socket.on('visibility', (d) => { socket.data.visible = !!(d && d.visible); });

  let stamps = [];
  socket.on('message:send', async (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const now = Date.now();
      stamps = stamps.filter((t) => now - t < 10000);
      if (stamps.length >= 30) return reply({ error: 'Slow down a little' });
      stamps.push(now);

      const to = String((data && data.to) || '').toLowerCase();
      const text = String((data && data.text) || '').trim();
      const rawImage = data && typeof data.image === 'string' ? data.image : '';
      let imageData = null;
      if (rawImage) {
        const prefix = 'data:image/jpeg;base64,';
        if (!rawImage.startsWith(prefix) || rawImage.length > 1700000) return reply({ error: 'Photo is too large' });
        imageData = Buffer.from(rawImage.slice(prefix.length), 'base64');
        if (imageData.length < 100 || imageData[0] !== 0xff || imageData[1] !== 0xd8) {
          return reply({ error: 'Invalid photo' });
        }
      }
      if ((!text && !imageData) || text.length > 2000 || to === me) return reply({ error: 'Invalid message' });
      if (!(await User.exists({ username: to }))) return reply({ error: 'User not found' });

      let replyTo;
      const rid = data && data.replyTo;
      if (rid && mongoose.isValidObjectId(rid)) {
        const r = await Message.findById(rid).select('from to text kind deletedForAll').lean();
        if (r && !r.deletedForAll && [r.from, r.to].includes(me) && [r.from, r.to].includes(to)) {
          replyTo = { id: String(r._id), from: r.from, kind: r.kind, text: String(r.text || '').slice(0, 100) };
        }
      }

      const m = await Message.create({
        from: me, to, text, kind: imageData ? 'image' : 'text', imageData, replyTo,
        status: online.has(to) ? 'delivered' : 'sent',
      });
      const out = ser(m);
      io.to('u:' + to).emit('message:new', out);
      socket.to('u:' + me).emit('message:new', out); // my other devices
      reply({ ok: true, message: out });
      notifyPush(to, me, out).catch((e) => console.error('push failed', e.message));
    } catch (e) {
      console.error(e);
      reply({ error: 'Could not send' });
    }
  });

  socket.on('message:delete', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const id = d && d.id;
      if (!mongoose.isValidObjectId(id)) return reply({ error: 'Invalid message' });
      const m = await Message.findOne({ _id: id, $or: [{ from: me }, { to: me }] }).lean();
      if (!m) return reply({ error: 'Message not found' });
      if (d.scope === 'all') {
        if (m.from !== me) return reply({ error: 'You can delete only your own messages for everyone' });
        await Message.updateOne({ _id: id }, {
          $set: { deletedForAll: true, text: '', kind: 'text' },
          $unset: { imageData: 1, replyTo: 1 },
        });
        io.to('u:' + m.from).to('u:' + m.to).emit('message:deleted', { id: String(id), from: m.from, to: m.to });
      } else {
        await Message.updateOne({ _id: id }, { $addToSet: { hiddenFor: me } });
        io.to('u:' + me).emit('message:removed', { id: String(id) });
      }
      reply({ ok: true });
    } catch (e) {
      console.error(e);
      reply({ error: 'Could not delete' });
    }
  });

  socket.on('chat:clear', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const peer = String((d && d.peer) || '').toLowerCase();
      if (!peer) return reply({ error: 'Invalid chat' });
      await Message.updateMany(
        { $or: [{ from: me, to: peer }, { from: peer, to: me }] },
        { $addToSet: { hiddenFor: me } });
      io.to('u:' + me).emit('chat:cleared', { peer });
      reply({ ok: true });
    } catch (e) {
      console.error(e);
      reply({ error: 'Could not delete chat' });
    }
  });

  socket.on('typing', (d) => {
    const to = String((d && d.to) || '').toLowerCase();
    if (to) io.to('u:' + to).emit('typing', { from: me, typing: !!d.typing });
  });

  socket.on('messages:read', async (d) => {
    try {
      const peer = String((d && d.peer) || '').toLowerCase();
      const unread = await Message.find({ from: peer, to: me, status: { $ne: 'read' } }).lean();
      if (!unread.length) return;
      await Message.updateMany({ from: peer, to: me, status: { $ne: 'read' } }, { status: 'read' });
      io.to('u:' + peer).emit('message:status', {
        peer: me, ids: unread.map((m) => String(m._id)), status: 'read',
      });
    } catch (e) { console.error(e); }
  });

  socket.on('disconnect', async () => {
    const set = online.get(me);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      online.delete(me);
      const lastSeen = new Date();
      await User.updateOne({ username: me }, { lastSeen }).catch(() => {});
      io.emit('presence', { username: me, online: false, lastSeen });
    }
  });
});

/* ---------- Startup ---------- */
async function seedAdmin() {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    console.log('ADMIN_USERNAME / ADMIN_PASSWORD not set: admin panel is disabled.');
    return;
  }
  const username = ADMIN_USERNAME.trim().toLowerCase();
  if (!USERNAME_RE.test(username) || !validPassword(ADMIN_PASSWORD)) {
    console.error('ADMIN_USERNAME must be 3-20 letters/numbers/_ and ADMIN_PASSWORD at least 6 characters.');
    return;
  }
  // Render env is the source of truth for the admin password
  await User.updateOne({ username },
    { $set: { passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 11), isAdmin: true } }, { upsert: true });
  console.log('Admin account ready: ' + username);
}

async function initPush() {
  // VAPID keys are created once and kept in the database
  let cfg = await Config.findOne({ key: 'vapid' }).lean();
  if (!cfg) cfg = (await Config.create({ key: 'vapid', value: webpush.generateVAPIDKeys() })).toObject();
  const subject = process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || 'mailto:admin@sandesh.app';
  webpush.setVapidDetails(subject, cfg.value.publicKey, cfg.value.privateKey);
  vapidPublicKey = cfg.value.publicKey;
  pushReady = true;
}

mongoose.connect(MONGO_URI).then(async () => {
  console.log('MongoDB connected');
  await seedAdmin();
  await initPush().catch((e) => console.error('Push setup failed:', e.message));
  server.listen(PORT, () => console.log('Sandesh running on port ' + PORT));
}).catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
