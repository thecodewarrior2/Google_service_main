# S.P.R.U.C.E+ Mail Protection: the policy settings changed on the dashboard (Settings → Policy), for
# deploy/install.sh and deploy/upgrade.sh, which source this file (it isn't run on its own).
#
# The dashboard keeps its changes of MODE, AI_MOVE_THRESHOLD, BRAKE_PER_HOUR, TIME_ZONE, ALLOW_DOMAINS and
# ALLOW_ADDRESSES in Firestore (state/policy-<key>). When installing, for each of them:
#   - settings.env doesn't set it (empty or missing), the dashboard does: the dashboard's is used;
#   - settings.env sets it, the dashboard doesn't: settings.env's is used;
#   - both, the same: nothing to choose;
#   - both, different: you're asked which to keep (the dashboard's by default, since it is in force).
#     Without a terminal to ask in, the dashboard's is kept; SPRUCE_SETTINGS=file uses settings.env's
#     (SPRUCE_SETTINGS=dashboard, the dashboard's, without asking).
# The choice is written into settings.env; once the new build is deployed, the dashboard's copies are
# removed and Activity notes what was chosen, so settings.env and the dashboard say the same thing.
# Reading never stops the script: when Firestore can't be read (none yet, no access), settings.env is used.
#
#   dashboard_policy_read PROJECT MODE AI_MOVE_THRESHOLD BRAKE_PER_HOUR TIME_ZONE ALLOW_DOMAINS ALLOW_ADDRESSES
#       fills DASHBOARD_POLICY, one line per setting the dashboard changed, tab-separated:
#       key, value, value in words, by, date, settings.env (unset, same or differs), settings.env's in words
#   dashboard_policy_summary     (upgrade.sh) what the installer will take or ask about
#   dashboard_policy_reconcile SETTINGS_FILE
#                                (install.sh) asks when they differ; sets those variables, and writes
#                                them into the settings file
#   dashboard_policy_finish PROJECT VERSION
#                                (install.sh, after deploying) removes the dashboard's copies, notes it

