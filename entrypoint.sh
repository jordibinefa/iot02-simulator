#!/bin/bash
set -e

export DISPLAY=:99
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &
echo "[entrypoint] Xvfb started on :99"
sleep 1

if [ "${ENABLE_VNC:-false}" = "true" ]; then
    x11vnc -display :99 -forever -nopw -shared -rfbport 5900 &
    echo "[entrypoint] x11vnc on port 5900"
fi

echo "[entrypoint] ROM files:"
ls -la /app/qemu-rom/ 2>/dev/null || echo "  No ROM files"

echo "[entrypoint] Starting Node.js..."
exec node server.js
