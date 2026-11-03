#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
mkdir -p backups
backup="backups/usesend-$(date -u +%Y%m%dT%H%M%SZ).dump"
temporary=$(mktemp backups/.usesend-XXXXXX)
trap 'rm -f -- "$temporary"' EXIT
docker compose exec -T postgres pg_dump -U usesend -d usesend -Fc > "$temporary"
mv -- "$temporary" "$backup"
find backups -maxdepth 1 -type f -name 'usesend-*.dump' -mtime +7 -delete
