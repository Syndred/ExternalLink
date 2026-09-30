#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node scripts/setup-workbench.mjs
nohup node scripts/open-workbench.mjs --watch --services-only >> "${EXTERNALLINK_HOME:-$HOME/.externallink-executor}/watchdog.log" 2>&1 < /dev/null &
node scripts/open-workbench.mjs
