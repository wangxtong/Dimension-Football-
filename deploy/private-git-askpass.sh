#!/usr/bin/env bash
set -Eeuo pipefail
# Git uses this helper only for the fixed github.com origin. Never place credentials
# in the remote URL, arguments, Git config, stdout logs, or the source artifact.
file=/etc/vantis/github-read-token
[[ "$EUID" -eq 0 ]] || exit 1
[[ -f "$file" && ! -L "$file" ]] || exit 1
[[ $(stat -c '%u:%a' "$file") == '0:600' ]] || exit 1
case "$1" in
  *Username*) printf 'x-access-token\n' ;;
  *Password*)
    IFS= read -r token < "$file" || true
    [[ "$token" =~ ^[A-Za-z0-9_-]{20,1024}$ ]] || exit 1
    printf '%s\n' "$token"
    ;;
  *) exit 1 ;;
esac
