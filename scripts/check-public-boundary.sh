#!/usr/bin/env bash
# Fails if anything internal is tracked in this public repo.
# Runs in CI on every push and pull request, and locally via the pre-commit hook.
#
# Two checks:
#   1. No tracked path matches an internal-doc pattern (built-in list + .hackathon-guard).
#   2. No tracked file contains the internal marker line used by every internal doc.
set -euo pipefail
export LC_ALL=C
cd "$(git rev-parse --show-toplevel)"

marker_a="INTERNAL."
marker_b="Never commit."
patterns='/internal/
/notes/
/private/
/scratch/
STRATEGY*.md
SUBMISSION-CHECKLIST*.md
PRIZES*.md
HANDOFF*.md
AGENT-TASKS*.md
docs/hackathon/
.ocean/'
if [ -f .hackathon-guard ]; then
  patterns="$patterns"$'\n'"$(grep -v '^[[:space:]]*#' .hackathon-guard | grep -v '^[[:space:]]*$' | grep -v '^!' || true)"
fi

fail=0
while IFS= read -r -d '' f; do
  base="${f##*/}"
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$pat" in
      /*/) p="${pat#/}"; case "$f" in "${p}"*) echo "internal path tracked: $f ($pat)"; fail=1 ;; esac ;;
      */)  case "/$f" in */"$pat"*) echo "internal path tracked: $f ($pat)"; fail=1 ;; esac ;;
      */*) case "$f" in $pat) echo "internal path tracked: $f ($pat)"; fail=1 ;; esac ;;
      *)   case "$base" in $pat) echo "internal path tracked: $f ($pat)"; fail=1 ;; esac ;;
    esac
  done <<< "$patterns"
done < <(git ls-files -z)

# Marker scan (skip this script itself, which names the marker).
hits=$(git ls-files -z | xargs -0 grep -l -F "$marker_a $marker_b" -- 2>/dev/null | grep -v '^scripts/check-public-boundary.sh$' || true)
if [ -n "$hits" ]; then
  echo "internal marker found in tracked files:"; echo "$hits"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "public-boundary check FAILED: move these files to ../hunch-book-internal/ and remove them from git." >&2
  exit 1
fi
echo "public-boundary check passed ($(git ls-files | wc -l | tr -d ' ') tracked files)."
