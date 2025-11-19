# Docker Deployment Guide

## Prerequisites
- Docker installed on your system
- `.env` files in place:
  - `backend/.env` - Backend environment variables
  - `frontend/.env` - Frontend environment variables (for build)
  - `gcp-credentials_bkp.json` - Google Cloud credentials (in root directory)

## Build the Docker Image

```bash
docker compose build
```

This will:
1. Build the frontend (React/Vite) with environment variables
2. Set up the Python backend
3. Create a production image with nginx and Flask

## Run the Container

### Start the Service
```bash
docker compose up -d
```

### Start with Logs Visible
```bash
docker compose up
```

### Stop the Service
```bash
docker compose down
```

### Restart the Service
```bash
docker compose restart
```

### Rebuild and Start
```bash
docker compose up -d --build
```

## Access the Application

Once running, access the application at:
- **Frontend**: `http://localhost` (or `http://phonex.indika.ai` if DNS is configured)
- **API Health Check**: `http://localhost/api/health`

## Useful Docker Commands

### View Logs
```bash
# All logs
docker compose logs

# Follow logs in real-time
docker compose logs -f

# Flask backend logs only
docker compose exec app tail -f /var/log/supervisor/flask.out.log

# Nginx logs only
docker compose exec app tail -f /var/log/supervisor/nginx.out.log
```

### Stop the Service
```bash
docker compose stop
```

### Start the Service
```bash
docker compose start
```

### Remove the Container
```bash
docker compose down
```

### Restart the Service
```bash
docker compose restart
```

### Execute Commands Inside Container
```bash
# Open a shell
docker compose exec app bash

# Check environment variables
docker compose exec app env

# Check if services are running
docker compose exec app supervisorctl status
```

## Troubleshooting

### Check Container Status
```bash
docker compose ps
```

### Check Health
```bash
docker compose exec app wget -q -O- http://localhost/api/health
```

### Rebuild After Changes
```bash
# Rebuild and restart
docker compose up -d --build
```

## Production Deployment

For production on `phonex.indika.ai`:

1. **Build the image**:
   ```bash
   docker compose build
   ```

2. **Run with production settings**:
   ```bash
   docker compose up -d
   ```

3. **Set up SSL/HTTPS** (recommended):
   - Use a reverse proxy like nginx or Caddy
   - Or use Cloudflare for SSL termination
   - Or configure Let's Encrypt certificates

## Environment Variables

The container automatically loads variables from `backend/.env`. You can also override them in `docker-compose.yml`:

```yaml
environment:
  - MONGODB_URI=your-mongodb-uri
  - S3_BUCKET_NAME=your-bucket
  - FLASK_PORT=5002
```

Or use an `.env` file at the root (docker-compose will automatically load it):
```bash
# Create .env file in project root
echo "FLASK_PORT=5002" >> .env
```

## Notes

- The frontend is built during the Docker build process
- Backend runs on port 5002 inside the container (proxied by nginx)
- Nginx serves the frontend and proxies `/api/*` requests to Flask
- Both services are managed by supervisord
- Health check runs every 30 seconds

