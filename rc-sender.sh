set -u
A=src/renderer/src/runtime/native-chat/agent-senders/agent-sender-associations
T1=$A.test.ts
T2=src/renderer/src/components/native-chat/messages/agent-senders/native-chat-agent-message-sender-updates.test.tsx
T3=src/renderer/src/components/native-chat/messages/agent-senders/native-chat-agent-message-sender-view.test.tsx
V="pnpm exec vitest run --config config/vitest.config.ts"
echo "=== TESTS"; $V $T1 $T2 $T3 2>&1 | tail -60
mut() { echo "=== MUTATION $1"; eval "$2"; $V $3 2>&1 | grep -E "Tests |✓|×|FAIL" | head -5; git checkout -q -- . ; }
mut contested "perl -0pi -e 's/value && contested\(index, value\) \? null : value/value/' $A.ts" $T1
mut principals "perl -0pi -e 's/for \(const principal of part\?\.principals \?\? \[\]\)/for (const principal of [])/' $A.ts" $T1
mut overrides "perl -0pi -e 's/publication !== whole \|\| scoped.length === 0 \|\|/true ||/' $A.ts" $T1
mut ownhost "perl -0pi -e 's/    if \\(host === claimant\\) \\{\\n      continue\\n    \\}\\n//' $A.ts" $T1
mut broadcast "perl -0pi -e 's/\(sendersChanged && !samePublishingHosts\(previous, state\)\)/sendersChanged/' src/renderer/src/store/slices/agent-status/agent-status-projection.ts" $T2
echo "=== TC"; pnpm tc 2>&1 | tail -30
echo "=== FMT"; pnpm exec oxfmt --write $(git diff --name-only 6d2e6337b9f HEAD) >/dev/null 2>&1; git diff
echo "=== LINT"; pnpm exec oxlint $(git diff --name-only 6d2e6337b9f HEAD) 2>&1 | tail -30
git checkout -q -- .
