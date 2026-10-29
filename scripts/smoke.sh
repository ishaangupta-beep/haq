#!/usr/bin/env bash
# Smoke-tests the LIVE backend. Places NO phone calls and uses no Bolna credits.
# Usage:  KEY=<your WEBHOOK_SECRET> bash scripts/smoke.sh
# Optional: BASE=https://other-url.vercel.app
set -u
BASE="${BASE:-https://haq-virid-one.vercel.app}"
KEY="${KEY:?Set KEY to your WEBHOOK_SECRET, e.g. KEY=abc bash scripts/smoke.sh}"
pass=0; fail=0

check() { # name expected_status actual_status body
  if [ "$2" = "$3" ]; then echo "✅ $1"; pass=$((pass+1))
  else echo "❌ $1 — expected HTTP $2, got $3"; echo "   $4" | head -c 400; echo; fail=$((fail+1)); fi
}
req() { # method path [json]
  local m=$1 p=$2 d=${3:-}
  if [ -n "$d" ]; then curl -s -o /tmp/haq_body -w "%{http_code}" -X "$m" -H "Content-Type: application/json" -H "x-haq-key: $KEY" "$BASE$p" -d "$d"
  else curl -s -o /tmp/haq_body -w "%{http_code}" -X "$m" -H "x-haq-key: $KEY" "$BASE$p"; fi
}

echo "Testing $BASE"
echo

# 1. Security: no key → refused
s=$(curl -s -o /tmp/haq_body -w "%{http_code}" "$BASE/api/cases"); check "Case list is private without the key" 401 "$s" "$(cat /tmp/haq_body)"

# 2. With key → database reachable
s=$(req GET /api/cases); check "Case list works with the key (database connected)" 200 "$s" "$(cat /tmp/haq_body)"

# 3. Webhook with wrong secret → refused
s=$(curl -s -o /tmp/haq_body -w "%{http_code}" -X POST -H "Content-Type: application/json" "$BASE/api/webhooks/bolna?secret=wrong" -d '{"id":"x"}')
check "Webhook rejects a wrong secret" 401 "$s" "$(cat /tmp/haq_body)"

# 4. Webhook with right secret, from an unknown agent → accepted and safely ignored
s=$(curl -s -o /tmp/haq_body -w "%{http_code}" -X POST -H "Content-Type: application/json" "$BASE/api/webhooks/bolna?secret=$KEY" \
  -d '{"id":"smoke-'$RANDOM'","agent_id":"not-a-real-agent","status":"completed"}')
check "Webhook accepts the right secret" 200 "$s" "$(cat /tmp/haq_body)"
grep -q "ignored:unknown-agent" /tmp/haq_body && echo "   ↳ $(cat /tmp/haq_body)" || { echo "   ⚠️  unexpected: $(cat /tmp/haq_body)"; }

# 5. Create a test case WITHOUT starting any call
s=$(req POST /api/cases '{"customer_name":"SMOKE TEST","customer_phone":"+910000000000","company":"IndiGo","issue_summary":"Flight cancelled by airline, refund not received","reference_number":"AB12CD","amount_inr":"₹6,400","desired_outcome":"full refund","incident_date":"20 October 2026","start_now":false}')
check "Create a case (no call placed)" 201 "$s" "$(cat /tmp/haq_body)"
CASE_ID=$(python3 -c "import json;print(json.load(open('/tmp/haq_body')).get('id',''))" 2>/dev/null)
python3 -c "import json;c=json.load(open('/tmp/haq_body'));print('   ↳ amount parsed:',c.get('amount_inr'),'| policy:',(c.get('policy_note') or '')[:60]+'…')" 2>/dev/null

if [ -n "$CASE_ID" ]; then
  # 6. Fetch it with its timeline
  s=$(req GET "/api/cases/$CASE_ID"); check "Fetch case + timeline" 200 "$s" "$(cat /tmp/haq_body)"

  # 7. Draft the escalation complaint (no call)
  s=$(req POST "/api/cases/$CASE_ID/escalate"); check "Draft National Consumer Helpline complaint" 200 "$s" "$(cat /tmp/haq_body)"
  python3 -c "import json;print('   ↳', json.load(open('/tmp/haq_body'))['draft'].splitlines()[0])" 2>/dev/null
fi

# 8. Bolna API key works (read-only: lists your agents, no call)
if [ -n "${BOLNA_API_KEY:-}" ]; then
  s=$(curl -s -o /tmp/haq_body -w "%{http_code}" -H "Authorization: Bearer $BOLNA_API_KEY" https://api.bolna.ai/v2/agent/all)
  check "Bolna API key is valid" 200 "$s" "$(cat /tmp/haq_body)"
  python3 -c "import json;[print('   ↳',a.get('agent_name'),'→',a.get('id')) for a in json.load(open('/tmp/haq_body'))]" 2>/dev/null
else
  echo "⏭️  Skipped Bolna key check (run with BOLNA_API_KEY=... to include it)"
fi

echo
echo "Passed: $pass   Failed: $fail"
[ -n "${CASE_ID:-}" ] && echo "(Test case $CASE_ID is named 'SMOKE TEST' — safe to delete in Supabase → Table Editor → cases)"
