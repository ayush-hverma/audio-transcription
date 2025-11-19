# Multi-stage Dockerfile for Audio Transcription App
# Stage 1: Build Frontend
FROM node:18-alpine AS frontend-builder

WORKDIR /app/frontend

# Copy frontend package files
COPY frontend/package*.json ./

# Install frontend dependencies
RUN npm ci

# Copy frontend .env file for build-time variables
COPY frontend/.env* ./

# Copy frontend source code
COPY frontend/ ./

# Build frontend for production (Vite will use .env variables)
RUN npm run build

# Stage 2: Python Backend Setup
FROM python:3.11-slim AS backend-setup

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend and utility code
COPY backend/ ./backend/
COPY utils/ ./utils/
COPY pipeline/ ./pipeline/

# Stage 3: Final Production Image
FROM python:3.11-slim

# Install system dependencies including nginx and supervisord
RUN apt-get update && apt-get install -y \
    nginx \
    supervisor \
    gcc \
    g++ \
    ffmpeg \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create virtual environment for backend
RUN python3 -m venv /app/venv

# Install Python dependencies in virtual environment
COPY requirements.txt .
RUN /app/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /app/venv/bin/pip install --no-cache-dir -r requirements.txt

# Copy backend code from backend-setup stage
COPY --from=backend-setup /app/backend ./backend
COPY --from=backend-setup /app/utils ./utils
COPY --from=backend-setup /app/pipeline ./pipeline

# Copy backend .env file
COPY backend/.env ./backend/.env

# Copy Google Cloud credentials file from root directory
COPY gcp-credentials_bkp.json ./

# Copy built frontend from builder stage
COPY --from=frontend-builder /app/frontend/dist /usr/share/nginx/html

# Create nginx configuration for phonex.indika.ai
RUN echo 'server { \
    listen 80; \
    server_name phonex.indika.ai; \
    \
    # Serve frontend static files \
    root /usr/share/nginx/html; \
    index index.html; \
    \
    # Proxy API requests to Flask backend \
    location /api { \
        proxy_pass http://localhost:5002; \
        proxy_http_version 1.1; \
        proxy_set_header Upgrade $http_upgrade; \
        proxy_set_header Connection "upgrade"; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; \
        proxy_set_header X-Forwarded-Proto $scheme; \
        proxy_read_timeout 300s; \
        proxy_connect_timeout 75s; \
        client_max_body_size 100M; \
    } \
    \
    # Handle frontend routing (SPA) \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/sites-available/phonex.indika.ai


# Enable only phonex.indika.ai configuration (no default server)
RUN rm -f /etc/nginx/sites-enabled/* && \
    ln -sf /etc/nginx/sites-available/phonex.indika.ai /etc/nginx/sites-enabled/phonex.indika.ai

# Create script to load .env and start Flask
RUN printf '#!/bin/bash\n\
set -a\n\
# Load .env file if it exists\n\
[ -f /app/backend/.env ] && source /app/backend/.env\n\
set +a\n\
# Set default values if not in .env\n\
export PYTHONUNBUFFERED=1\n\
export FLASK_ENV=${FLASK_ENV:-production}\n\
export FLASK_PORT=${FLASK_PORT:-5002}\n\
# Set GOOGLE_APPLICATION_CREDENTIALS if not set and credentials file exists\n\
if [ -z "$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f /app/gcp-credentials_bkp.json ]; then\n\
    export GOOGLE_APPLICATION_CREDENTIALS=/app/gcp-credentials_bkp.json\n\
fi\n\
# Activate virtual environment and run Flask\n\
source /app/venv/bin/activate\n\
cd /app && python /app/backend/backend_api.py\n' > /start-flask.sh && chmod +x /start-flask.sh

# Create supervisord configuration
RUN printf '[supervisord]\n\
nodaemon=true\n\
logfile=/var/log/supervisor/supervisord.log\n\
pidfile=/var/run/supervisord.pid\n\
\n\
[program:nginx]\n\
command=nginx -g "daemon off;"\n\
autostart=true\n\
autorestart=true\n\
stderr_logfile=/var/log/supervisor/nginx.err.log\n\
stdout_logfile=/var/log/supervisor/nginx.out.log\n\
\n\
[program:flask]\n\
command=/start-flask.sh\n\
directory=/app\n\
autostart=true\n\
autorestart=true\n\
stderr_logfile=/var/log/supervisor/flask.err.log\n\
stdout_logfile=/var/log/supervisor/flask.out.log\n' > /etc/supervisor/conf.d/supervisord.conf

# Create necessary directories
RUN mkdir -p /var/log/supervisor /var/run

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost/api/health || exit 1

# Start supervisord which will manage both nginx and Flask
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]

