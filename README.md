# TubeVault

TubeVault is a production-ready YouTube video and audio downloader with a Vercel-friendly frontend and a Render-friendly backend. The frontend is built with React + Vite, and the API uses Express, `yt-dlp`, and `ffmpeg` to fetch metadata and generate MP4 or MP3 downloads without storing user data.

## Folder structure

```text
.
|-- backend
|   |-- .env.example
|   |-- package-lock.json
|   |-- package.json
|   `-- src
|       |-- app.js
|       |-- config.js
|       |-- server.js
|       |-- middleware
|       |   `-- errorHandler.js
|       |-- services
|       |   |-- downloadService.js
|       |   |-- videoService.js
|       |   `-- ytdlpService.js
|       `-- utils
|           |-- asyncHandler.js
|           |-- formatters.js
|           |-- httpError.js
|           |-- sanitizeFilename.js
|           `-- validateYouTubeUrl.js
|-- frontend
|   |-- .env.example
|   |-- index.html
|   |-- package-lock.json
|   |-- package.json
|   |-- vite.config.js
|   `-- src
|       |-- App.jsx
|       |-- main.jsx
|       `-- styles.css
|-- .gitignore
|-- README.md
`-- render.yaml
```

## Features

- Paste a YouTube URL and fetch the video title, thumbnail, and duration.
- Browse downloadable MP4 quality options by resolution.
- Download high-quality MP3 audio with a one-click quick action.
- See processing and transfer progress in the UI.
- Copy the video title instantly.
- Use a responsive UI with dark mode and toast notifications.
- Rely on backend rate limiting and YouTube URL validation.
- Avoid accounts, databases, and user data storage.

## Local setup

### Backend

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

Set these values in `backend/.env`:

```env
PORT=3000
CORS_ORIGIN=http://localhost:5173
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=25
MAX_VIDEO_DURATION_SECONDS=14400
```

On first boot, the API downloads the correct official `yt-dlp` binary into `backend/bin/`. `ffmpeg-static` is bundled through npm, so you do not need to install ffmpeg manually for local development or Render.

### Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Set this value in `frontend/.env`:

```env
VITE_API_BASE_URL=http://localhost:3000
```

Open `http://localhost:5173`.

## API

`GET /api/info?url=` returns normalized video metadata plus available download formats.

`GET /api/download?url=&format=` generates and returns the requested file as an attachment.

Examples:

```text
GET /api/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
GET /api/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=video-720
GET /api/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=audio-mp3
```

## Deploy frontend to Vercel

1. Push this repository to GitHub, GitLab, or Bitbucket.
2. In Vercel, create a new project from the repo.
3. Set the project root directory to `frontend`.
4. Vercel should detect Vite automatically.
5. Add the environment variable `VITE_API_BASE_URL` and set it to your Render backend URL, for example `https://tubevault-api.onrender.com`.
6. Deploy the project.
7. After the first deploy, note your Vercel domain because you will use it as the backend `CORS_ORIGIN`.

Recommended Vercel settings:

- Framework preset: `Vite`
- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

## Deploy backend to Render

You can deploy either from the dashboard or by using the included `render.yaml`.

### Option A: Render dashboard

1. Create a new Web Service in Render from the same repository.
2. Set the root directory to `backend`.
3. Use `npm install` as the build command.
4. Use `npm start` as the start command.
5. Add these environment variables:

```env
PORT=10000
CORS_ORIGIN=https://your-vercel-frontend.vercel.app
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=25
MAX_VIDEO_DURATION_SECONDS=14400
```

6. Deploy the service.
7. Copy the Render public URL into the frontend `VITE_API_BASE_URL` setting on Vercel.

### Option B: Render Blueprint

1. In Render, choose Blueprint deployment.
2. Point it to this repository.
3. Render will read the root `render.yaml`.
4. After the service is created, set `CORS_ORIGIN` to your Vercel production domain.

## Abuse prevention and security notes

- Only YouTube URLs are accepted.
- Requests are rate-limited with `express-rate-limit`.
- The app does not store user data, cookies, or download history.
- Downloads are written to a temporary folder and deleted immediately after being streamed to the client.
- Set a strict `CORS_ORIGIN` in production.
- If you want stronger abuse protection, place the Render service behind Cloudflare or add a captcha flow on the frontend.

## Production checklist

- Set the final Vercel domain in `CORS_ORIGIN`.
- Keep Render and Vercel environment variables in sync.
- Monitor Render logs for `yt-dlp` download/update failures.
- If you want pinned binaries, set `YT_DLP_PATH` to a pre-provisioned binary and skip auto-downloads.
