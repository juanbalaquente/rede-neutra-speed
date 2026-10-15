#!/bin/sh
# Dump diário do Postgres com retenção de 14 dias.
# Cron (usuário deploy): 0 3 * * * /opt/rede-neutra/deploy/backup-db.sh
set -eu
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-/opt/rede-neutra-backups}"
mkdir -p "$DEST"
docker compose exec -T db pg_dump -U rede rede_neutra | gzip > "$DEST/rede_neutra_$(date +%Y%m%d_%H%M).sql.gz"
find "$DEST" -name 'rede_neutra_*.sql.gz' -mtime +14 -delete
