#!/usr/bin/env bash
set -u
NODE="C:/Users/17589/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
cd "$(dirname "$0")/.." || exit 1
T=$(mktemp -d)
show() { "$NODE" -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log("  dependency:",JSON.stringify(m.dependencies?.["dsh-session-resume"]));console.log("  bundles   :",JSON.stringify(m.dsh?.profile?.bundles))' "$1"; }
hash() { sha256sum "$1" | cut -d' ' -f1; }

echo "== A: fresh manifest (no dsh block) =="
mkdir -p "$T/a"; printf '{"name":"a","private":true}' > "$T/a/package.json"
"$NODE" install-offline.mjs --profile "$T/a" | sed 's/^/  /'
show "$T/a/package.json"
echo "  files copied: $([ -f "$T/a/node_modules/dsh-session-resume/package.json" ] && echo yes || echo no)"

echo "== B: existing bundles, run twice =="
mkdir -p "$T/b"
printf '{"name":"b","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-whale-widget"]}}}' > "$T/b/package.json"
echo "  before    : $("$NODE" -e 'const m=require(process.argv[1]);console.log(JSON.stringify(m.dsh.profile.bundles))' "$T/b/package.json")"
"$NODE" install-offline.mjs --profile "$T/b" | sed 's/^/  /'
show "$T/b/package.json"
b1=$(ls "$T/b" | grep -c 'bak-session-resume')
"$NODE" install-offline.mjs --profile "$T/b" | sed 's/^/  /'
b2=$(ls "$T/b" | grep -c 'bak-session-resume')
echo "  backups: first=$b1 second=$b2 (second run must not add one)"
show "$T/b/package.json"

echo "== C: dsh present without profile =="
mkdir -p "$T/c"; printf '{"name":"c","private":true,"dsh":{}}' > "$T/c/package.json"
"$NODE" install-offline.mjs --profile "$T/c" > /dev/null
show "$T/c/package.json"

echo "== D: offline rollback on forced copy failure =="
mkdir -p "$T/d"; printf '{"name":"d","private":true}' > "$T/d/package.json"
h1=$(hash "$T/d/package.json")
"$NODE" install-offline.mjs --profile "$T/d" --selftest-fail | sed 's/^/  /'
echo "  exit code : $?"
h2=$(hash "$T/d/package.json")
echo "  manifest identical: $([ "$h1" = "$h2" ] && echo yes || echo NO)"
echo "  target copied    : $([ -e "$T/d/node_modules/dsh-session-resume" ] && echo yes || echo no)"

echo "== E: pnpm installer dry run + rollback =="
mkdir -p "$T/e"
printf '{"name":"e","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}' > "$T/e/package.json"
"$NODE" install.mjs --profile "$T/e" --dry | sed 's/^/  /'
h3=$(hash "$T/e/package.json")
"$NODE" install.mjs --profile "$T/e" --selftest-fail | sed 's/^/  /'
echo "  exit code : $?"
h4=$(hash "$T/e/package.json")
echo "  manifest identical: $([ "$h3" = "$h4" ] && echo yes || echo NO)"

rm -rf "$T"
