#!/bin/bash

# Audio Transcription App Deployment Script
# This script builds and deploys the application using Docker Compose

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
CONTAINER_NAME="audio-transcription"
HEALTH_CHECK_URL="http://localhost:5002/api/health"
HEALTH_CHECK_MAX_RETRIES=30
HEALTH_CHECK_INTERVAL=5

# Function to print colored messages
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check prerequisites
check_prerequisites() {
    print_info "Checking prerequisites..."
    
    local missing_deps=()
    
    if ! command_exists docker; then
        missing_deps+=("docker")
    fi
    
    if ! command_exists docker-compose; then
        # Try docker compose (newer version)
        if ! docker compose version >/dev/null 2>&1; then
            missing_deps+=("docker-compose or 'docker compose'")
        fi
    fi
    
    if [ ${#missing_deps[@]} -ne 0 ]; then
        print_error "Missing required dependencies: ${missing_deps[*]}"
        print_error "Please install Docker and Docker Compose before deploying."
        exit 1
    fi
    
    # Check if Docker daemon is running
    if ! docker info >/dev/null 2>&1; then
        print_error "Docker daemon is not running. Please start Docker and try again."
        exit 1
    fi
    
    print_success "All prerequisites met"
}

# Function to check required files
check_required_files() {
    print_info "Checking required files..."
    
    local missing_files=()
    
    # Check backend .env file
    if [ ! -f "backend/.env" ]; then
        missing_files+=("backend/.env")
    fi
    
    # Check frontend .env file (optional but recommended)
    if [ ! -f "frontend/.env" ]; then
        print_warning "frontend/.env not found (optional but recommended for build-time variables)"
    fi
    
    # Check GCP credentials
    if [ ! -f "gcp-credentials_bkp.json" ]; then
        print_warning "gcp-credentials_bkp.json not found (required for Google Cloud services)"
    fi
    
    if [ ${#missing_files[@]} -ne 0 ]; then
        print_error "Missing required files: ${missing_files[*]}"
        print_error "Please create these files before deploying."
        exit 1
    fi
    
    print_success "Required files present"
}

# Function to stop existing containers
stop_existing_containers() {
    print_info "Stopping existing containers..."
    
    # Use docker compose if available, otherwise docker-compose
    if docker compose version >/dev/null 2>&1; then
        docker compose down 2>/dev/null || true
    else
        docker-compose down 2>/dev/null || true
    fi
    
    # Also try to stop by container name (in case docker-compose wasn't used)
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        print_info "Stopping container: ${CONTAINER_NAME}"
        docker stop "${CONTAINER_NAME}" 2>/dev/null || true
        docker rm "${CONTAINER_NAME}" 2>/dev/null || true
    fi
    
    print_success "Existing containers stopped"
}

# Function to build Docker image
build_image() {
    print_info "Building Docker image..."
    
    if docker compose version >/dev/null 2>&1; then
        docker compose build
    else
        docker-compose build
    fi
    
    if [ $? -eq 0 ]; then
        print_success "Docker image built successfully"
    else
        print_error "Failed to build Docker image"
        exit 1
    fi
}

# Function to start containers
start_containers() {
    print_info "Starting containers..."
    
    if docker compose version >/dev/null 2>&1; then
        docker compose up -d
    else
        docker-compose up -d
    fi
    
    if [ $? -eq 0 ]; then
        print_success "Containers started successfully"
    else
        print_error "Failed to start containers"
        exit 1
    fi
}

# Function to wait for health check
wait_for_health() {
    print_info "Waiting for application to be healthy..."
    
    local retries=0
    local health_ok=false
    
    while [ $retries -lt $HEALTH_CHECK_MAX_RETRIES ]; do
        if curl -f -s "${HEALTH_CHECK_URL}" >/dev/null 2>&1; then
            health_ok=true
            break
        fi
        
        retries=$((retries + 1))
        if [ $retries -lt $HEALTH_CHECK_MAX_RETRIES ]; then
            echo -n "."
            sleep $HEALTH_CHECK_INTERVAL
        fi
    done
    
    echo ""  # New line after dots
    
    if [ "$health_ok" = true ]; then
        print_success "Application is healthy and ready"
        return 0
    else
        print_warning "Health check did not pass after ${HEALTH_CHECK_MAX_RETRIES} retries"
        print_warning "The application may still be starting. Check logs with: docker compose logs"
        return 1
    fi
}

# Function to show container status
show_status() {
    print_info "Container status:"
    
    if docker compose version >/dev/null 2>&1; then
        docker compose ps
    else
        docker-compose ps
    fi
    
    echo ""
    print_info "Recent logs (last 20 lines):"
    if docker compose version >/dev/null 2>&1; then
        docker compose logs --tail=20
    else
        docker-compose logs --tail=20
    fi
}

# Main deployment function
main() {
    echo ""
    print_info "========================================="
    print_info "Audio Transcription App Deployment"
    print_info "========================================="
    echo ""
    
    # Parse command line arguments
    SKIP_BUILD=false
    SKIP_HEALTH_CHECK=false
    FOLLOW_LOGS=false
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --skip-build)
                SKIP_BUILD=true
                shift
                ;;
            --skip-health-check)
                SKIP_HEALTH_CHECK=true
                shift
                ;;
            --follow-logs)
                FOLLOW_LOGS=true
                shift
                ;;
            --help|-h)
                echo "Usage: $0 [OPTIONS]"
                echo ""
                echo "Options:"
                echo "  --skip-build          Skip building the Docker image"
                echo "  --skip-health-check   Skip waiting for health check"
                echo "  --follow-logs         Follow logs after deployment"
                echo "  --help, -h            Show this help message"
                echo ""
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                echo "Use --help for usage information"
                exit 1
                ;;
        esac
    done
    
    # Run deployment steps
    check_prerequisites
    check_required_files
    stop_existing_containers
    
    if [ "$SKIP_BUILD" = false ]; then
        build_image
    else
        print_warning "Skipping build step"
    fi
    
    start_containers
    
    if [ "$SKIP_HEALTH_CHECK" = false ]; then
        wait_for_health
    else
        print_warning "Skipping health check"
    fi
    
    show_status
    
    echo ""
    print_success "========================================="
    print_success "Deployment completed!"
    print_success "========================================="
    echo ""
    print_info "Application URL: http://localhost:5002"
    print_info "Health check: ${HEALTH_CHECK_URL}"
    echo ""
    print_info "Useful commands:"
    echo "  View logs:        docker compose logs -f"
    echo "  Stop service:     docker compose down"
    echo "  Restart service:  docker compose restart"
    echo "  Check status:     docker compose ps"
    echo ""
    
    if [ "$FOLLOW_LOGS" = true ]; then
        print_info "Following logs (Ctrl+C to exit)..."
        if docker compose version >/dev/null 2>&1; then
            docker compose logs -f
        else
            docker-compose logs -f
        fi
    fi
}

# Run main function
main "$@"

