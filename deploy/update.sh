#!/usr/bin/env bash
# S.P.R.U.C.E Mail Protection Service: upgrade to the newest approved version, without uploading a zip.
# In Cloud Shell, from the folder you installed or last upgraded from:
#     bash deploy/update.sh
# It downloads the repository of approved releases (google_service_main: only versions the maintainer
# tried and approved), unpacks the newest next to this folder, and runs its deploy/upgrade.sh. That
# copies your settings, shows what changes (the version, the AI model's version, what's new) and asks
# before changing anything. Each version pins its AI model (phish-tiny): one commit of TinyPhishLLM, the
# model's own public repository, and each file's SHA-256 (vendor/spruce/VENDOR.json). Building the image
# downloads it from there and checks it, so the model changes only when an approved version pins a new one.
set -euo pipefail
cd "$(dirname "$0")/.."
HERE="$(pwd -P)"
RELEASES="${SPRUCE_RELEASES:-https://github.com/thecodewarrior2/Google_service_main.git}"
fail() { printf '\n\033[31mStopped:\033[0m %s\n' "$*" >&2; exit 1; }
version() { sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$1/package.json" | head -1; }

[ -f deploy/settings.env ] || fail "no deploy/settings.env here: run this from the folder you installed or upgraded from."
command -v git >/dev/null || fail "git is not installed (use Cloud Shell)."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Getting the newest approved version from $RELEASES ..."
git clone --quiet --depth 1 "$RELEASES" "$TMP/release" 2>"$TMP/err" || fail "couldn't download it: $(tail -1 "$TMP/err")"
NEW="$(version "$TMP/release")" CUR="$(version .)"
[ -n "$NEW" ] || fail "the download has no version (no package.json)."
if [ "$NEW" = "$CUR" ]; then echo "This folder is already $CUR, the newest approved version. To deploy it again: bash deploy/install.sh"; exit 0; fi
[ "$(printf '%s\n%s\n' "$CUR" "$NEW" | sort -V | tail -1)" = "$NEW" ] || fail "the newest approved version ($NEW) is older than this folder's ($CUR): nothing to update."
DEST="$(dirname "$HERE")/spruce-mail-protection-$NEW"
[ ! -e "$DEST" ] || fail "$DEST already exists: run bash deploy/upgrade.sh from there, or remove it first."
mkdir -p "$DEST"
git -C "$TMP/release" archive HEAD | tar -x -C "$DEST"
echo "Unpacked $NEW in $DEST (commit $(git -C "$TMP/release" rev-parse --short HEAD))."
cd "$DEST"
exec bash deploy/upgrade.sh "$HERE"
