const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CACHE_DIR = '/app/cache';
const CONFIG_PATH = '/app/go-librespot-config.yml';
const GO_LIBRESPOT_PORT = 3678; // internal go-librespot API port

class Player {
    constructor(spotifyAuth) {
        this.auth = spotifyAuth;
        this.process = null;
        this.monitoring = false;
        this.monitorInterval = null;
        this.deviceName = process.env.DEVICE_NAME || 'SpotifyBot-24-7';
        this.playlistUri = process.env.PLAYLIST_URI;
        this.retryCount = 0;
        this.maxRetries = 50;
        this.loginUrl = null;

        // Ensure cache directory exists
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }

        this.startGoLibrespot();
    }

    startGoLibrespot() {
        console.log(`🔊 Starting go-librespot as "${this.deviceName}"...`);

        this.process = spawn('go-librespot', ['--config_path', CONFIG_PATH], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        this.process.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (!msg) return;

            // Capture OAuth login URL
            const urlMatch = msg.match(/(https?:\/\/\S+spotify\S+)/i) ||
                msg.match(/(https?:\/\/localhost:\d+\/login\S*)/i) ||
                msg.match(/visit[:\s]+(https?:\/\/\S+)/i);
            if (urlMatch) {
                this.loginUrl = urlMatch[1];
                console.log(`🔗 Login URL: ${this.loginUrl}`);
            }

            if (msg.toLowerCase().includes('authenticated') || msg.toLowerCase().includes('logged in')) {
                this.loginUrl = null;
                this.retryCount = 0;
                console.log('✅ go-librespot authenticated!');
                // Auto-start playback once authenticated and Spotify Web API is ready
                setTimeout(() => this.startPlayback(), 5000);
            }

            console.log(`[go-librespot] ${msg}`);
        });

        this.process.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (!msg) return;

            const urlMatch = msg.match(/(https?:\/\/\S+spotify\S+)/i) ||
                msg.match(/(https?:\/\/localhost:\d+\/login\S*)/i) ||
                msg.match(/visit[:\s]+(https?:\/\/\S+)/i) ||
                msg.match(/open (https?:\/\/\S+)/i);
            if (urlMatch) {
                this.loginUrl = urlMatch[1];
                console.log(`🔗 Login URL: ${this.loginUrl}`);
            }

            if (msg.toLowerCase().includes('authenticated') || msg.toLowerCase().includes('logged in')) {
                this.loginUrl = null;
                this.retryCount = 0;
                console.log('✅ go-librespot authenticated!');
                setTimeout(() => this.startPlayback(), 5000);
            }

            console.log(`[go-librespot] ${msg}`);
        });

        this.process.on('close', (code) => {
            console.log(`⚠️  go-librespot exited with code ${code}`);
            this.process = null;

            if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                const delay = Math.min(5000 * this.retryCount, 60000);
                console.log(`   Reconnecting in ${delay / 1000}s... (attempt ${this.retryCount}/${this.maxRetries})`);
                setTimeout(() => this.startGoLibrespot(), delay);
            } else {
                console.error('❌ Max reconnection attempts reached.');
            }
        });

        this.process.on('error', (err) => {
            console.error(`❌ go-librespot error: ${err.message}`);
        });
    }

    // Call go-librespot's internal REST API
    apiCall(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1',
                port: GO_LIBRESPOT_PORT,
                path,
                method,
                headers: { 'Content-Type': 'application/json' }
            };
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(data ? JSON.parse(data) : {}); }
                    catch { resolve({}); }
                });
            });
            req.on('error', reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    parsePlaylistUri(input) {
        if (!input) return null;
        if (input.startsWith('spotify:playlist:')) return input;
        const match = input.match(/playlist\/([a-zA-Z0-9]+)/);
        if (match) return `spotify:playlist:${match[1]}`;
        return `spotify:playlist:${input}`;
    }

    async startPlayback() {
        if (!this.playlistUri) {
            console.log('⚠️  PLAYLIST_URI not set.');
            return false;
        }

        const contextUri = this.parsePlaylistUri(this.playlistUri);
        console.log(`🎶 Starting playlist: ${contextUri}`);

        try {
            // Use go-librespot API to play
            await this.apiCall('POST', '/player/play', {
                uri: contextUri,
                skip_to: { track_index: 0 },
                shuffle: true,
                repeat_context: true
            });

            console.log('🔁 Repeat + Shuffle: ON');
            this.startMonitoring();
            return true;
        } catch (err) {
            // Fallback: use Spotify Web API if go-librespot API unavailable
            if (this.auth && this.auth.isAuthenticated()) {
                return await this.startPlaybackViaWebApi(contextUri);
            }
            console.error('❌ Playback error:', err.message);
            setTimeout(() => this.startPlayback(), 30000);
            return false;
        }
    }

    async startPlaybackViaWebApi(contextUri) {
        try {
            const api = this.auth.getApi();
            const devices = await api.getMyDevices();
            const device = devices.body.devices.find(d =>
                d.name === this.deviceName || d.name.includes('SpotifyBot')
            );

            if (!device) {
                console.log('❌ Device not found via Spotify Web API. Retrying in 15s...');
                setTimeout(() => this.startPlayback(), 15000);
                return false;
            }

            console.log(`✅ Found device via Web API: ${device.name}`);
            await api.transferMyPlayback([device.id], { play: false });
            await this.sleep(1500);
            await api.play({ device_id: device.id, context_uri: contextUri });
            await this.sleep(500);
            await api.setRepeat('context', { device_id: device.id });
            await api.setShuffle(true, { device_id: device.id });
            console.log('🎶 Playback started via Web API!');
            this.startMonitoring();
            return true;
        } catch (err) {
            console.error('❌ Web API playback error:', err.message);
            setTimeout(() => this.startPlayback(), 30000);
            return false;
        }
    }

    startMonitoring() {
        if (this.monitoring) return;
        this.monitoring = true;
        console.log('👁️  Playback monitor started');

        this.monitorInterval = setInterval(async () => {
            try {
                const state = await this.apiCall('GET', '/player');
                if (!state.is_playing) {
                    console.log('⚠️  Playback stopped. Restarting...');
                    this.monitoring = false;
                    clearInterval(this.monitorInterval);
                    this.monitorInterval = null;
                    await this.startPlayback();
                } else {
                    const track = state.track;
                    if (track) {
                        console.log(`🎵 Playing: ${track.name} — ${(track.artist_names || []).join(', ')}`);
                    }
                }
            } catch {
                // go-librespot API not responding, check via Web API
                if (this.auth && this.auth.isAuthenticated()) {
                    try {
                        const api = this.auth.getApi();
                        const pb = await api.getMyCurrentPlaybackState();
                        if (!pb.body || !pb.body.is_playing) {
                            console.log('⚠️  Playback stopped. Restarting...');
                            this.monitoring = false;
                            clearInterval(this.monitorInterval);
                            this.monitorInterval = null;
                            await this.startPlayback();
                        } else if (pb.body.item) {
                            const t = pb.body.item;
                            console.log(`🎵 Playing: ${t.name} — ${t.artists.map(a => a.name).join(', ')}`);
                        }
                    } catch { /* silent */ }
                }
            }
        }, 30000);
    }

    async getStatus() {
        const status = {
            authenticated: this.auth ? this.auth.isAuthenticated() : false,
            processRunning: this.process !== null && !this.process.killed,
            monitoring: this.monitoring,
            deviceName: this.deviceName,
            playlistUri: this.playlistUri,
            loginUrl: this.loginUrl,
            playing: false,
            currentTrack: null,
            devices: []
        };

        // Try go-librespot API first
        try {
            const state = await this.apiCall('GET', '/player');
            status.playing = state.is_playing || false;
            if (state.track) {
                status.currentTrack = {
                    name: state.track.name,
                    artist: (state.track.artist_names || []).join(', '),
                    album: state.track.album_name || '',
                    albumArt: state.track.album_cover_url || null,
                    progress: state.position_ms || 0,
                    duration: state.track.duration_ms || 0
                };
            }
        } catch { /* go-librespot API not available yet */ }

        // Get device list from Spotify Web API
        if (status.authenticated) {
            try {
                const api = this.auth.getApi();
                const devices = await api.getMyDevices();
                status.devices = devices.body.devices.map(d => ({
                    name: d.name,
                    type: d.type,
                    active: d.is_active,
                    volume: d.volume_percent
                }));
            } catch { /* silent */ }
        }

        return status;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = Player;
