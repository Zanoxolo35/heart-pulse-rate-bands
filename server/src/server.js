// Entry point: starts the API, the live stream, and serves the dashboard from /public.
const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const db = require('./db');
const { streamHandler } = require('./realtime');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// Small request log so you can see the ESP32 hitting the server
app.use('/api', (req, res, next) => {
  if (req.path !== '/stream') console.log(`${req.method} /api${req.path}`);
  next();
});

// ---------- API ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), sms: config.sms.provider }));
app.get('/api/stream', streamHandler);
app.use('/api/readings', require('./routes/readings'));
app.use('/api/patients', require('./routes/patients'));
app.use('/api/alerts', require('./routes/alerts'));
app.get('/api/responders', (req, res) => {
  const { role } = req.query;
  const rows = role
    ? db.prepare('SELECT * FROM responders WHERE role = ? ORDER BY full_name').all(role)
    : db.prepare('SELECT * FROM responders ORDER BY role, full_name').all();
  res.json(rows);
});

// ---------- Dashboard ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// Unknown API route
app.use('/api', (req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` }));

// Last-resort error handler: log it, don't leak details
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body is not valid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Check the server console.' });
});

// Listen on all network interfaces (0.0.0.0) so the ESP32 on your Wi-Fi can reach it
app.listen(config.port, '0.0.0.0', () => {
  console.log(`VitalCare server running:  http://localhost:${config.port}`);
  console.log(`ESP32 should post to:      http://<your-laptop-ip>:${config.port}/api/readings`);
  console.log(`SMS mode:                  ${config.sms.provider}`);
});
