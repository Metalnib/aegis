#!/bin/bash
# Dev: build Synopsis linux-x64 binary from sibling repo and copy to ./bin/
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SYNOPSIS_SRC="$REPO_ROOT/../dotnet-episteme-skills/src/synopsis"

if [ ! -d "$SYNOPSIS_SRC" ]; then
  echo "ERROR: Synopsis source not found at $SYNOPSIS_SRC"
  exit 1
fi

RID="${1:-osx-arm64}"
echo "Building Synopsis for $RID..."
dotnet publish "$SYNOPSIS_SRC/Synopsis/Synopsis.csproj" \
  -c Release -r "$RID" --self-contained true \
  -o "$REPO_ROOT/bin/synopsis"

echo "Done: $REPO_ROOT/bin/synopsis/synopsis"
