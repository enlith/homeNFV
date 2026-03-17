#!/bin/bash
set -e

# Environment variables with defaults
HOMENFV_LISTEN_ADDR="${HOMENFV_LISTEN_ADDR:-0.0.0.0:8787}"
HOMENFV_STORAGE_ROOT="${HOMENFV_STORAGE_ROOT:-/app/storage}"

echo "============================================"
echo "  HomeNFV Demo Agent Starting"
echo "============================================"
echo "Listen Address: $HOMENFV_LISTEN_ADDR"
echo "Storage Root: $HOMENFV_STORAGE_ROOT"
echo "Shared Secret: ${HOMENFV_SHARED_SECRET:+[SET]}"
echo "Worker URL: ${HOMENFV_WORKER_URL:-[NOT SET]}"
echo "============================================"

# Create storage directory if it doesn't exist
mkdir -p "$HOMENFV_STORAGE_ROOT"

# Function to cleanup on exit
cleanup() {
    echo "Shutting down..."
    if [ -n "$AGENT_PID" ]; then
        kill "$AGENT_PID" 2>/dev/null || true
    fi
    if [ -n "$TUNNEL_PID" ]; then
        kill "$TUNNEL_PID" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup TERM INT

# Start the agent in background
echo "Starting HomeNFV agent..."
/usr/local/bin/homenfv-agent 2>&1 | tee /app/logs/agent.log &
AGENT_PID=$!
echo "Agent PID: $AGENT_PID"

# Wait for agent to be ready
echo "Waiting for agent to be ready..."
for i in $(seq 1 60); do
    # Check if agent process is still running
    if ! kill -0 "$AGENT_PID" 2>/dev/null; then
        echo "✗ Agent process crashed! PID $AGENT_PID no longer exists"
        echo "=== Agent Logs ==="
        cat /app/logs/agent.log 2>/dev/null || echo "No agent logs found"
        echo "=== Process Status ==="
        ps aux | grep homenfv-agent || true
        exit 1
    fi

    if curl -sf "http://127.0.0.1:8787/health" > /dev/null 2>&1; then
        echo "✓ Agent is ready (PID: $AGENT_PID)"
        break
    fi
    echo "  Health check attempt $i/60... (PID: $AGENT_PID)"
    if [ $i -eq 60 ]; then
        echo "✗ Agent failed to respond after 60 attempts"
        echo "=== Agent Logs ==="
        cat /app/logs/agent.log 2>/dev/null || echo "No agent logs found"
        echo "=== Process Status ==="
        ps aux | grep homenfv-agent || true
        echo "=== Network Status ==="
        netstat -tlnp | grep :8787 || true
        echo "=== Testing direct connection ==="
        curl -v "http://127.0.0.1:8787/health" || true
        exit 1
    fi
    sleep 2
done

# Start cloudflared tunnel if not running in "agent-only" mode
if [ "${START_TUNNEL:-true}" = "true" ]; then
    echo "Starting cloudflared tunnel..."
    cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate > /app/logs/tunnel.log 2>&1 &
    TUNNEL_PID=$!

    # Wait for tunnel URL
    echo "Waiting for tunnel URL..."
    for i in $(seq 1 60); do
        TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /app/logs/tunnel.log 2>/dev/null | head -1)
        if [ -n "$TUNNEL_URL" ]; then
            echo "✓ Tunnel ready: $TUNNEL_URL"
            echo "$TUNNEL_URL" > /app/tunnel-url
            break
        fi
        if [ $i -eq 60 ]; then
            echo "✗ Failed to get tunnel URL"
            cat /app/logs/tunnel.log
            exit 1
        fi
        sleep 2
    done
fi

echo "============================================"
echo "  HomeNFV Demo Agent Ready!"
echo "============================================"
if [ -n "$TUNNEL_URL" ]; then
    echo "Tunnel URL: $TUNNEL_URL"
fi
echo "Agent running on: $HOMENFV_LISTEN_ADDR"
echo "Storage: $HOMENFV_STORAGE_ROOT"
echo "============================================"

# Wait for processes
wait