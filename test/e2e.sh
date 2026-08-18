#!/bin/bash
# End-to-end tests against a locally running Worker.
#
#   cd worker && npx wrangler dev --port 8787 --local
#   bash test/e2e.sh
#
# worker/.dev.vars needs ADMIN_TOKEN, and RATE_LIMIT raised above the default 5
# so the throttle does not fire partway through the run.
B=http://localhost:8787
S="$(cd "$(dirname "$0")" && pwd)/fixtures"
T=test-admin-token-local
pass=0; fail=0
ck(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (got '$2' want '$3')"; fail=$((fail+1)); fi; }
code(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "=== health & auth ==="
ck "health 200"                "$(code $B/)" 200
ck "debug needs token"         "$(code $B/debug)" 401
ck "debug with token"          "$(code -H "x-admin-token: $T" $B/debug)" 200
ck "logs needs token"          "$(code $B/logs)" 401
ck "unknown route 404"         "$(code $B/nope)" 404
ck "download foreign key 404"  "$(code "$B/download?key=supy-onboarding/x")" 404

echo "=== validation ==="
ck "empty body 400"            "$(code -X POST $B/webhook -H 'Content-Type: application/json' -d '{}')" 400
ck "not JSON 400"              "$(code -X POST $B/webhook -H 'Content-Type: application/json' -d 'nope')" 400
ck "wrong content-type 400"    "$(code -X POST $B/webhook -H 'Content-Type: text/plain' -d 'x')" 400

echo "=== drafts ==="
K=$(curl -s -X POST $B/draft/save -H 'Content-Type: application/json' -d '{"fields":{"company":"E2E"},"items":[]}' | python3 -c "import json,sys;print(json.load(sys.stdin)['key'])")
ck "draft key is 40 hex"       "$(echo -n "$K" | grep -cE '^[a-f0-9]{40}$')" 1
ck "draft loads"               "$(curl -s "$B/draft/load?key=$K" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['fields']['company'])")" "E2E"
ck "traversal key 400"         "$(code "$B/draft/load?key=../../x")" 400
ck "unknown draft 404"         "$(code "$B/draft/load?key=$(python3 -c 'print("c"*40)')")" 404

echo "=== account prefill ==="
ck "mint needs token"          "$(code -X POST $B/account/link -H 'Content-Type: application/json' -d '{"account":"X"}')" 401
AK=$(curl -s -X POST $B/account/link -H "x-admin-token: $T" -H 'Content-Type: application/json' -d '{"account":"E2E Group","outlets":["A","B","a"]}' | python3 -c "import json,sys;print(json.load(sys.stdin)['key'])")
ck "prefill dedupes outlets"   "$(curl -s "$B/account/prefill?key=$AK" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['outlets']))")" 2
ck "mint requires account"     "$(code -X POST $B/account/link -H "x-admin-token: $T" -H 'Content-Type: application/json' -d '{}')" 400

echo "=== submission + idempotency ==="
python3 -c "
import json; p=json.load(open('$S/test-payload.json')); p['submissionNonce']='e2enonce123456'; json.dump(p,open('$S/t-nonce.json','w'))"
R1=$(curl -s -X POST $B/webhook -H 'Content-Type: application/json' --data-binary @$S/t-nonce.json)
ID1=$(echo "$R1" | python3 -c "import json,sys;print(json.load(sys.stdin)['submissionId'])")
R2=$(curl -s -X POST $B/webhook -H 'Content-Type: application/json' --data-binary @$S/t-nonce.json)
ID2=$(echo "$R2" | python3 -c "import json,sys;print(json.load(sys.stdin)['submissionId'])")
ck "replay returns same id"    "$ID1" "$ID2"
ck "replay flagged duplicate"  "$(echo "$R2" | python3 -c "import json,sys;print(json.load(sys.stdin).get('duplicate'))")" "True"
python3 -c "
import json; p=json.load(open('$S/test-payload.json')); p['submissionNonce']='differentnonce99'; json.dump(p,open('$S/t-n2.json','w'))"
ID3=$(curl -s -X POST $B/webhook -H 'Content-Type: application/json' --data-binary @$S/t-n2.json | python3 -c "import json,sys;print(json.load(sys.stdin).get('submissionId',''))")
ck "new nonce yields a real id" "$(echo -n "$ID3" | grep -cE '^[0-9a-f-]{36}$')" 1
ck "new nonce is a new request" "$([ -n "$ID3" ] && [ "$ID1" != "$ID3" ] && echo yes)" "yes"

echo "=== per-entity file cap ==="
printf 'x' > $S/f.pdf
ARGS=""; for i in 1 2 3 4 5 6 7; do ARGS="$ARGS -F documents[0][registration]=@$S/f.pdf"; done
ck "7 docs on one entity 400"  "$(code -X POST $B/webhook -F "payload=<$S/test-payload.json" $ARGS)" 400

echo; echo "$pass passed, $fail failed"; [ $fail -eq 0 ]
