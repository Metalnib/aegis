#!/bin/sh
# Check that the aegis node process is running
pgrep -f "bin.js serve" > /dev/null 2>&1 || exit 1

# Check that the synopsis socket exists (daemon is up)
SOCK="${SYNOPSIS_SOCK:-/var/run/aegis/synopsis.sock}"
[ -S "$SOCK" ] || exit 1

exit 0
