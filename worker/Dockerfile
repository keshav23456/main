# worker/Dockerfile
FROM python:3.10-slim

# Install system dependencies for Manim
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libcairo2-dev \
    libpango1.0-dev \
    pkg-config \
    python3-dev \
    gcc \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY src/ ./src/

# Create directories
RUN mkdir -p /app/videos /tmp/manim_media

# Health check
HEALTHCHECK --interval=60s --timeout=30s --start-period=10s --retries=3 \
  CMD python -c "import redis; r=redis.Redis(host='redis'); r.ping()" || exit 1

# Start the worker
CMD ["python", "src/worker.py"]