#!/usr/bin/env bash
# Safe CI / deploy install: skip lifecycle scripts (ChainDrop/Shai-Hulud preinstall),
# then rebuild only the packages that need native bindings or binary downloads.
set -euo pipefail

npm ci --ignore-scripts --no-audit --no-fund

# bcrypt/sharp compile native addons; ffmpeg-static and geoip-lite download data/binaries.
npm rebuild bcrypt sharp ffmpeg-static geoip-lite

npx prisma generate
