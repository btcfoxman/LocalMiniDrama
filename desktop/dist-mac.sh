#!/bin/bash
# macOS packaging script.
# Usage: run `bash dist-mac.sh` from the desktop directory.

set -e

export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://cdn.npmmirror.com/binaries/electron-builder-binaries/"
export CSC_IDENTITY_AUTO_DISCOVERY=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "========== Build standard package =========="
echo ""

npm run prepare-backend
npm run build:front
npm run copy-front
npx electron-builder --mac --config electron-builder-mac.json

echo ""
echo "========== Build completed =========="
echo "Output directory: release/"
echo "  Intel: OverseasDrama-x.x.x-mac-x64.dmg"
echo "  ARM: OverseasDrama-x.x.x-mac-arm64.dmg"
echo ""
