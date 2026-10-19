#!/bin/sh
# Type-checks the mod against the Claude Code API types the engine ships.
# The types file is written when the plugin-authoring skill loads (or into
# .claude-plugin/types/ when the folder is hot-reloaded); the newest one is used.
set -e
cd "$(dirname "$0")/.."
root=$(pwd)
types=""
if [ -f .claude-plugin/types/claude-code/index.d.ts ]; then
  types="$root/.claude-plugin/types/claude-code/index.d.ts"
else
  types=$(ls -t /private/tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts \
    /tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1 || true)
fi
if [ -z "$types" ]; then
  echo "No Claude Code API types found: load the plugin-authoring skill once in a session, then run this again." >&2
  exit 2
fi
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cat > "$dir/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["$types", "$root/hooks", "$root/types", "$root/tests"]
}
JSON
npx -y -p typescript@5.6.3 tsc -p "$dir/tsconfig.json"
echo "typecheck ok ($types)"
