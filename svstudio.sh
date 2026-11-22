#!/bin/sh
# SV Studio launcher for Linux / macOS / WSL
cd "$(dirname "$0")" && exec python3 svstudio.py "$@"
