const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CACHE_DIR = '/app/cache';
const CONFIG_DIR = '/app/config';
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

        this.process = spawn('go-librespot', ['--config_dir', CONFIG_DIR], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        const handleOutput = (data) => {
            const msg = data.toString().trim();
            if (!msg) return;

            // Capture OAuth URL from any log output
            const urlMatch = msg.match(/https:\/\/accounts\.spotify\.com[^\s"']*/i) ||
                msg.match(/http:\/\/[^\s"']*\/login[^\s"']*/i);
            if (urlMatch) {
                this.loginUrl = urlMatch[0];
                console.log(`🔗 Login URL captured: ${this.loginUrl}`);
            }

            // Detect successful authentication
            const lower = msg.toLowerCase();
            if (lower.includes('authenticated') || lower.includes('logged in') ||
                lower.includes('welcome') || lower.includes('country:')) {
                this.loginUrl = null;
                this.retryCount = 0;
                console.log('✅ go-librespot authenticated with Spotify!');
                if (!this.monitoring) {
                    setTimeout(() => this.startPlayback(), 3000);
                }
            }

            console.log(`[go-librespot] ${msg}`);
        };

        this.process.stdout.on('data', handleOutput);
        this.process.stderr.on('data', handleOutput);

        this.process.on('close', (code) => {
            console.log(`⚠️  go-librespot exited with code ${code}`);
            this.process = null;
            if (this.loginPollInterval) {
                clearInterval(this.loginPollInterval);
                this.loginPollInterval = null;
            }

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

        // After 3 seconds, start polling the go-librespot API for login URL
        setTimeout(() => this.pollForLoginUrl(), 3000);
    }

    async pollForLoginUrl() {
        // Poll go-librespot's /login endpoint to get the OAuth URL
        if (this.loginPollInterval) clearInterval(this.loginPollInterval);

        this.loginPollInterval = setInterval(async () => {
            if (!this.process) {
                clearInterval(this.loginPollInterval);
                this.loginPollInterval = null;
                return;
            }

            try {
                const result = await this.apiCall('GET', '/login');
                if (result && result.login_url) {
                    if (this.loginUrl !== result.login_url) {
                        this.loginUrl = result.login_url;
                        console.log(`🔗 OAuth URL ready: ${this.loginUrl}`);
                    }
                } else {
                    // No login URL means already authenticated
                    if (this.loginUrl) {
                        this.loginUrl = null;
                        console.log('✅ go-librespot is authenticated!');
                        if (!this.monitoring) {
                            setTimeout(() => this.startPlayback(), 2000);
                        }
                    }
                    // Stop polling once authenticated
                    clearInterval(this.loginPollInterval);
                    this.loginPollInterval = null;
                }
            } catch {
                // API not ready yet, keep polling
            }
        }, 3000);
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
