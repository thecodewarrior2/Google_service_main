#!/usr/bin/env bash
# S.P.R.U.C.E+ Mail Protection: an update started on the dashboard (Settings → Update; src/update.js).
# Not run by hand: the spruce-update job (deploy/install.sh) starts a Cloud Build as spruce-updater, whose
# steps clone google_service_main into /workspace/release and run this file's phases in order:
#
#   check   (gcloud image)  an update was asked for in the last 30 minutes (state/updateRequest), for a
#                           version newer than the one running, and no other build is on it; noted as
#                           "building" (state/update)
#   pick    (git image)     the commit asked for is on google_service_main's main branch, has that version,
#                           and doesn't change the installation itself (installLevel); its files are put
#                           in /workspace/build (release stays as downloaded, so every phase runs this
#                           file from main's newest commit)
#   image   (docker image)  /workspace/build built and stored in Artifact Registry
#   deploy  (gcloud image)  both services deployed with it, their settings as they are; all traffic to it
#   finish  (gcloud image)  "done" or "failed" (state/update), and a line in Activity
#
# Nothing asked for (the job also runs by itself once a year): every phase does nothing. A failed phase
# leaves a reason in /workspace/failed, and the later phases skip their work, so finish can report it.
# A deploy that stops half-way leaves one service on the new build: bash deploy/rollback.sh goes back.
set -uo pipefail
W="${SPRUCE_WORKSPACE:-/workspace}"
R="$W/release"
B="$W/build"
phase="${1:-}"
FS="${SPRUCE_FIRESTORE_URL:-https://firestore.googleapis.com/v1}/projects/${PROJECT:-}/databases/(default)/documents"
fs() { curl -sS --fail-with-body --max-time 20 -H "Authorization: Bearer $(gcloud auth print-access-token)" -H 'content-type: application/json' "$@"; }
now_ms() { date +%s%3N; }
failed() { echo "$1" > "$W/failed"; echo "Stopped: $1"; exit 0; }
# A Firestore document's fields from KEY=VALUE pairs (numbers stay numbers): {"fields":{"value":{"mapValue":…}}}
state_json() {
    python3 -c '
import json, sys
f = {}
for a in sys.argv[1:]:
    k, v = a.split("=", 1)
    f[k] = {"integerValue": v} if v.isdigit() and k == "at" else {"stringValue": v}
print(json.dumps({"fields": {"value": {"mapValue": {"fields": f}}}}))' "$@"
}
set_state() { local name="$1"; shift; fs -X PATCH "$FS/state/$name" -d "$(state_json "$@")" >/dev/null; }

case "$phase" in
check)
    rm -f "$W/skip" "$W/request.env" "$W/failed" "$W/picked" "$W/built" "$W/deployed"; rm -rf "$B"
    # No request (404) is the usual case: nothing to do. Any other answer (permissions, say) fails the
    # build, so Cloud Build's history shows it, and the dashboard shows the update as not finished.
    if ! doc="$(fs "$FS/state/updateRequest" 2>/dev/null)"; then
        if printf '%s' "$doc" | grep -q 'NOT_FOUND'; then echo "No update was asked for: nothing to do."; touch "$W/skip"; exit 0; fi
        echo "Couldn't read the update request from Firestore (state/updateRequest): ${doc:-no answer}" >&2; touch "$W/skip"; exit 1
    fi
    req="$(printf '%s' "$doc" | python3 -c '
import json, sys
v = (json.load(sys.stdin).get("fields", {}).get("value") or {}).get("mapValue", {}).get("fields", {})
s = lambda k: v.get(k, {}).get("stringValue", "")
print("\t".join([s("version"), s("commit"), s("by"), str(v.get("at", {}).get("integerValue", "0"))]))' 2>/dev/null || true)"
    IFS=$'\t' read -r VERSION COMMIT BY AT <<< "$req"
    [ -n "${VERSION:-}" ] && [ -n "${COMMIT:-}" ] || { echo "No update was asked for: nothing to do."; touch "$W/skip"; exit 0; }
    # Another build already on it (the job run twice: by the button and by hand, say): this one leaves it
    # alone, and changes nothing. A build "building" for longer than the build's timeout (45 minutes) has stopped.
    cur="$(fs "$FS/state/update" 2>/dev/null | python3 -c '
