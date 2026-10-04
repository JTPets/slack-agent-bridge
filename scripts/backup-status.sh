#!/bin/sh
# scripts/backup-status.sh — WORK-TODO #42 (c), the host half. Runs ON THE NAS HOST from
# cron, never in a container. Writes a small JSON status file describing the NEWEST file
# in each backup directory; the bridge (lib/backup-watch.js) reads that file and posts to
# #sqtools-ops when a backup is older than BACKUP_MAX_AGE_HOURS - or when this script
# itself has stopped running, which is the firmware-update-wiped-the-crontab case: the
# file's own `checkedAt` goes stale and that is reported too.
#
# Why a status file and not a mount: the bridge executes LLM-authored code, and the
# SqTools dumps hold customer data. The bridge is given file NAMES and AGES only, never
# the dumps.
#
# Usage:   sh backup-status.sh OUTPUT_FILE DIR [DIR ...]
# Example: sh /share/CACHEDEV1_DATA/jt-agent/scripts/backup-status.sh \
#            /share/CACHEDEV1_DATA/jt-agent/.backup-status.json \
#            /share/CACHEDEV1_DATA/sqtools/backups
# OUTPUT_FILE under the jt-agent share is /bridge/.backup-status.json inside the container
# (gitignored). Written to a temp file and renamed, so the bridge never reads half a file.
#
# LOGIC CHANGE 2026-10-04: new file. POSIX sh; uses only ls, head, wc, date -r, sed, mv.

set -u
if [ "$#" -lt 2 ]; then
  echo "usage: $0 OUTPUT_FILE DIR [DIR ...]" >&2
  exit 2
fi

out=$1
shift
tmp="$out.tmp.$$"
json_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

{
  printf '{"checkedAt":%s,"dirs":[' "$(date +%s)"
  sep=''
  for d in "$@"; do
    printf '%s{"path":%s,' "$sep" "$(json_str "$d")"
    sep=','
    newest=$(ls -t "$d" 2>/dev/null | head -n 1)
    if [ -n "$newest" ] && [ -f "$d/$newest" ]; then
      mtime=$(date -r "$d/$newest" +%s 2>/dev/null) || mtime=null
      [ -n "$mtime" ] || mtime=null
      count=$(ls "$d" | wc -l | tr -d ' ')
      printf '"newest":%s,"newestMtime":%s,"count":%s}' "$(json_str "$newest")" "$mtime" "$count"
    elif [ -d "$d" ]; then
      printf '"newest":null,"newestMtime":null,"count":0}'
    else
      printf '"newest":null,"newestMtime":null,"count":0,"missing":true}'
    fi
  done
  printf ']}\n'
} > "$tmp" && mv "$tmp" "$out"
