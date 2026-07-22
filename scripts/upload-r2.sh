#!/usr/bin/env bash
# Upload the GSP/annual-report PDFs to a Cloudflare R2 (or Backblaze B2) bucket so the dashboard's
# links jump to the exact page (file.pdf#page=N). The dashboard builds URLs as
# ${PDF_BASE}/<local_filename> — i.e. a FLAT bucket — so this stages the exact files named in the
# document registry and pushes them flat.
#
# One-time setup:
#   1. Create a public R2 bucket (or B2). Note its public base URL (e.g. https://pub-xxxx.r2.dev).
#   2. Configure an rclone remote for it:  rclone config   (type: s3, provider: Cloudflare, or B2)
#      — call the remote "r2".
#   3. Set PDF_BASE in ../config.js to the bucket's public base URL (no trailing slash) and push.
#
# Usage:  scripts/upload-r2.sh [SRC_DIR] [R2_REMOTE:BUCKET]
#   SRC_DIR      where the PDFs currently live locally (default: ~/Downloads)
#   R2_REMOTE    rclone remote:bucket (default: r2:sgma-docs)
set -euo pipefail

SRC="${1:-$HOME/Downloads}"
DEST="${2:-r2:sgma-docs}"
REG="$(dirname "$0")/../data/source_documents.csv"
STAGE="$(mktemp -d)"

echo "Staging registry PDFs from $SRC ..."
missing=0
# column 8 (1-indexed) of the registry is local_filename; skip the header
python3 - "$REG" "$SRC" "$STAGE" <<'PY'
import csv, os, shutil, sys
reg, src, stage = sys.argv[1:4]
miss = 0
for r in csv.DictReader(open(reg)):
    fn = r["local_filename"]
    if not fn: continue
    p = os.path.join(src, fn)
    if os.path.exists(p):
        shutil.copy2(p, os.path.join(stage, fn))
    else:
        print(f"  MISSING locally: {fn}"); miss += 1
print(f"staged {len(os.listdir(stage))} files, {miss} missing")
PY

echo "Uploading to $DEST (flat) ..."
rclone copy "$STAGE" "$DEST" --transfers 4 --progress
rm -rf "$STAGE"
echo "Done. Set PDF_BASE in config.js to the bucket's public URL and push."
