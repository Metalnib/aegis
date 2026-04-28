#!/bin/bash
# Dev: symlink sibling dotnet-episteme-skills into ./skills for local runs
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SOURCE="$REPO_ROOT/../dotnet-episteme-skills/skills"
TARGET="$REPO_ROOT/skills"

if [ ! -d "$SOURCE" ]; then
  echo "ERROR: dotnet-episteme-skills not found at $SOURCE"
  echo "Clone it as a sibling of this repo."
  exit 1
fi

if [ -L "$TARGET" ]; then
  echo "skills/ symlink already exists"
else
  ln -s "$SOURCE" "$TARGET"
  echo "Linked $SOURCE -> $TARGET"
fi
