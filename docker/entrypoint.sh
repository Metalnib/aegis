#!/bin/sh
set -e

CONFIG_PATH="${AEGIS_CONFIG:-/aegis/aegis.config.js}"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "[aegis] ERROR: config not found at $CONFIG_PATH"
  echo "[aegis] Mount your aegis.config.js and set AEGIS_CONFIG if needed."
  exit 1
fi

mkdir -p /var/lib/aegis /var/run/aegis /workspace

echo "[aegis] starting with config: $CONFIG_PATH"
exec node /aegis/packages/cli/dist/bin.js serve "$CONFIG_PATH"
