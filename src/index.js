require('dotenv').config();
const express = require('express');
const path = require('path');
const SpotifyAuth = require('./spotify');
const Player = require('./player');

const app = express();
const PORT = process.env.PORT || 3000;

const spotifyAuth = new SpotifyAuth();
const player = new Player(spotifyAuth);

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────

// Parse JSON bodies
app.use(express.json());

// Remove X-Powered-By header (don't reveal Express)
app.disable('x-powered-by');

// Security headers for all responses
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ─── RATE LIMITING (in-memory, simple) ────────────────────────

const rateLimits = {};
const RATE_WINDOW_MS = 60 * 1000; // 1 minute window
const RATE_LIMITS = {
  search: 20,   // 20 searches per minute per IP
  queue: 5,     // 5 queue adds per minute per IP
  skip: 3,      // 3 skips per minute per IP
  volume: 10,   // 10 volume changes per minute per IP
  previous: 3,  // 3 previous track per minute per IP
  playback: 10  // 10 play/pause per minute per IP
};

function rateLimit(action) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const key = `${action}:${ip}`;
    const now = Date.now();

    if (!rateLimits[key]) {
      rateLimits[key] = { count: 0, resetAt: now + RATE_WINDOW_MS };
    }

    // Reset window if expired
    if (now > rateLimits[key].resetAt) {
      rateLimits[key] = { count: 0, resetAt: now + RATE_WINDOW_MS };
    }

    rateLimits[key].count++;

    if (rateLimits[key].count > RATE_LIMITS[action]) {
      return res.status(429).json({
        error: 'Too many requests. Please wait a moment.',
        retryAfter: Math.ceil((rateLimits[key].resetAt - now) / 1000)
      });
    }

    next();
  };
}

// Cleanup old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const key in rateLimits) {
    if (now > rateLimits[key].resetAt) {
      delete rateLimits[key];
    }
  }
}, 5 * 60 * 1000);

// ─── STATIC FILES ────────────────────────────────────────────

