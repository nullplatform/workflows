#!/usr/bin/env bash
# Bounded sleep for workflow wait-tools (np-agent runs this on the host).
# Usage: sleep.sh <seconds 1..300>
s="${1:-60}"
case "$s" in (*[!0-9]*|'') s=60;; esac
[ "$s" -gt 300 ] && s=300
[ "$s" -lt 1 ] && s=1
sleep "$s"
printf '{"slept":%d}\n' "$s"
