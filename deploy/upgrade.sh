#!/usr/bin/env bash
# S.P.R.U.C.E+ Mail Protection: upgrade an installed service to the version in this folder.
# In Cloud Shell, after unzipping the new version next to the old one (docs/INSTALL.md, "Upgrading"):
#     cd spruce-mail-protection-NEW
#     bash deploy/upgrade.sh                      # finds the settings of the version installed before
#     bash deploy/upgrade.sh ../spruce-mail-protection-OLD      # or name the old folder
# It copies your settings, adds any new ones (empty: the defaults), shows what changes, and runs
# deploy/install.sh without stopping for the delegation step. Records and settings are kept.
# To go back afterwards: bash deploy/rollback.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HERE="$(pwd -P)"
fail() { printf '\n\033[31mStopped:\033[0m %s\n' "$*" >&2; exit 1; }
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
SETTINGS=deploy/settings.env

# --- 1. The settings ------------------------------------------------------------------------------
if [ -f "$SETTINGS" ] && [ $# -eq 0 ]; then
    echo "Using the settings already in this folder ($SETTINGS)."
else
    if [ $# -gt 0 ]; then
        OLD="$1"; [ -d "$OLD" ] && OLD="$OLD/deploy/settings.env"
        [ -f "$OLD" ] || fail "no settings at $OLD (give the old version's folder, or its deploy/settings.env)."
    else
        # The most recently changed settings file of another unzipped version in your home folder.
        OLD="$(ls -t "$HOME"/spruce-mail-protection-*/deploy/settings.env 2>/dev/null | while read -r f; do
                 case "$(cd "$(dirname "$f")/.." && pwd -P)" in "$HERE") ;; *) echo "$f"; break ;; esac; done || true)"
        [ -n "$OLD" ] || fail "couldn't find the old version's settings in $HOME. Run: bash deploy/upgrade.sh <old folder>"
    fi
    [ "$(cd "$(dirname "$OLD")/.." && pwd -P)" = "$HERE" ] && fail "that is this folder's own settings file."
    if [ -f "$SETTINGS" ]; then fail "$SETTINGS already exists here; remove it, or run without a folder to use it."; fi
    cp "$OLD" "$SETTINGS"
    echo "Settings copied from $OLD"
fi

# Settings this version knows that the old file doesn't have: added empty (the default), never with
# the example's values.
added=()
while IFS= read -r line; do
    key="${line%%=*}"
    if ! grep -q "^[[:space:]]*$key[[:space:]]*=" "$SETTINGS"; then
        [ ${#added[@]} -gt 0 ] || printf '\n# Added by the upgrade to %s, empty (the defaults): see deploy/settings.example.env\n' "$VERSION" >> "$SETTINGS"
        added+=("$key"); printf '%s=\n' "$key" >> "$SETTINGS"
    fi
done < <(grep -E '^[A-Z_]+=' deploy/settings.example.env)
[ ${#added[@]} -eq 0 ] || echo "New settings in $VERSION, added empty (defaults): ${added[*]}"

get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$SETTINGS" | tr -d '\r' | tail -1 | sed 's/[[:space:]]*$//'; }
PROJECT="$(get PROJECT)"; REGION="$(get REGION)"
[ -n "$PROJECT" ] && [ -n "$REGION" ] || fail "PROJECT and REGION must be set in $SETTINGS."

# --- 2. What changes ------------------------------------------------------------------------------
gcloud config set project "$PROJECT" --quiet >/dev/null
IMG="$(gcloud run services describe spruce-worker --region="$REGION" --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
[ -n "$IMG" ] || fail "no spruce-worker in $PROJECT ($REGION): nothing to upgrade. For a first install: bash deploy/install.sh"
FROM="${IMG##*:}"; FROM="${FROM%%-*}"
# The AI model (phish-tiny) comes with each version: the one installed (a label since 0.3.1) and this one.
NEWMODEL="$(sed -n 's/.*"model": *"\([^"]*\)".*/\1/p' vendor/spruce/VENDOR.json 2>/dev/null | head -1 || true)"
OLDMODEL="$(gcloud run services describe spruce-worker --region="$REGION" --format='value(metadata.labels.spruce-model)' 2>/dev/null | tr '-' '.' || true)"
echo
echo "Upgrade S.P.R.U.C.E+ Mail Protection in $PROJECT ($REGION): $FROM -> $VERSION"
echo "AI model (phish-tiny): ${OLDMODEL:-the one installed} -> ${NEWMODEL:-unknown}$( [ -n "$OLDMODEL" ] && [ "$OLDMODEL" = "$NEWMODEL" ] && echo ' (the same)')"
# The mode, and what the installer will take from the dashboard or ask about (deploy/dashboard-policy.sh).
. deploy/dashboard-policy.sh
dashboard_policy_read "$PROJECT" "$(get MODE)" "$(get AI_MOVE_THRESHOLD)" "$(get BRAKE_PER_HOUR)" "$(get TIME_ZONE)" "$(get ALLOW_DOMAINS)" "$(get ALLOW_ADDRESSES)" "$(get AI_SUSPICIOUS_THRESHOLD)" "$(get RETENTION_DAYS)"
ENVMODE="$(get MODE)"; [ "$ENVMODE" = enforce ] || ENVMODE=monitor
DASHMODE="$(printf '%s' "$DASHBOARD_POLICY" | awk -F '\t' '$1 == "mode" { print $2 }')"
if [ -n "$DASHMODE" ] && [ "$DASHMODE" != "$ENVMODE" ]; then echo "Mode now: $DASHMODE (set on the dashboard; settings.env says $ENVMODE)"
else echo "Mode stays: $ENVMODE"; fi
dashboard_policy_summary
if [ "$FROM" = "$VERSION" ]; then echo "(Same version: this redeploys it.)"
elif [ "$(printf '%s\n%s\n' "$FROM" "$VERSION" | sort -V | tail -1)" = "$FROM" ]; then echo "Note: $VERSION is OLDER than what is installed. To go back to the previous build, deploy/rollback.sh is quicker."; fi
if [ -f CHANGELOG.md ]; then
    echo
    echo "What's new since $FROM (CHANGELOG.md):"
    awk -v from="$FROM" '/^## /{ v=$2; sub(":","",v); if (v==from) exit; show=1 } show && /^## /{ print "  " $0 }' CHANGELOG.md
fi
cat <<EOF

Domain-wide delegation scopes this version uses (check the Admin console entry has them):
  https://www.googleapis.com/auth/gmail.modify
  https://www.googleapis.com/auth/admin.directory.group.member.readonly
EOF
if [ -t 0 ]; then
    read -r -p "Upgrade now? [y/N] " ok
    case "$ok" in y | Y | yes | YES) ;; *) echo "Nothing changed."; exit 0 ;; esac
fi

# --- 3. Upgrade ------------------------------------------------------------------------------------
SPRUCE_UPGRADE=1 bash deploy/install.sh
cat <<EOF

Upgraded to $VERSION. If something is wrong, go back to the previous build with:
    bash deploy/rollback.sh
EOF
