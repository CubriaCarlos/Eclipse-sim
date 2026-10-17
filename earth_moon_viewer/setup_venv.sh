#!/usr/bin/env bash
set -euo pipefail
# Create venv in .venv, activate, and install requirements
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
  echo "Created venv at $VENV_DIR"
else
  echo "Venv already exists at $VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
python -m pip install --upgrade pip
pip install -r "$ROOT_DIR/requirements.txt"
echo "Activate with: source $VENV_DIR/bin/activate"