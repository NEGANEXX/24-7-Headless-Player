require('dotenv').config();
const express = require('express');
const path = require('path');
const SpotifyAuth = require('./spotify');
const Player = require('./player');

const app = express();
const PORT = process.env.PORT || 3000;

const spotifyAuth = new SpotifyAuth();
const player = new Player(spotifyAuth);

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Status API
app.get('/api/status', async (req, res) => {
  try {
    const status = await player.getStatus();
    res.json(status);
  } catch (err) {
    res.json({ authenticated: false, playing: false, error: err.message });
  }
});

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
    // Give librespot a moment to register, then start playback
    setTimeout(() => player.startPlayback(), 3000);
    res.redirect('/');
  } catch (err) {
    console.error('❌ Auth failed:', err.message);
    res.status(500).send(`Authentication failed: ${err.message}. <a href="/">Go back</a>`);
  }
});

// Manual start playback
app.post('/api/start', async (req, res) => {
  try {
    await player.startPlayback();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get go-librespot OAuth login URL
app.get('/api/device-login-url', (req, res) => {
  res.json({ url: player.loginUrl || null });
});

// Manual stop playback
app.post('/api/stop', async (req, res) => {
  try {
    const api = spotifyAuth.getApi();
    await api.pause();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Spotify 24/7 Bot running on port ${PORT}`);
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
