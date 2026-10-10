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
      imgSrc: ["'self'", 'data:', 'blob:'],
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
});

app.get('/api/messages/:peer', auth, async (req, res) => {
  const me = req.user;
  const peer = String(req.params.peer).toLowerCase();
  const msgs = await Message.find({
    $or: [{ from: me, to: peer }, { from: peer, to: me }],
    hiddenFor: { $ne: me },
  }).sort({ createdAt: -1 }).limit(200).lean();
  res.json(msgs.reverse().map(ser));
});

app.get('/api/images/:id', auth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).end();
  const m = await Message.findById(req.params.id).select('+imageData from to kind hiddenFor deletedForAll');
  if (!m || m.kind !== 'image' || m.deletedForAll || m.hiddenFor.includes(req.user)
      || (m.from !== req.user && m.to !== req.user)) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(m.imageData);
});

/* ---------- Real-time (Socket.IO) ---------- */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
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

mongoose.connect(MONGO_URI).then(() => {
  console.log('MongoDB connected');
  server.listen(PORT, () => console.log('Sandesh running on port ' + PORT));
}).catch((e) => {
  console.error('MongoDB connection failed:', e.message);
  process.exit(1);
});