DASHBOARD_POLICY='' DASHBOARD_NOTES=''
DASHBOARD_POLICY_PY='
import json, sys
from datetime import datetime, timezone
key, f_mode, f_ai, f_brake, f_tz, f_dom, f_addr = sys.argv[1:8]   # (settings.env as it is; empty: the default)
def val(v):
    if not isinstance(v, dict): return None
    if "stringValue" in v: return v["stringValue"]
    if "integerValue" in v: return int(v["integerValue"])
    if "doubleValue" in v: return float(v["doubleValue"])
    if "mapValue" in v: return {k: val(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v: return [val(x) for x in v["arrayValue"].get("values", [])]
    return None
import re
def as_list(v): return sorted(set(x.strip().lower() for x in (v if isinstance(v, list) else re.split(r"[\r\n,;]+", str(v or ""))) if x and x.strip()))
o = val(json.load(sys.stdin).get("fields", {}).get("value"))
if not isinstance(o, dict) or o.get("value") is None: sys.exit(0)
raw_file = {"mode": f_mode, "aiThreshold": f_ai, "brakePerHour": f_brake, "timeZone": f_tz, "allowDomains": f_dom, "allowAddresses": f_addr}[key].strip()
numeric = key in ("aiThreshold", "brakePerHour")
listed = key in ("allowDomains", "allowAddresses")
def words(v):
    if listed:
        l = as_list(v)
        return "none" if not l else (", ".join(l) if len(l) <= 5 else "%d entries" % len(l))
    if key == "aiThreshold": return "%g%%" % round(float(v) * 100, 1)
    if key == "brakePerHour": return ("%d moves an hour" % int(float(v))) if float(v) else "automatic"
    return str(v)
v = o["value"]
raw = ",".join(as_list(v)) if listed else ("%g" % float(v) if key == "aiThreshold" else str(int(float(v)))) if numeric else str(v)
if raw_file == "": state, fw = "unset", "not set"
else:
    try:
        f = as_list(raw_file) if listed else ("enforce" if raw_file == "enforce" else "monitor") if key == "mode" else (float(raw_file) if numeric else raw_file)
        same = f == as_list(v) if listed else float(f) == float(v) if numeric else f == str(v)
        state, fw = ("same" if same else "differs"), words(f)
    except ValueError:
        state, fw = "differs", raw_file
at = o.get("at")
when = datetime.fromtimestamp(at / 1000, timezone.utc).strftime("%Y-%m-%d") if isinstance(at, (int, float)) else ""
print("\t".join([key, raw, words(v), str(o.get("by") or "an admin"), when, state, fw]))
'

dashboard_label() { case "$1" in mode) echo mode ;; aiThreshold) echo 'AI move threshold' ;; brakePerHour) echo brake ;; timeZone) echo 'time zone' ;; allowDomains) echo 'allowlisted domains' ;; allowAddresses) echo 'allowlisted addresses' ;; esac; }
dashboard_env_name() { case "$1" in mode) echo MODE ;; aiThreshold) echo AI_MOVE_THRESHOLD ;; brakePerHour) echo BRAKE_PER_HOUR ;; timeZone) echo TIME_ZONE ;; allowDomains) echo ALLOW_DOMAINS ;; allowAddresses) echo ALLOW_ADDRESSES ;; esac; }
dashboard_fs() {   # dashboard_fs PROJECT CURL-ARGS...: a Firestore REST call as the Cloud Shell account
    local project="$1"; shift
    [ -n "${DASHBOARD_TOKEN:-}" ] || DASHBOARD_TOKEN="$(gcloud auth print-access-token 2>/dev/null)" || return 1
    [ -n "$DASHBOARD_TOKEN" ] || return 1
    curl -sS --fail-with-body --max-time 10 -H "Authorization: Bearer $DASHBOARD_TOKEN" -H "x-goog-user-project: $project" -H 'content-type: application/json' "$@"
}
dashboard_base() { echo "${SPRUCE_FIRESTORE_URL:-https://firestore.googleapis.com/v1}/projects/$1/databases/(default)/documents"; }   # (SPRUCE_FIRESTORE_URL: the emulator, in the tests)

dashboard_policy_read() {
    DASHBOARD_POLICY=''
    local project="$1" key doc line
    for key in mode aiThreshold brakePerHour timeZone allowDomains allowAddresses; do
        doc="$(dashboard_fs "$project" "$(dashboard_base "$project")/state/policy-$key" 2>/dev/null)" || continue
        line="$(printf '%s' "$doc" | python3 -c "$DASHBOARD_POLICY_PY" "$key" "$2" "$3" "$4" "$5" "${6:-}" "${7:-}" 2>/dev/null || true)"
        [ -z "$line" ] || DASHBOARD_POLICY="$DASHBOARD_POLICY$line"$'\n'
    done
    return 0
}

dashboard_policy_summary() {
    local key value words by at state fwords
    while IFS=$'\t' read -r key value words by at state fwords; do
        [ -n "$key" ] || continue
        case "$state" in
            unset) echo "  The $(dashboard_label "$key") comes from the dashboard ($words, changed by $by, $at): settings.env doesn't set it." ;;
            differs) echo "  The dashboard and settings.env differ on the $(dashboard_label "$key"): $words on the dashboard (by $by, $at), $fwords in settings.env. The installer asks which to keep." ;;
        esac
    done <<< "$DASHBOARD_POLICY"
    return 0
}

dashboard_set_setting() {   # dashboard_set_setting FILE NAME VALUE: the line NAME=VALUE in the file
    local file="$1" name="$2" value="$3" escaped
    escaped="$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')"   # (& | and \ mean something to sed)
    if grep -q "^[[:space:]]*$name[[:space:]]*=" "$file"; then sed -i "s|^[[:space:]]*$name[[:space:]]*=.*|$name=$escaped|" "$file"
    else printf '%s=%s\n' "$name" "$value" >> "$file"; fi
}

