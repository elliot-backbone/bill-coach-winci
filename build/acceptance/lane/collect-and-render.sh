#!/bin/sh
# Collect every lane of a plan, verify manifests, render every conversation to Markdown (Downloads +
# archive), merge the lanes' captures and run one census across them, and sync the archive.
# Usage: collect-and-render.sh <plan-dir> <label>
set -u
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
PLAN="$1"; LABEL="$2"
S=/private/tmp/claude-501/-Users-elliotstorey/2492fe30-eb55-42fb-af96-cc00b05b2dc1/scratchpad
L="$S/winci/build/acceptance/lane"
A="$HOME/coach-acceptance-archive/2026-08-30-bill-coach-2.1.2"
OUT="$S/collected/$LABEL"; mkdir -p "$OUT"
cd "$L" && node lane-control.mjs collect --plan "$PLAN" --out "$OUT"
LANES=""; for d in "$OUT"/lane-*; do [ -d "$d/turns" ] && LANES="$LANES --lane $d"; done
DL="$HOME/Downloads/bill-coach-transcripts-2026-08-31/$LABEL"; mkdir -p "$DL"
# shellcheck disable=SC2086
node transcripts-md.mjs --out "$DL" $LANES
mkdir -p "$OUT/all-captures"; for d in "$OUT"/lane-*; do [ -d "$d/captures" ] && cp "$d"/captures/*.session.json "$OUT/all-captures/" 2>/dev/null; done
if ls "$OUT/all-captures"/*.session.json >/dev/null 2>&1; then node quality-census.mjs "$S/w/real/package" "$OUT/all-captures" "$OUT/census-all-lanes.json" | tail -3; fi
echo "== cards =="; for f in "$OUT"/lane-*/evidence/T-QUAL-004/card-*.json; do [ -f "$f" ] && python3 -c "import json,sys; d=json.load(open('$f')); print(d['card'], d['verdict'], 'wrong:', (d.get('wrongCase') or {}).get('verdict') or (d.get('wrongCase') or {}).get('mode'))"; done
echo "== errors =="; cat "$OUT"/lane-*/errors.jsonl 2>/dev/null | python3 -c "import sys,json; [print(json.loads(l).get('unitKey'), json.loads(l).get('class'), (json.loads(l).get('message') or '')[:100]) for l in sys.stdin if l.strip()]" | sort | uniq -c | head -20
mkdir -p "$A/lanes/$LABEL" "$A/transcripts/$LABEL"; rsync -a "$OUT/" "$A/lanes/$LABEL/"; rsync -a "$DL/" "$A/transcripts/$LABEL/"
"$A/preserve.sh" | tail -1
echo "transcripts: $DL"
