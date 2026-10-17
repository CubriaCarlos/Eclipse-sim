#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_NAME="earth_moon_viewer.zip"
echo "Creating $OUT_NAME from $ROOT_DIR"
cd "$ROOT_DIR"
zip -r "$OUT_NAME" . -x "*.venv*" "*/.venv/*" "*/.git/*" "*/__pycache__/*"
echo "Package created: $ROOT_DIR/$OUT_NAME"
