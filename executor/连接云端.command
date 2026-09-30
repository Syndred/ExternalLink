#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<24||(major===24&&minor<21))throw Error("请先安装 Node.js 24.21 或更新版本")'
npm ci
runtime_home="${EXTERNALLINK_HOME:-$HOME/.externallink-executor}"
if [[ ! -f "$runtime_home/outbox.sqlite" && ! -f "$runtime_home/enrollment.json" ]]; then
  (cd ../cloud/worker && npm ci)
  wrangler_cli="../cloud/worker/node_modules/wrangler/bin/wrangler.js"
  # Uses the owner's existing Cloudflare authorization. Browser login is required only if absent.
  auth_status="$(node "$wrangler_cli" whoami 2>&1)"
  if [[ "$auth_status" == *"not authenticated"* || "$auth_status" == *"not logged in"* ]]; then
    node "$wrangler_cli" login
  fi
  node src/enroll-device.mjs https://externallink-cloud.syndred.workers.dev default
fi
node scripts/setup-workbench.mjs
bash 打开外链助手.command
