#!/bin/sh
# Backup diário: dump do Postgres (retenção de 14 dias) e espelho das fotos de campo.
# Cron (usuário deploy): 0 3 * * * /opt/rede-neutra/deploy/backup-db.sh
set -eu
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-/opt/rede-neutra-backups}"
mkdir -p "$DEST"
ARQ="$DEST/rede_neutra_$(date +%Y%m%d_%H%M).sql.gz"
TMP="$DEST/.dump-em-andamento.sql"
trap 'rm -f "$TMP" "$TMP.gz"' EXIT
# Sem pipe: no sh, "pg_dump | gzip" esconde a falha do pg_dump e grava um .gz vazio de 20 bytes
# (aconteceu de 2026-11-06 a 2026-11-09, com o banco parado). Falhou? Sai antes de apagar backup antigo.
docker compose exec -T db pg_dump -U rede rede_neutra > "$TMP"
if ! tail -n 5 "$TMP" | grep -q "PostgreSQL database dump complete"; then
  echo "backup-db: dump incompleto, nada foi gravado nem apagado" >&2
  exit 1
fi
gzip -c "$TMP" > "$TMP.gz"
mv "$TMP.gz" "$ARQ"
find "$DEST" -name 'rede_neutra_*.sql.gz' -mtime +14 -delete

# Fotos: arquivos imutáveis (nunca sobrescritos), então um espelho incremental basta.
# Copie $DEST inteiro para outra máquina: disco perdido sem cópia apaga as provas de instalação.
mkdir -p "$DEST/fotos"
docker compose exec -T api tar -cf - -C /data/photos . | tar -xf - -C "$DEST/fotos"
