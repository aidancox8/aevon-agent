#!/bin/sh
# One-off runner: US cohort pull, 2026-07-10. National metros, mixed timezones
# (send window 9am-4pm PT reads 12-7pm ET: acceptable). Dedup makes re-passes
# over already-pulled combos cheap, so the WA cities stay in the list.
# Verticals chosen for demo fit (existing reel presets + BC engagement data).
set -e
for CITY in "Seattle WA" "Bellevue WA" "Tacoma WA" "Kirkland WA" \
            "Portland OR" "Phoenix AZ" "Denver CO" "Dallas TX" "Austin TX" \
            "Houston TX" "San Diego CA" "Las Vegas NV" "Chicago IL" \
            "Atlanta GA" "Miami FL"; do
  for Q in "law firm" "financial advisor" "insurance brokerage" "mortgage brokerage" "real estate brokerage" "dental clinic"; do
    echo "=== $Q / $CITY ==="
    node agent-lead-finder.js --query "$Q" --city "$CITY" || echo "(failed: $Q / $CITY, continuing)"
  done
done
echo "US pull complete."
