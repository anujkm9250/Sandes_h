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
const { Server } = require('socket.io');

const { MONGO_URI, JWT_SECRET, INVITE_CODE } = process.env;
const PORT = process.env.PORT || 3000;

if (!MONGO_URI || !JWT_SECRET || !INVITE_CODE) {
  console.error('Missing env vars: MONGO_URI, JWT_SECRET and INVITE_CODE are all required.');
  process.exit(1);
}

/* ---------- Database models ---------- */
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  lastSeen: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
}));

const messageSchema = new mongoose.Schema({
  from: { type: String, required: true, index: true },
  to: { type: String, required: true, index: true },
  text: { type: String, required: true, maxlength: 2000 },
  status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  createdAt: { type: Date, default: Date.now },
});
messageSchema.index({ from: 1, to: 1, createdAt: 1 });
const Message = mongoose.model('Message', messageSchema);

const ser = (m) => ({
  id: String(m._id), from: m.from, to: m.to, text: m.text,
  status: m.status, createdAt: m.createdAt,
});

/* ---------- Helpers ---------- */
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const signToken = (username) => jwt.sign({ u: username }, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const payload = jwt.verify(h.replace(/^Bearer /, ''), JWT_SECRET);
    req.user = payload.u;
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again' });
  }
}

/* ---------- Express app ---------- */
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.send('ok')); // for UptimeRobot

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const invite = String(req.body.invite || '');
    if (!safeEqual(invite, INVITE_CODE)) return res.status(403).json({ error: 'Wrong invite code' });
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username: 3-20 letters, numbers or underscore' });
    }
    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({ error: 'Password must be 8-72 characters' });
    }
    const passwordHash = await bcrypt.hash(password, 11);
    await User.create({ username, passwordHash });
    res.json({ token: signToken(username), username });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Username already taken' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await User.findOne({ username });
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) return res.status(401).json({ error: 'Wrong username or password' });
    res.json({ token: signToken(username), username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/search', auth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!q) return res.json([]);
  const users = await User.find({ username: { $regex: '^' + q } })
    .limit(10).lean();
  res.json(users.filter((u) => u.username !== req.user)
    .map((u) => ({ username: u.username, lastSeen: u.lastSeen })));
});

app.get('/api/conversations', auth, async (req, res) => {
  const me = req.user;
  const msgs = await Message.find({ $or: [{ from: me }, { to: me }] })
    .sort({ createdAt: -1 }).limit(1000).lean();
  const map = new Map();
  for (const m of msgs) {
    const peer = m.from === me ? m.to : m.from;
    if (!map.has(peer)) map.set(peer, { peer, last: ser(m), unread: 0 });
    if (m.to === me && m.status !== 'read') map.get(peer).unread++;
  }
  const users = await User.find({ username: { $in: [...map.keys()] } }).lean();
  const seen = new Map(users.map((u) => [u.username, u.lastSeen]));
  res.json([...map.values()].map((c) => ({ ...c, lastSeen: seen.get(c.peer) })));
});

app.get('/api/messages/:peer', auth, async (req, res) => {
  const me = req.user;
  const peer = String(req.params.peer).toLowerCase();
  const msgs = await Message.find({
    $or: [{ from: me, to: peer }, { from: peer, to: me }],
  }).sort({ createdAt: -1 }).limit(200).lean();
  res.json(msgs.reverse().map(ser));
});

/* ---------- Real-time (Socket.IO) ---------- */
const server = http.createServer(app);
const io = new Server(server);
const online = new Map(); // username -> Set(socket ids)

io.use((socket, next) => {
  try {
    socket.username = jwt.verify(socket.handshake.auth.token, JWT_SECRET).u;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

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
      if (!text || text.length > 2000 || to === me) return reply({ error: 'Invalid message' });
      if (!(await User.exists({ username: to }))) return reply({ error: 'User not found' });

      const m = await Message.create({ from: me, to, text, status: online.has(to) ? 'delivered' : 'sent' });
      const out = ser(m);
      io.to('u:' + to).emit('message:new', out);
      socket.to('u:' + me).emit('message:new', out); // my other devices
      reply({ ok: true, message: out });
    } catch (e) {
      console.error(e);
      reply({ error: 'Could not send' });
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

mongoose.connect(MONGO_URI).then(() => {
  console.log('MongoDB connected');
  server.listen(PORT, () => console.log('Sandesh running on port ' + PORT));
}).catch((e) => {
  console.error('MongoDB connection failed:', e.message);
  process.exit(1);
});
