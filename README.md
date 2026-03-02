# 🎵 Spotify 24/7 Playback Bot

Keeps your Spotify playlist playing 24/7 from a Northflank server using **librespot** as a virtual Spotify Connect device.

## How It Works

1. **librespot** runs on the server and registers as a Spotify Connect device
2. **Node.js app** authenticates via Spotify OAuth2, transfers playback to the device, and starts your playlist
3. **Monitor** checks every 30 seconds — auto-restarts if playback stops

## 🚀 Deploy to Northflank

### Step 1: Push to GitHub

```bash
cd spotify-bot
git init
git add .
git commit -m "Spotify 24/7 bot"
```

Push to a GitHub repository (public or private).

### Step 2: Create Northflank Service

1. Go to your Northflank project → **Services** → **Create Service**
2. Choose **Build & Deploy from Repository**
3. Connect your GitHub repo
4. Under **Build Settings**:
   - Build type: **Dockerfile**
   - Dockerfile path: `./Dockerfile`
5. Under **Resources**:
   - CPU: `0.2 vCPU`
   - Memory: `512 MB`
6. Under **Networking**:
   - Add port: `3000` (HTTP)
   - Enable **Public Gateway** to get a public URL

### Step 3: Set Environment Variables

Go to your service → **Environment** → Add these variables:

| Variable | Value |
|----------|-------|
| `SPOTIFY_CLIENT_ID` | `0bd057d9f2d14e59b0a74fe4822f66d8` |
| `SPOTIFY_CLIENT_SECRET` | Your client secret |
| `SPOTIFY_USERNAME` | Your Spotify email |
| `SPOTIFY_PASSWORD` | Your Spotify password |
| `PLAYLIST_URI` | Your playlist link |
| `REDIRECT_URI` | `https://YOUR-SERVICE-URL/callback` |
| `PORT` | `3000` |

### Step 4: Configure Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Select your app → **Settings**
3. Under **Redirect URIs**, add: `https://YOUR-SERVICE-URL/callback`
4. Save

### Step 5: Login & Start

1. Visit your Northflank service URL
2. Click **Login with Spotify**
3. Authorize the app
4. Playback starts automatically! 🎶

## ⚠️ Notes

- **Spotify Premium required** for playback control
- If you login with Google/Facebook, set a device password at: https://www.spotify.com/account/set-device-password/
- The bot auto-restarts playback if Spotify stops for any reason
- Tokens are persisted — the bot reconnects automatically after restarts
