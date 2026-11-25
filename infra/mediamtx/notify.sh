#!/bin/sh
# Called by MediaMTX runOnReady / runOnNotReady.
# Usage: notify.sh <ready|notReady> <stream_key>
# Reads BACKEND_HOOK_URL and LIVE_HOOK_SECRET from the container environment.
# Secret is sent ONLY via x-live-hook-secret header (never query string or JSON body).
# IMPORTANT: file must use LF line endings (not Windows CRLF) or Alpine will fail with
# "no such file or directory" on the shebang.
set -eu
EVENT="$1"
STREAM_KEY="$2"

if [ -z "${BACKEND_HOOK_URL:-}" ] || [ -z "${LIVE_HOOK_SECRET:-}" ]; then
  echo "notify.sh: BACKEND_HOOK_URL / LIVE_HOOK_SECRET not set; skipping" >&2
  exit 0
fi

BODY="{\"event\":\"${EVENT}\",\"path\":\"${STREAM_KEY}\"}"

# The MediaMTX alpine image ships BusyBox `wget` but NOT `curl`, so the old curl-only
# version silently failed — the backend never learned a stream went ready/not-ready, so
# sessions stayed STARTING (never surfaced as LIVE) and never auto-FINISHED. Prefer curl
# when present, otherwise fall back to BusyBox wget.
if command -v curl >/dev/null 2>&1; then
  curl -s -m 5 -X POST "$BACKEND_HOOK_URL" \
    -H 'Content-Type: application/json' \
    -H "x-live-hook-secret: ${LIVE_HOOK_SECRET}" \
    -d "$BODY" >/dev/null 2>&1 || true
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 5 -O /dev/null \
    --header='Content-Type: application/json' \
    --header="x-live-hook-secret: ${LIVE_HOOK_SECRET}" \
    --post-data="$BODY" "$BACKEND_HOOK_URL" >/dev/null 2>&1 || true
else
  echo "notify.sh: neither curl nor wget available; cannot notify backend" >&2
fi
