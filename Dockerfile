FROM node:20-slim

# Install system ffmpeg and download utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the latest yt-dlp binary
RUN curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" \
        -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# Create non-root user with UID 1000 (required by HF Spaces)
RUN useradd -m -u 1000 -s /bin/bash user

WORKDIR /app

# Install dependencies first for better layer caching
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

# Copy application source
COPY backend/src ./src

# Pre-create runtime directories and transfer ownership to the app user
RUN mkdir -p tmp bin && chown -R user:user /app

USER user

ENV PORT=7860 \
    NODE_ENV=production \
    YT_DLP_PATH=/usr/local/bin/yt-dlp

EXPOSE 7860

CMD ["node", "src/server.js"]
