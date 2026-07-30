#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

python3 -m pip install -r requirements.txt -q
python3 tools/import_table_xlsx.py
echo "Starting local AI agent on http://127.0.0.1:8787 ..."
exec python3 -m local_agent.server