dashboard_policy_reconcile() {
    local file="$1" key value words by at state fwords choice='' answer differs name
    DASHBOARD_NOTES=''
    [ -n "$DASHBOARD_POLICY" ] || return 0
    differs="$(printf '%s' "$DASHBOARD_POLICY" | awk -F '\t' '$6 == "differs"')"
    if [ -n "$differs" ]; then
        echo "  The dashboard and $file say different things:"
        while IFS=$'\t' read -r key value words by at state fwords; do
            printf '    %-18s on the dashboard: %s (changed by %s, %s); in settings.env: %s\n' "$(dashboard_label "$key")" "$words" "$by" "$at" "$fwords"
        done <<< "$differs"
        case "${SPRUCE_SETTINGS:-}" in dashboard | file) choice="$SPRUCE_SETTINGS" ;; esac
        if [ -z "$choice" ] && [ -t 0 ]; then
            read -r -p "  Keep the dashboard's (d), in force now, or use settings.env's (s)? [D/s] " answer
            case "$answer" in s | S) choice=file ;; *) choice=dashboard ;; esac
        fi
        if [ -z "$choice" ]; then choice=dashboard; echo "  (No terminal to ask in: keeping the dashboard's, which are in force. SPRUCE_SETTINGS=file uses settings.env's.)"; fi
    fi
    while IFS=$'\t' read -r key value words by at state fwords; do
        [ -n "$key" ] || continue
        name="$(dashboard_env_name "$key")"
        if [ "$state" = unset ] || { [ "$state" = differs ] && [ "$choice" = dashboard ]; }; then
            dashboard_set_setting "$file" "$name" "$value"; printf -v "$name" '%s' "$value"
            if [ "$state" = unset ]; then echo "  The $(dashboard_label "$key") comes from the dashboard: $words (now in $file too)."; DASHBOARD_NOTES="$DASHBOARD_NOTES; took the dashboard's $(dashboard_label "$key") ($words), which settings.env didn't set"
            else echo "  Keeping the dashboard's $(dashboard_label "$key"): $words (now in $file too)."; DASHBOARD_NOTES="$DASHBOARD_NOTES; kept the dashboard's $(dashboard_label "$key") ($words) over settings.env's ($fwords)"; fi
        elif [ "$state" = differs ]; then
            echo "  Using settings.env's $(dashboard_label "$key"): $fwords (the dashboard's $words is removed once this version is deployed)."
            DASHBOARD_NOTES="$DASHBOARD_NOTES; used settings.env's $(dashboard_label "$key") ($fwords) over the dashboard's ($words)"
        fi
    done <<< "$DASHBOARD_POLICY"
    return 0
}

dashboard_policy_finish() {
    local project="$1" version="$2" key failed='' account text body
    [ -n "$DASHBOARD_POLICY" ] || return 0
    for key in $(printf '%s' "$DASHBOARD_POLICY" | cut -f1); do
        dashboard_fs "$project" -X DELETE "$(dashboard_base "$project")/state/policy-$key" >/dev/null 2>&1 || failed="$failed $(dashboard_env_name "$key")"
    done
    if [ -n "$failed" ]; then
        echo "  Couldn't remove the dashboard's copy of:$failed. Where you chose settings.env's, the dashboard's stays in force: change it in Settings → Policy (or Allowlist)."
    fi
    account="$(gcloud config get-value account 2>/dev/null || true)"
    text="${account:-Someone in Cloud Shell} installed $version with deploy/install.sh; settings.env now holds the policy${DASHBOARD_NOTES:+:${DASHBOARD_NOTES#;}}."
    body="$(python3 -c 'import json,sys; print(json.dumps({"fields": {"at": {"integerValue": sys.argv[1]}, "kind": {"stringValue": "settings"}, "text": {"stringValue": sys.argv[2]}}}))' "$(date +%s%3N)" "$text")"
    dashboard_fs "$project" -X POST "$(dashboard_base "$project")/events" -d "$body" >/dev/null 2>&1 || true
    return 0
}
