#!/bin/sh
# Atualiza o portal no servidor: backup, baixa o código da branch atual, reconstrói e confere a saúde.
# Uso (usuário do deploy, no diretório do projeto):  sh deploy/update.sh
set -eu
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

# Backup antes de mexer (só se a pasta de backup existir; veja docs/DEPLOY.md).
if [ -d "${BACKUP_DIR:-/opt/rede-neutra-backups}" ]; then
  sh deploy/backup-db.sh
else
  echo "AVISO: pasta de backup não existe, pulando o backup (veja docs/DEPLOY.md)."
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Atualizando a branch $BRANCH..."
git fetch origin
# Só avança; se o servidor tiver mudança local ou o histórico divergir, para aqui em vez de sobrescrever.
git pull --ff-only origin "$BRANCH"

$COMPOSE up -d --build
$COMPOSE ps

# A API não publica porta: a checagem é de dentro do container.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if $COMPOSE exec -T api wget -qO- http://localhost:3001/api/health 2>/dev/null; then
    echo
    echo "Portal no ar (commit $(git rev-parse --short HEAD))."
    exit 0
  fi
  sleep 3
done
echo "ERRO: a API não respondeu. Veja: $COMPOSE logs --tail 60 api" >&2
exit 1
