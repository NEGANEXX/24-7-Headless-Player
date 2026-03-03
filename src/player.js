const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = '/app/cache';

class Player {
    constructor(spotifyAuth) {
        this.auth = spotifyAuth;
        this.librespotProcess = null;
        this.monitoring = false;
        this.monitorInterval = null;
        this.deviceName = process.env.DEVICE_NAME || 'SpotifyBot-24-7';
        this.playlistUri = process.env.PLAYLIST_URI;
        this.retryCount = 0;
        this.maxRetries = 50;
        this.oauthUrl = null; // OAuth URL captured from librespot output
        this.librespotReady = false;

        // Ensure cache directory exists
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }

        // Start librespot on construction
        this.startLibrespot();
    }

    startLibrespot() {
        const args = [
            '--name', this.deviceName,
            '--backend', 'pipe',
            '--initial-volume', '100',
            '--device-type', 'computer',
            '--bitrate', '160',
            '--enable-volume-normalisation',
            '--cache', CACHE_DIR
        ];

        console.log(`🔊 Starting librespot as "${this.deviceName}"...`);

        this.librespotProcess = spawn('librespot', args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Drain stdout (pipe backend outputs raw audio data here)
        this.librespotProcess.stdout.resume();

        this.librespotProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                // Capture OAuth URL if librespot outputs one
                const urlMatch = msg.match(/(https?:\/\/accounts\.spotify\.com\S+)/);
                if (urlMatch) {
                    this.oauthUrl = urlMatch[1];
                    console.log(`🔗 Librespot OAuth URL: ${this.oauthUrl}`);
                }

                // Detect when librespot is authenticated and ready
                if (msg.includes('Authenticated as') || msg.includes('Country:') || msg.includes('Connecting')) {
                    this.librespotReady = true;
                    this.oauthUrl = null; // Clear URL once authenticated
                    this.retryCount = 0;
                    console.log('✅ Librespot authenticated and connected!');
                }

                // Filter out noisy audio data messages, keep important ones
                if (!msg.includes('kBytesPerSample') && !msg.includes('kSamplesPerSecond')) {
                    console.log(`[librespot] ${msg}`);
                }
            }
        });

        this.librespotProcess.on('close', (code) => {
            console.log(`⚠️  librespot exited with code ${code}`);
            this.librespotProcess = null;
            this.librespotReady = false;

            if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                const delay = Math.min(5000 * this.retryCount, 60000);
                console.log(`   Reconnecting in ${delay / 1000}s... (attempt ${this.retryCount}/${this.maxRetries})`);
                setTimeout(() => this.startLibrespot(), delay);
            } else {
                console.error('❌ Max reconnection attempts reached for librespot.');
            }
        });

        this.librespotProcess.on('error', (err) => {
            if (err.code === 'ENOENT') {
                console.error('❌ librespot binary not found. Make sure it is installed and in PATH.');
            } else {
                console.error(`❌ librespot error: ${err.message}`);
            }
        });
    }

    async findDevice() {
        const api = this.auth.getApi();
        const devices = await api.getMyDevices();
        return devices.body.devices.find(d =>
            d.name === this.deviceName || d.name.includes('SpotifyBot')
        );
    }

    parsePlaylistUri(input) {
        if (!input) return null;

        // Already a Spotify URI
        if (input.startsWith('spotify:playlist:')) return input;

        // Spotify URL — extract playlist ID
        const match = input.match(/playlist\/([a-zA-Z0-9]+)/);
        if (match) return `spotify:playlist:${match[1]}`;

        // Assume it's just the playlist ID
        return `spotify:playlist:${input}`;
    }

    async startPlayback() {
        if (!this.auth.isAuthenticated()) {
            console.log('⚠️  Not authenticated. Please login via the dashboard first.');
            return false;
        }

        if (!this.playlistUri) {
            console.log('⚠️  PLAYLIST_URI not set. Set it as an environment variable.');
            return false;
        }

        const contextUri = this.parsePlaylistUri(this.playlistUri);
        if (!contextUri) {
            console.log('❌ Invalid playlist URI:', this.playlistUri);
            return false;
        }

        try {
            // Wait for the librespot device to appear
            let device = null;
            for (let i = 0; i < 15; i++) {
                device = await this.findDevice();
                if (device) break;
                console.log(`⏳ Waiting for device "${this.deviceName}"... (${i + 1}/15)`);
                await this.sleep(3000);
            }

            if (!device) {
                console.log('❌ Device not found after 45 seconds.');
                console.log('   Make sure SPOTIFY_USERNAME and SPOTIFY_PASSWORD are correct.');
                console.log('   If you use Google/Facebook login, set a device password at:');
                console.log('   https://www.spotify.com/account/set-device-password/');
                return false;
            }

            console.log(`✅ Found device: ${device.name} (${device.id})`);

            const api = this.auth.getApi();

            // Transfer playback to our device
            await api.transferMyPlayback([device.id], { play: false });
            await this.sleep(1500);

            // Start the playlist
            await api.play({
                device_id: device.id,
                context_uri: contextUri
            });
            console.log(`🎶 Started playlist: ${contextUri}`);

            // Set repeat mode (repeat the whole playlist)
            await this.sleep(500);
            await api.setRepeat('context', { device_id: device.id });
            console.log('🔁 Repeat: ON');

            // Set shuffle on
            await this.sleep(500);
            await api.setShuffle(true, { device_id: device.id });
            console.log('🔀 Shuffle: ON');

            // Reset retry counter on successful playback
            this.retryCount = 0;

            // Start the monitoring loop
            this.startMonitoring();
            return true;
        } catch (err) {
            console.error('❌ Playback error:', err.message);
            if (err.statusCode === 404) {
                console.log('   Device may have disconnected. Retrying in 30s...');
            }
            setTimeout(() => this.startPlayback(), 30000);
            return false;
        }
    }

    startMonitoring() {
        if (this.monitoring) return;
        this.monitoring = true;

        console.log('👁️  Playback monitor started (checking every 30 seconds)');

        this.monitorInterval = setInterval(async () => {
            try {
                if (!this.auth.isAuthenticated()) return;

                const api = this.auth.getApi();
                const playback = await api.getMyCurrentPlaybackState();

                if (!playback.body || !playback.body.is_playing) {
                    console.log('⚠️  Playback stopped! Restarting...');
                    this.monitoring = false;
                    clearInterval(this.monitorInterval);
                    this.monitorInterval = null;
                    await this.startPlayback();
                } else {
                    const track = playback.body.item;
                    if (track) {
                        const artists = track.artists.map(a => a.name).join(', ');
                        const progress = this.formatTime(playback.body.progress_ms);
                        const duration = this.formatTime(track.duration_ms);
                        console.log(`🎵 Playing: ${track.name} — ${artists} [${progress}/${duration}]`);
                    }
                }
            } catch (err) {
                console.error('Monitor check error:', err.message);
            }
        }, 30000);
    }

    async getStatus() {
        const status = {
            authenticated: this.auth.isAuthenticated(),
            librespotRunning: this.librespotProcess !== null && !this.librespotProcess.killed,
            librespotReady: this.librespotReady,
            oauthUrl: this.oauthUrl,
            monitoring: this.monitoring,
            deviceName: this.deviceName,
            playlistUri: this.playlistUri,
            playing: false,
            currentTrack: null,
            devices: []
        };

        if (this.auth.isAuthenticated()) {
            try {
                const api = this.auth.getApi();

                // Get current playback
                const playback = await api.getMyCurrentPlaybackState();
                if (playback.body && playback.body.is_playing) {
                    status.playing = true;
                    if (playback.body.item) {
                        status.currentTrack = {
                            name: playback.body.item.name,
                            artist: playback.body.item.artists.map(a => a.name).join(', '),
                            album: playback.body.item.album.name,
                            albumArt: playback.body.item.album.images[0]?.url,
                            progress: playback.body.progress_ms,
                            duration: playback.body.item.duration_ms
                        };
                    }
                }

                // Get devices
                const devices = await api.getMyDevices();
                status.devices = devices.body.devices.map(d => ({
                    name: d.name,
                    type: d.type,
                    active: d.is_active,
                    volume: d.volume_percent
                }));
            } catch (err) {
                status.error = err.message;
            }
        }

        return status;
    }

    formatTime(ms) {
        if (!ms) return '0:00';
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = Player;
