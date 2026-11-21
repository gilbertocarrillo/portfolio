#!/usr/bin/env bash
# Rebuild every image derived from the portrait:
#   assets/photo-{320,800,1254}.webp  responsive hero + mobile tile
#   assets/photo-800.jpg              fallback for browsers without WebP
#   assets/og.jpg                     1200x630 share card (LinkedIn, WhatsApp, X...)
#
# Usage:  tools/build-images.sh [path/to/new-photo]
# With an argument, that photo becomes the new master (tools/photo-source.jpg).
# Needs: cwebp (brew install webp), sips (macOS), Google Chrome.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=tools/photo-source.jpg
if [ "${1:-}" != "" ]; then
  sips -s format jpeg -s formatOptions 92 "$1" --out "$SRC" >/dev/null
  echo "master photo replaced from $1"
fi

for s in 320 800 1254; do
  cwebp -quiet -q 78 -m 6 -resize "$s" "$s" "$SRC" -o "assets/photo-$s.webp"
done
sips -s format jpeg -s formatOptions 80 -z 800 800 "$SRC" --out assets/photo-800.jpg >/dev/null

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP="$(mktemp -d)"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --user-data-dir="$TMP/profile" --window-size=1200,630 --virtual-time-budget=6000 \
  --screenshot="$TMP/og.png" "file://$PWD/tools/og.html" >/dev/null 2>&1
sips -s format jpeg -s formatOptions 85 "$TMP/og.png" --out assets/og.jpg >/dev/null
rm -rf "$TMP"

ls -la assets/photo-*.webp assets/photo-800.jpg assets/og.jpg
echo "Done. Commit and push; then refresh link previews at https://www.linkedin.com/post-inspector/"
