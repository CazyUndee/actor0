#!/bin/bash
# Build the web UI and agent bundle for local development.
set -e
cd "$(dirname "$0")/../"
npm run build
npm run build:agent
echo "Build complete. resources/neu/agent.bundle.mjs ready."
