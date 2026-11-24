# 📍 ONDE PAREI

Ponto de retomada de cada frente. Fica no git, então vale em qualquer máquina (a memória do Claude não).
Uma seção por frente ativa. Data absoluta em cada uma. Curto: o que está em andamento e o próximo passo exato.
O detalhe técnico fica no CLAUDE.md e em `docs/`; aqui só o que falta fazer.

**Regra:** quando o Juan avisar que vai encerrar, o Claude reescreve a seção que mexeu antes de terminar.
Ao abrir uma sessão nova, ler este arquivo e conferir contra o `git log` (o que já foi feito sai daqui).

Board: `~/speed-padroes/painel/board.RedeNeutra.data.js` (cards T-001 em diante).

Legenda dos três fatos: **commitado** (SHA no git) · **no ar** (conferido no servidor) · **validado** (o Juan conferiu).
"Não sei" = não foi conferido no servidor nesta leitura (2026-11-23, feita só pelo git e pelos docs, sem acesso a servidor).

---

## Estado do repositório e do deploy — atualizado em 2026-11-23

**Em andamento:** nada sendo codado. Último commit em 2026-11-09 (`27c9d37`). Todo o trabalho desde 2026-10-06 está
no branch `claude/project-thread-tj04vv` (158 commits à frente do `main`, `main` parado em `9533821` de 2026-10-06).
Fonte: `git rev-list --count main..claude/project-thread-tj04vv` = 158; `git log main` termina em 2026-10-06.

- **Qual branch o servidor roda:** não sei. O `deploy/update.sh` faz `git pull --ff-only` do branch que estiver
  em checkout no servidor (sem CI, sem `.github/`). Os docs citam commits do branch como "no servidor"
  (`37ac8f5` em `docs/modulos/clientes-e-suporte.md` Wi-Fi; "No ar desde 30 out (`ef08e9b`)" no mesmo arquivo, Abrir a página do roteador),
  então o servidor provavelmente está nesse branch, e não no `main`. O board registra `main: '9533821'`, que não
  reflete o que está no ar.
- **Último commit com "no ar" afirmado nos docs:** `ef08e9b` (2026-10-30). Depois dele: `91769db` (doc, 2026-10-30)
  e os três de 2026-11-09 (abaixo). Se o servidor está em `27c9d37`: não sei.
- **GitDoc ligado no repo:** `.vscode/settings.json` (versionado) tem `"gitdoc.enabled": true`; 74 dos 158 commits
  do branch têm só data/hora como mensagem (ex.: `27c9d37`, `0fb562f`, `f9a3908`, `91769db`, `ef08e9b`). O
  `PADROES.md` pede GitDoc desligado em repo que faz deploy (aqui o deploy é manual pelo `update.sh`, mas o
  servidor puxa o que estiver no remoto). Card T-002.
- **`C:\Users\juang\rede-neutra`** (fora do repo): pasta vazia, sem `.git`, criada em 2026-10-06. Não é cópia
  do projeto; pode ser apagada pelo Juan.
- `npm test` não foi rodado nesta leitura. Último número nos docs: 347 testes (`docs/modulos/paineis-e-admin.md`, 29 out).

**Próximo passo exato:**
1. Juan decide o destino do branch: merge no `main` (e o servidor passa a seguir o `main`) ou manter o branch
   como linha de produção e corrigir o `main` no board.
2. No servidor (`179.106.108.39`, `/opt/rede-neutra`): `git rev-parse --abbrev-ref HEAD` e `git rev-parse --short HEAD`
   para saber branch e commit no ar; anotar aqui e no board.
3. Desligar o GitDoc (`.vscode/settings.json`) e confirmar com o Juan (card T-002).

---

## Queda de 2026-11-05 a 2026-11-09 e correções — atualizado em 2026-11-23

**O que houve (fonte: comentários nos commits):** o Postgres parou e não voltou sozinho (sem `restart:`), a API
ficou em loop e o portal ficou fora de 2026-11-05 a 2026-11-09 (`f9a3908`, `27c9d37` em `docker-compose.yml`).
No mesmo período o `deploy/backup-db.sh` gravou `.gz` vazios de 20 bytes, porque `pg_dump | gzip` escondia a falha
(`27c9d37`). Depois de reinício da API, o nginx ficava em 502 por guardar o IP antigo (`0fb562f`, `apps/web/nginx.conf`).

| Correção | Commitado | No ar | Validado |
|---|---|---|---|
| `restart: unless-stopped` no `db` | `f9a3908` | não sei | não |
| nginx resolve a API a cada 10 s | `0fb562f` | não sei (exige rebuild do container `web`) | não |
| backup sem pipe, recusa dump incompleto | `27c9d37` | não sei | não |

**Próximo passo exato:**
1. No servidor: conferir commit no ar, `docker inspect` do `db` com restart policy, e o `nginx.conf` dentro do container `web`.
2. Rodar `sh deploy/backup-db.sh` e conferir que o `.gz` novo tem tamanho real; apagar os de 20 bytes; conferir
   se a cópia para fora da VM existe (pendência de `docs/DEPLOY.md` "Go-live" item 6 e `RESUMO-PARA-WIKI.md` §4.6).
