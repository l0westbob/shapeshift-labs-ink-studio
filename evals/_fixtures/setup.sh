#!/bin/bash
# Prepares an eval workspace: copies the ink-studio runtime and a node binary into .ink-studio/ with an ./ink-agent launcher
# (the eval sandbox executes only files inside the workspace, so the plugin's own bin/ink-agent is unusable there), then copies the named
# fixtures: setup.sh <source>:<destination> ...
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
mkdir -p .ink-studio
for part in agent bin cli src demos docs scripts index.js package.json catalog.json AGENTS.md README.md; do
  cp -R "$root/$part" .ink-studio/
done
# a real node binary: version-manager shims (mise, asdf) need their home configuration, which the sandbox replaces
node_bin=node
IFS=: read -ra dirs <<< "$PATH"
for dir in "${dirs[@]}"; do
  case "$dir" in *shims*) continue ;; esac
  if [ -x "$dir/node" ]; then node_bin="$dir/node"; break; fi
done
if [ "$node_bin" = node ]; then
  echo "setup.sh: no node binary on PATH outside a version-manager shim directory" >&2
  exit 1
fi
# the eval sandbox only executes files inside the workspace, so the runtime brings its own copy of node
cp "$node_bin" .ink-studio/node
printf '#!/bin/sh\nexec "$(dirname "$0")/.ink-studio/node" "$(dirname "$0")/.ink-studio/bin/ink-agent" "$@"\n' > ink-agent
chmod +x ink-agent
for pair in "$@"; do
  source="${pair%%:*}"; destination="${pair#*:}"
  mkdir -p "$(dirname "$destination")"
  cp "$here/$source" "$destination"
done
