#!/bin/bash
set -e

if [ -n "$TAILSCALE_AUTHKEY" ]; then
  echo "Starting Tailscale..."
  # Userspace networking avoids needing NET_ADMIN capability in Cloud Run
  tailscaled --state=mem: --tun=userspace-networking --socks5-server=localhost:1055 &
  sleep 3
  tailscale up \
    --authkey="${TAILSCALE_AUTHKEY}" \
    --hostname="${TAILSCALE_HOSTNAME:-farm-monitor}" \
    --accept-routes \
    --ephemeral \
    2>&1 | head -5
  echo "Tailscale up"
else
  echo "TAILSCALE_AUTHKEY not set — skipping Tailscale (direct IP mode)"
fi

exec node server.js
