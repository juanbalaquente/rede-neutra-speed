#!/bin/sh
# Backup diário: dump do Postgres (retenção de 14 dias) e espelho das fotos de campo.
# Cron (usuário deploy): 0 3 * * * /opt/rede-neutra/deploy/backup-db.sh
set -eu
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-/opt/rede-neutra-backups}"
mkdir -p "$DEST"
docker compose exec -T db pg_dump -U rede rede_neutra | gzip > "$DEST/rede_neutra_$(date +%Y%m%d_%H%M).sql.gz"
find "$DEST" -name 'rede_neutra_*.sql.gz' -mtime +14 -delete

# Fotos: arquivos imutáveis (nunca sobrescritos), então um espelho incremental basta.
# Copie $DEST inteiro para outra máquina: disco perdido sem cópia apaga as provas de instalação.
mkdir -p "$DEST/fotos"
docker compose exec -T api tar -cf - -C /data/photos . | tar -xf - -C "$DEST/fotos"
