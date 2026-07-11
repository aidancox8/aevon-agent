#!/bin/sh
# One-off runner: first US test cohort (Seattle metro), 2026-07-10.
# Verticals chosen for demo fit (existing reel presets + BC engagement data).
set -e
for CITY in "Seattle WA" "Bellevue WA" "Tacoma WA" "Kirkland WA"; do
  for Q in "law firm" "financial advisor" "insurance brokerage" "mortgage brokerage" "real estate brokerage" "dental clinic"; do
    echo "=== $Q / $CITY ==="
    node agent-lead-finder.js --query "$Q" --city "$CITY" || echo "(failed: $Q / $CITY, continuing)"
  done
done
echo "US pull complete."