3. Alerta de portal fora do ar: 4 dias sem ninguém perceber. Zabbix está só citado em `docs/DEPLOY.md`
   ("Monitoramento (Zabbix)"); se está ativo: não sei.

---

## Validações em produção que faltam — atualizado em 2026-11-23

Piloto com o parceiro JHV em produção desde 2026-10-21 (`docs/modulos/contrato-e-ativacao.md` "Primeiro cliente JHV de ponta a ponta";
clientes reais 33752, 33766, 33770, 33771-JHV citados em `SpeedWiki/docs/modulos/rede-neutra.md`).

| Item | Commitado | No ar | Validado | Fonte |
|---|---|---|---|---|
| Troca de Wi-Fi: senha nova conectando num celular depois de religar a ONU; fluxo do técnico no painel de liberar ONU (só testado em ONU já instalada) | `37ac8f5` | sim em 2026-10-26 (doc) | parcial | `modulos/clientes-e-suporte.md` Wi-Fi, "Ainda não provado" |
| Abrir a página do roteador em modelos além do HG8145V5 | `ef08e9b` | sim em 2026-10-30 (doc) | só HG8145V5 (33766-JHV) | `modulos/clientes-e-suporte.md`, `CONTRATO-WIKI-V3-ACESSO-WEB.md` |
| Redesenho dos painéis: conferir em produção | `5c15627` | não sei | não | `modulos/paineis-e-admin.md` "falta conferir em produção depois do deploy" |
| Nova tentativa após `falha_provisionamento` (portal) | `694dac6`, `e4f07c2` (2026-10-29) | não sei | não sei | `modulos/contrato-e-ativacao.md` (contrato v2 não cita a nova tentativa); Wiki: `rede-neutra.md` 29/10 |
| Ver o painel do parceiro (admin como supervisor, só leitura) | `c828666` | não sei | não | `modulos/paineis-e-admin.md` (29 out, só Chrome headless) |
| Bloqueio: sessão PPPoE cai e não volta no NE40 | `cc3eab1` | sim (validado 22 out sem PPPoE) | parcial | `modulos/clientes-e-suporte.md` bloqueio, "Ainda não confirmado" |
| Ativação com configuração completa: tela não conferida no navegador | `b9a296c` | não sei | não | `modulos/contrato-e-ativacao.md` (23 out) |

**Próximo passo exato:**
1. Juan escolhe, com o JHV, uma instalação nova para testar o fluxo do técnico (Wi-Fi no painel de liberar ONU).
2. Conferir os painéis redesenhados e o "Ver painel do parceiro" no portal de produção.

---

## Go-live e operação — atualizado em 2026-11-23

Lista de `docs/DEPLOY.md` "Go-live" e `docs/RESUMO-PARA-WIKI.md` §4.6. Estado de cada item no servidor: não sei.
- `MFA_REQUIRED=true` (o go-live pede; durante os testes pode estar `false`).
- Conta de teste `testejuan@teste.com`: trocar senha ou desativar; cancelar reservas dela.
- `sshd_config.d/10-senha.conf` (senha no SSH) ainda existe? Apagar se a 22 for aberta (`docs/DEPLOY.md` §1).
- Backup fora da VM e monitoramento no Zabbix.
- Quais `*_MODE` estão em `wiki` hoje: os docs dizem "todos os modos em `wiki`" desde 2026-10-21 (`docs/modulos/contrato-e-ativacao.md`);
  confirmar com `printenv` no container `api`.

---

## Decisões em aberto — atualizado em 2026-11-23

Fonte: `docs/CONTEXTO.md` §10 e `docs/RESUMO-PARA-WIKI.md` §4.4–4.5 (de 2026-10-16; podem estar parcialmente resolvidas).
- Juan: cobrança no fechamento do portal (mês cheio ou proporcional na ativação e no cancelamento); board e colunas
  do Kanban dos chamados; origem do nome e senha do Wi-Fi na ativação (`docs/modulos/contrato-e-ativacao.md`, 23 out).
- Diretoria: SLA por tipo de chamado, preço fixo ou degressivo, fotos obrigatórias, WhatsApp no piloto, indicadores.
- Voalle: vincular os 4 planos (serviços 00229, 00232, 00233, 00332) a um tipo de contrato.
- Ficaram para depois no front: mapa colorido por ocupação, ocupação por região no painel da Speed, listas com painel lateral.

**Riscos vistos:**
- ~~Docs desatualizados (RESUMO-PARA-WIKI com modos em `off`, "sem commit ainda" no redesenho, `CONTEXTO.md` acima de 50 KB,
  README "Ainda não feito" velho)~~: corrigidos em 2026-11-23 (card T-013, sem commit). O diário do §6 foi para `docs/modulos/`;
  o valor real dos `*_MODE` continua "conferir no servidor".
