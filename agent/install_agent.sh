#!/bin/bash
# Install the Farm Monitor metrics agent as a systemd service.
# Run as root on each compute node:
#   sudo bash install_agent.sh [port]

set -e

AGENT_PORT="${1:-19999}"
INSTALL_DIR="/opt/farm-monitor-agent"
SERVICE_NAME="farm-monitor-agent"

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: run as root (sudo bash install_agent.sh)"
  exit 1
fi

echo "==> Installing Farm Monitor Agent (port $AGENT_PORT)"

# Python3 check
if ! command -v python3 &>/dev/null; then
  echo "Error: python3 not found. Install it first."
  exit 1
fi

# Install psutil
echo "==> Installing psutil..."
pip3 install --quiet psutil

# Copy agent
mkdir -p "$INSTALL_DIR"
cp "$(dirname "$0")/metrics_agent.py" "$INSTALL_DIR/"
chmod 644 "$INSTALL_DIR/metrics_agent.py"

# Create systemd unit
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Farm Monitor Metrics Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nobody
ExecStart=/usr/bin/python3 ${INSTALL_DIR}/metrics_agent.py
Environment=AGENT_PORT=${AGENT_PORT}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 2
systemctl status "$SERVICE_NAME" --no-pager -l

echo ""
echo "==> Agent running on port $AGENT_PORT"
echo "    Test: curl http://localhost:$AGENT_PORT/metrics | python3 -m json.tool | head -30"