import json, sys
v = (json.load(sys.stdin).get("fields", {}).get("value") or {}).get("mapValue", {}).get("fields", {})
print("\t".join([v.get("phase", {}).get("stringValue", ""), str(v.get("at", {}).get("integerValue", "0")), v.get("build", {}).get("stringValue", "") or "-"]))' 2>/dev/null || true)"
    IFS=$'\t' read -r CUR_PHASE CUR_AT CUR_BUILD <<< "$cur"
    if [ "${CUR_PHASE:-}" = building ] && [ $(( $(now_ms) - ${CUR_AT:-0} )) -lt 2700000 ] && [ "${CUR_BUILD:-}" != "${BUILD:-}" ]; then
        echo "An update is already under way (build ${CUR_BUILD}): this build leaves it to that one."; touch "$W/skip"; exit 0
    fi
    FROM="$(gcloud run services describe spruce-worker --region="$REGION" --format='value(metadata.labels.spruce-version)' 2>/dev/null | tr '-' '.')"
    LEVEL="$(gcloud run services describe spruce-worker --region="$REGION" --format='value(metadata.labels.spruce-install-level)' 2>/dev/null)"
    refuse() {
        echo "Not updating: $1"
        set_state update phase=failed "version=$VERSION" "from=$FROM" "by=$BY" "at=$(now_ms)" "message=$1"
        fs -X DELETE "$FS/state/updateRequest" >/dev/null 2>&1 || true
        touch "$W/skip"; exit 0
    }
    [ $(( $(now_ms) - ${AT:-0} )) -lt 1800000 ] || refuse "it was asked for more than 30 minutes ago"
    [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || refuse "the commit asked for isn't one"
    [ -n "$FROM" ] && [ "$(printf '%s\n%s\n' "$FROM" "$VERSION" | sort -V | tail -1)" = "$VERSION" ] && [ "$FROM" != "$VERSION" ] || refuse "$VERSION isn't newer than the version running (${FROM:-unknown})"
    printf 'VERSION=%q\nCOMMIT=%q\nBY=%q\nFROM=%q\nLEVEL=%q\n' "$VERSION" "$COMMIT" "$BY" "$FROM" "${LEVEL:-0}" > "$W/request.env"
    set_state update phase=building "version=$VERSION" "from=$FROM" "by=$BY" "at=$(now_ms)" "build=${BUILD:-}"
    echo "Updating from $FROM to $VERSION (commit $COMMIT), asked for by $BY."
    ;;
pick)
    [ -f "$W/request.env" ] && [ ! -f "$W/skip" ] || exit 0
    . "$W/request.env"
    cd "$R" || failed "the release wasn't downloaded"
    git fetch -q origin main 2>/dev/null || true
    git merge-base --is-ancestor "$COMMIT" origin/main 2>/dev/null || failed "commit $COMMIT isn't on google_service_main's main branch"
    rm -rf "$B"; mkdir -p "$B"
    git archive "$COMMIT" | tar -x -C "$B" || failed "commit $COMMIT couldn't be unpacked"
    cd "$B" || failed "commit $COMMIT couldn't be unpacked"
    v="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
    [ "$v" = "$VERSION" ] || failed "commit $COMMIT is version ${v:-unknown}, not $VERSION"
    lvl="$(sed -n 's/^ *"installLevel": *\([0-9]*\).*/\1/p' package.json | head -1)"
    [ "${lvl:-0}" -le "${LEVEL:-0}" ] || failed "$VERSION changes the installation itself (installLevel ${lvl}): install it from Cloud Shell with bash deploy/update.sh"
    model="$(sed -n 's/.*"model": *"\([^"]*\)".*/\1/p' vendor/spruce/VENDOR.json 2>/dev/null | head -1)"
    printf 'IMAGE=%q\nMODEL=%q\nNEWLEVEL=%q\n' "$REGION-docker.pkg.dev/$PROJECT/spruce/mail-protection:$VERSION-c${COMMIT:0:12}" "${model:-unknown}" "${lvl:-0}" >> "$W/request.env"
    touch "$W/picked"
    ;;
image)
    [ -f "$W/picked" ] || exit 0
    . "$W/request.env"
    docker build -t "$IMAGE" "$B" || failed "the image didn't build"
    docker push "$IMAGE" || failed "the image couldn't be stored in Artifact Registry"
    touch "$W/built"
    ;;
deploy)
    [ -f "$W/built" ] || exit 0
    . "$W/request.env"
    labels="spruce-version=${VERSION//./-},spruce-model=${MODEL//./-},spruce-install-level=${NEWLEVEL}"
    for s in spruce-worker spruce-admin; do
        gcloud run deploy "$s" --image="$IMAGE" --region="$REGION" --update-labels="$labels" --quiet >/dev/null || failed "$s couldn't be deployed"
        gcloud run services update-traffic "$s" --region="$REGION" --to-latest --quiet >/dev/null || failed "$s's traffic couldn't be moved to the new build"
    done
    touch "$W/deployed"
    ;;
finish)
    [ -f "$W/request.env" ] || exit 0
    . "$W/request.env"
    if [ -f "$W/deployed" ]; then
        set_state update phase=done "version=$VERSION" "from=$FROM" "by=$BY" "at=$(now_ms)" "build=${BUILD:-}"
        text="The update from $FROM to $VERSION finished: both services run $VERSION (started by $BY on the dashboard)."
        alert=false
    else
        why="$(cat "$W/failed" 2>/dev/null || echo 'it stopped')"
        set_state update phase=failed "version=$VERSION" "from=$FROM" "by=$BY" "at=$(now_ms)" "build=${BUILD:-}" "message=$why"
        text="The update from $FROM to $VERSION failed: $why. Nothing changed, unless the deploy stopped half-way (then bash deploy/rollback.sh goes back). Cloud Build's history has the log (tag spruce-update)."
        alert=true
    fi
    fs -X DELETE "$FS/state/updateRequest" >/dev/null 2>&1 || true
    body="$(python3 -c 'import json, sys; print(json.dumps({"fields": {"at": {"integerValue": sys.argv[1]}, "kind": {"stringValue": "update"}, "text": {"stringValue": sys.argv[2]}, "alert": {"booleanValue": sys.argv[3] == "true"}}}))' "$(now_ms)" "$text" "$alert")"
    fs -X POST "$FS/events" -d "$body" >/dev/null || true
    echo "$text"
    [ -f "$W/deployed" ]   # (the build shows as failed when the update did)
    ;;
*) echo "Usage: deploy/cloud-update.sh check|pick|image|deploy|finish (run by the spruce-update Cloud Build)" >&2; exit 2 ;;
esac
