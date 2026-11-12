#!/bin/bash
# Development entry point for actor0-desktop.
# Runs the Vite dev server + Neutralino together.

set -e

cd "$(dirname "$0")/../"

# Start the Vite dev server
npm run dev &
VITE_PID=$!

# Wait for the dev server to be ready
for i in {1..30}; do
  if curl -s http://127.0.0.1:5174 > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Run Neutralino
npx neu run --config neutralino.windows.json

# Cleanup
kill $VITE_PID 2>/dev/null || true
