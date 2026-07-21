#!/bin/bash
#
# Double-click this file in Finder to run the Haddy demo locally and open it in
# your browser.
#
# The demo can't be opened straight from Finder (a file:// page can't load the
# 3D engine or fetch its data). This serves it over HTTP — which fixes that —
# so you can view it and iterate: edit files, then just refresh the browser.
#
#     Access code:  haddy   (remembered until you close the tab)
#
# Keep this Terminal window open while working. Press Ctrl-C (or close the
# window) to stop the server.

cd "$(dirname "$0")/web" || exit 1

PORT=8000
URL="http://localhost:$PORT/?p=rockwork"

# If a server is already running on that port, just open the browser and stop.
if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
  echo "Server already running — opening $URL"
  open "$URL"
  exit 0
fi

echo "─────────────────────────────────────────"
echo "  Haddy demo  →  $URL"
echo "  Access code:  haddy"
echo "  Ctrl-C to stop."
echo "─────────────────────────────────────────"

# Open the browser as soon as the server starts responding.
(
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
      open "$URL"; break
    fi
    sleep 0.25
  done
) &

# Serve web/ over HTTP. python3 ships with macOS.
exec python3 -m http.server "$PORT"
