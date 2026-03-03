const SpotifyWebApi = require('spotify-web-api-node');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '..', 'tokens.json');

const SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative',
    'streaming'
];

class SpotifyAuth {
    constructor() {
        this.api = new SpotifyWebApi({
            clientId: process.env.SPOTIFY_CLIENT_ID,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
            redirectUri: process.env.REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/callback`
        });
        this.authenticated = false;
        this.refreshTimer = null;
    }

    getAuthUrl() {
        return this.api.createAuthorizeURL(SCOPES, 'spotify-bot-auth');
    }

    async handleCallback(code) {
        const data = await this.api.authorizationCodeGrant(code);
        this.api.setAccessToken(data.body.access_token);
        this.api.setRefreshToken(data.body.refresh_token);
        this.authenticated = true;

        this.saveTokens(data.body);
        this.scheduleRefresh(data.body.expires_in);

        return data.body;
    }

    saveTokens(tokenData) {
        const data = {
            access_token: tokenData.access_token || this.api.getAccessToken(),
            refresh_token: tokenData.refresh_token || this.api.getRefreshToken(),
            saved_at: new Date().toISOString()
        };
        try {
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2));
            console.log('💾 Tokens saved');
        } catch (err) {
            console.error('Failed to save tokens:', err.message);
        }
    }

    async tryRestoreSession() {
        try {
            if (!fs.existsSync(TOKEN_PATH)) return false;

            const data = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
            if (!data.refresh_token) return false;

            this.api.setRefreshToken(data.refresh_token);

            // Always refresh token on startup
            const refreshed = await this.api.refreshAccessToken();
            this.api.setAccessToken(refreshed.body.access_token);
            this.authenticated = true;

            this.saveTokens({
                access_token: refreshed.body.access_token,
                refresh_token: data.refresh_token
            });
            this.scheduleRefresh(refreshed.body.expires_in);

            return true;
        } catch (err) {
            console.error('Failed to restore session:', err.message);
            return false;
        }
    }

    scheduleRefresh(expiresIn) {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);

        // Refresh 5 minutes before expiry
        const refreshMs = Math.max((expiresIn - 300) * 1000, 60000);
        console.log(`🔄 Token refresh scheduled in ${Math.round(refreshMs / 60000)} minutes`);

        this.refreshTimer = setTimeout(async () => {
            try {
                const data = await this.api.refreshAccessToken();
                this.api.setAccessToken(data.body.access_token);
                this.saveTokens({
                    access_token: data.body.access_token,
                    refresh_token: this.api.getRefreshToken()
                });
                this.scheduleRefresh(data.body.expires_in);
                console.log('🔄 Token refreshed successfully');
            } catch (err) {
                console.error('❌ Token refresh failed:', err.message);
                this.authenticated = false;
                // Retry in 1 minute
                setTimeout(() => this.scheduleRefresh(360), 60000);
            }
        }, refreshMs);
    }

    getApi() {
        return this.api;
    }

    isAuthenticated() {
        return this.authenticated;
    }

    /**
     * Search for tracks. Returns sanitized results with NO sensitive data.
     */
    async searchTracks(query, limit = 10) {
        if (!this.authenticated) throw new Error('Not authenticated');
        const result = await this.api.searchTracks(query, { limit });
        return result.body.tracks.items.map(track => ({
            uri: track.uri,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            album: track.album.name,
            albumArt: track.album.images.length > 0 ? track.album.images[0].url : null,
            duration: track.duration_ms
        }));
    }
}

module.exports = SpotifyAuth;
