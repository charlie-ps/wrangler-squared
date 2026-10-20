#!/bin/bash
# Boot agent-wrangler with this extension installed and run dev-smoke.mjs
# against it (CI's smoke step; runs the same way locally):
#   AW_REPO=<wrangler checkout, npm ci'd> scripts/boot-smoke.sh [extension dir]
# The wrangler gets a fresh data dir and port, the extension is COPIED into
# <data dir>/extensions/jobs (a symlink is never discovered), and no session is
# started, so nothing is billed. Exits with dev-smoke's status, or 1 if the
# wrangler never serves.
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$(cd "${1:-$here}" && pwd)" || exit 2
repo="${AW_REPO:-}"
if [ ! -f "$repo/server/index.js" ]; then
  echo "boot-smoke: AW_REPO must point at an agent-wrangler checkout (got '${repo}')" >&2
  exit 2
fi

data="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/aw-smoke-XXXXX")"
mkdir -p "$data/extensions/jobs"
rsync -a --exclude .git "$src/" "$data/extensions/jobs/"
port="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"

AW_DEV=1 AW_DATA_DIR="$data" AW_PORT="$port" node "$repo/server/index.js" > "$data/server.log" 2>&1 &
pid=$!
stop() {
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  sock="$(node -e "try{console.log(require('$data/config.json').tmuxSocket||'')}catch{}")"
  [ -n "$sock" ] && tmux -L "$sock" kill-server 2>/dev/null
  rm -rf "$data"
}
trap stop EXIT

for _ in $(seq 120); do
  curl -s -o /dev/null "http://127.0.0.1:$port/" && break
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.5
done
if ! curl -s -o /dev/null "http://127.0.0.1:$port/"; then
  echo "boot-smoke: wrangler did not serve on port $port; its log:" >&2
  cat "$data/server.log" >&2
  exit 1
fi
echo "boot-smoke: wrangler serving on port $port (data dir $data)"

AW_REPO="$repo" node "$here/scripts/dev-smoke.mjs" "$port"
status=$?
grep -i 'extension' "$data/server.log" | sed 's/^/wrangler log: /'
[ "$status" -ne 0 ] && echo "boot-smoke: dev-smoke failed (exit $status)" >&2
exit "$status"