// Block access to sensitive files
app.use((req, res, next) => {
  const blocked = ['.env', 'tokens.json', '.git', 'package.json', 'package-lock.json',
    'Dockerfile', '.gitignore', 'node_modules', 'go-librespot'];
  const reqPath = req.path.toLowerCase();
  for (const file of blocked) {
    if (reqPath.includes(file.toLowerCase())) {
      return res.status(404).send('Not found');
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── PUBLIC API: Status (sanitized) ──────────────────────────

app.get('/api/status', async (req, res) => {
  try {
    const status = await player.getStatus();
    res.json({
      authenticated: status.authenticated,
      playing: status.playing,
      currentTrack: status.currentTrack,
      volume: status.volume,
      queue: status.queue
    });
  } catch (err) {
    res.json({ authenticated: false, playing: false, error: 'Service unavailable' });
  }
});

// ─── PUBLIC API: Server-Sent Events (live updates) ───────────

const sseClients = new Set();

app.get('/api/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial data
  res.write('data: {"connected":true}\n\n');

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Push status to all SSE clients every 2 seconds
setInterval(async () => {
  if (sseClients.size === 0) return;
  try {
    const status = await player.getStatus();
    const data = JSON.stringify({
      authenticated: status.authenticated,
      playing: status.playing,
      currentTrack: status.currentTrack,
      volume: status.volume,
      queue: status.queue
    });
    for (const client of sseClients) {
      client.write(`data: ${data}\n\n`);
    }
  } catch { /* silent */ }
}, 2000);

// ─── PUBLIC API: Search ──────────────────────────────────────

app.get('/api/search', rateLimit('search'), async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.trim().length < 2) {
      return res.json({ results: [] });
    }

    // Sanitize: limit query length
    const sanitizedQuery = query.trim().substring(0, 100);
    const results = await spotifyAuth.searchTracks(sanitizedQuery, 10);
    res.json({ results });
  } catch (err) {
    // Never leak internal error details to client
    if (err.message === 'Not authenticated') {
      res.status(401).json({ error: 'Spotify not connected yet' });
    } else {
      console.error('Search error:', err.message);
      res.status(500).json({ error: 'Search failed. Try again.' });
    }
  }
});

// ─── PUBLIC API: Add to Queue ────────────────────────────────

app.post('/api/queue', rateLimit('queue'), async (req, res) => {
  try {
    const { trackUri, name, artist, albumArt } = req.body;

    if (!trackUri) {
      return res.status(400).json({ error: 'No track specified' });
    }

    const result = await player.addToQueue(trackUri, { name, artist, albumArt });
    res.json({ success: true, queued: result });
  } catch (err) {
    if (err.message === 'Spotify not authenticated') {
      res.status(401).json({ error: 'Spotify not connected yet' });
    } else if (err.message === 'Invalid track URI') {
      res.status(400).json({ error: 'Invalid track' });
    } else if (err.message.includes('Queue is full')) {
      res.status(400).json({ error: 'Queue is full' });
    } else {
      console.error('Queue error:', err.message);
      res.status(500).json({ error: 'Could not add to queue. Try again.' });
    }
  }
});

// ─── PUBLIC API: Get Queue ───────────────────────────────────

app.get('/api/queue', (req, res) => {
  res.json({ queue: player.getQueue() });
});

// ─── PUBLIC API: Skip Track ──────────────────────────────────

app.post('/api/skip', rateLimit('skip'), async (req, res) => {
  try {
    await player.skipTrack();
    res.json({ success: true });
  } catch (err) {
    if (err.message === 'Spotify not authenticated') {
      res.status(401).json({ error: 'Spotify not connected yet' });
    } else {
      console.error('Skip error:', err.message);
      res.status(500).json({ error: 'Could not skip. Try again.' });
    }
  }
});

// ─── PUBLIC API: Previous Track ──────────────────────────────

app.post('/api/previous', rateLimit('previous'), async (req, res) => {
  try {
    await player.previousTrack();
    res.json({ success: true });
  } catch (err) {
    if (err.message === 'Spotify not authenticated') {
      res.status(401).json({ error: 'Spotify not connected yet' });
    } else {
      console.error('Previous error:', err.message);
      res.status(500).json({ error: 'Could not go back. Try again.' });
    }
  }
});

// ─── PUBLIC API: Play / Pause ────────────────────────────────

app.post('/api/playback', rateLimit('playback'), async (req, res) => {
  try {
    const { action } = req.body;
    if (action === 'play') {
      await player.play();
    } else if (action === 'pause') {
      await player.pause();
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
    res.json({ success: true, action });
  } catch (err) {
    if (err.message === 'Spotify not authenticated') {
      res.status(401).json({ error: 'Spotify not connected yet' });
    } else {
      console.error('Playback error:', err.message);
      res.status(500).json({ error: 'Could not change playback.' });
    }
  }
});

// ─── PUBLIC API: Volume Control ──────────────────────────────

app.get('/api/volume', async (req, res) => {
  try {
    const volume = await player.getVolume();
    res.json({ volume });
  } catch (err) {
    res.json({ volume: null, error: 'Could not get volume' });
  }
});

app.put('/api/volume', rateLimit('volume'), async (req, res) => {
  try {
    const { volume } = req.body;
    if (volume === undefined || volume < 0 || volume > 100 || !Number.isInteger(volume)) {
      return res.status(400).json({ error: 'Volume must be integer 0-100' });
    }
    await player.setVolume(volume);
    res.json({ success: true, volume });
  } catch (err) {
    if (err.message === 'Spotify not authenticated') {
      res.status(401).json({ error: 'Spotify not connected yet' });
    } else {
      console.error('Volume error:', err.message);
      res.status(500).json({ error: 'Could not change volume. Try again.' });
    }
  }
});

// ─── ADMIN-ONLY ROUTES (login/callback — only owner uses these) ──

// Login route — redirects to Spotify OAuth
app.get('/login', (req, res) => {
  const authUrl = spotifyAuth.getAuthUrl();
  res.redirect(authUrl);
});

// OAuth callback
app.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    await spotifyAuth.handleCallback(code);
    console.log('✅ Spotify authentication successful!');
    setTimeout(() => player.startPlayback(), 3000);
    res.redirect('/');
  } catch (err) {
    console.error('❌ Auth failed:', err.message);
    // Don't leak error details to the browser
    res.status(500).send('Authentication failed. <a href="/">Go back</a>');
  }
});

// Manual start playback (admin action)
app.post('/api/start', async (req, res) => {
  try {
    await player.startPlayback();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: 'Playback start failed' });
  }
});

// Manual stop playback (admin action)
app.post('/api/stop', async (req, res) => {
  try {
    const api = spotifyAuth.getApi();
    await api.pause();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: 'Playback stop failed' });
  }
});

// ─── CATCH-ALL 404 ───────────────────────────────────────────

app.use((req, res) => {
  res.status(404).send('Not found');
});

// ─── START SERVER ────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Sptfy DJ running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);

  // Try to restore session from saved tokens
  spotifyAuth.tryRestoreSession().then(restored => {
    if (restored) {
      console.log('✅ Session restored from saved tokens');
      setTimeout(() => player.startPlayback(), 5000);
    } else {
      console.log('⚠️  Please visit the dashboard to login with Spotify');
    }
  });
});
