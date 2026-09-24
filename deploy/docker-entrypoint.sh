#!/bin/sh
# Runs the service as PUID:PGID (default 1000:1000) and makes sure it can write /data.
# Set PUID/PGID to the owner of your bind-mounted folder (on Synology: `id <user>` over SSH).
set -e

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  mkdir -p /data
  if [ -n "$(find /data \( ! -user "$PUID" -o ! -group "$PGID" \) -print -quit 2>/dev/null)" ]; then
    echo "ao3track: setting ownership of /data to $PUID:$PGID"
    chown -R "$PUID:$PGID" /data || echo "ao3track: warning: could not chown /data (check the host folder's permissions)"
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

# Started with `user:` set in compose: we can't fix permissions, but we can explain them.
if ! [ -w /data ]; then
  echo "ao3track: /data is not writable by uid $(id -u) gid $(id -g)." >&2
  echo "ao3track: fix the host folder's owner (chown -R $(id -u):$(id -g) <folder>), or remove 'user:' and set PUID/PGID instead." >&2
fi
exec "$@"
