#!/bin/sh
# LaunchAgent wrapper: sources bridge.env (600, never committed), then runs the bridge.
set -eu
cd "$(dirname "$0")"
if [ -f ./bridge.env ]; then
  . ./bridge.env
fi
exec /opt/homebrew/opt/node/bin/node index.js
