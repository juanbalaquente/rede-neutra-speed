# Deploy do portal Rede Neutra

Registro do que foi feito na instalação de 15 out 2026 e de como atualizar. Servidor: VM Ubuntu Server 24.04 LTS no ESXi, `179.106.108.39`, hostname `redeneutra`, domínio `redeneutra.spdlink.com.br` (registro A já aponta para o IP).

O modelo é o da SpeedWiki (`SpeedWiki/deploy/`), adaptado: aqui tudo roda em Docker Compose (banco, API, web e Caddy), então não há `/var/www`, `systemd` nem `sudoers` especiais.

## 1. Servidor (uma vez)

1. Instalar o Ubuntu Server com OpenSSH. O instalador importou a chave do GitHub e desligou a senha; para entrar por usuário e senha (Termius) foi criado `/etc/ssh/sshd_config.d/10-senha.conf` com `PasswordAuthentication yes`. **Se a porta 22 for aberta para a internet, apague esse arquivo e reinicie o ssh (só chave) e instale o fail2ban.**
2. Atualizar e instalar as ferramentas, e ligar o firewall (a 22 é liberada antes de ativar):
   ```
   sudo apt update && sudo apt upgrade -y && sudo apt install -y open-vm-tools ufw curl git ca-certificates
   sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
   ```
3. Instalar o Docker Engine com o plugin Compose pelo repositório oficial (https://docs.docker.com/engine/install/ubuntu/) e `sudo usermod -aG docker <usuário>`. O grupo `docker` equivale a root: o usuário de deploy precisa ter chave exclusiva.
4. O Docker publica portas por conta própria, ignorando o `ufw`. O compose de produção só publica o Caddy (80 e 443); banco e API não têm porta aberta.

## 2. Código

O repositório é privado. O servidor usa uma *deploy key* **somente leitura**:

```
ssh-keygen -t ed25519 -N "" -C "deploy-redeneutra" -f ~/.ssh/id_ed25519_deploy -q
cat ~/.ssh/id_ed25519_deploy.pub
```

Cadastre a pública em GitHub → repositório → Settings → Deploy keys, **sem marcar "Allow write access"** (com escrita, quem invadisse o servidor poderia alterar o código). Depois:

```
sudo mkdir -p /opt/rede-neutra && sudo chown $USER: /opt/rede-neutra
GIT_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519_deploy -o IdentitiesOnly=yes' git clone -b <branch> git@github.com:juanbalaquente/rede-neutra-speed.git /opt/rede-neutra
cd /opt/rede-neutra && git config core.sshCommand 'ssh -i ~/.ssh/id_ed25519_deploy -o IdentitiesOnly=yes'
```

O deploy sai da branch `claude/project-thread-tj04vv` enquanto ela não for mesclada no `main`.

## 3. `.env` de produção

```
cp .env.example .env && chmod 600 .env
```

Preencher: `NODE_ENV=production`, `PORTAL_DOMAIN`, `PUBLIC_BASE_URL`, `SESSION_SECRET` (`openssl rand -hex 32`), `POSTGRES_PASSWORD` (`openssl rand -hex 24`), `SEED_ADMIN_EMAIL` e `SEED_ADMIN_PASSWORD` (10+ caracteres, com letra e número). Deixar `INTEGRATIONS_MODE=mock` e `ACTIVATION_MODE=off` até a SpeedWiki liberar (rotas v1 prontas, Codemaps ainda bloqueado) e o Juan autorizar a escrita.

**O `.env` não vai para o git.** Guarde uma cópia no Vaultwarden (Nota Segura `rede-neutra-env`): se o servidor se perder, a senha do banco e o `SESSION_SECRET` se perdem junto. A sincronização automática da Wiki (`README-vault-sync.md`) só compensa quando houver credenciais que mudam, como `WIKI_API_KEY` e `WIKI_WRITE_KEY`.

## 4. Subir

```
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

Esperado: `db` (healthy), `api`, `web` e `caddy` em `Up`. A API roda as migrations e o seed ao iniciar. O Caddy só emite o certificado se a internet alcançar as portas **80 e 443** do IP; essa liberação é na borda (CGR/Mikrotik), não no servidor.

## 5. Backup

```
sudo mkdir -p /opt/rede-neutra-backups && sudo chown $USER: /opt/rede-neutra-backups
crontab -e   # 0 3 * * * /opt/rede-neutra/deploy/backup-db.sh
```

O script guarda o dump do Postgres (14 dias) e espelha as fotos de campo em `fotos/`. Copie a pasta de backup inteira para outra máquina: disco perdido sem cópia apaga o banco e as provas de instalação.

## 6. Atualizar

```
cd /opt/rede-neutra && sh deploy/update.sh
```

Faz o backup, o `git pull --ff-only`, reconstrói os containers e confere a saúde da API. Antes de uma atualização grande, tire um snapshot da VM no ESXi.

## 7. Depois (modelo da Wiki, quando valer a pena)

A Wiki entrega por GitHub Actions: o runner empacota o código, envia por `scp` e roda o build por SSH, com `SERVER_HOST`, `SERVER_USER` e `SERVER_SSH_KEY` nos *Secrets*. Para o portal isso exige a porta 22 aberta na borda (de preferência só para as faixas `actions` de `api.github.com/meta`, que mudam com o tempo), uma chave SSH **nova e exclusiva** e o `main` atualizado. Até lá, `deploy/update.sh` basta.

## Pendências de infraestrutura

- CGR: liberar 80 e 443 (certificado) e, se houver CI, a 22 do `179.106.108.39`.
- SpeedWiki: liberar o IP `179.106.108.39` se ela restringir o acesso às rotas `/proxy/redeneutra/*`.
- `WIKI_API_KEY` e `WIKI_BASE_URL` no `.env` (o Juan envia a chave por canal seguro) quando o Codemaps liberar.
