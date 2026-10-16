# Contrato portal Rede Neutra ↔ SpeedWiki (v3): clientes, chamados e automações

**Estado: PROPOSTA do portal**, escrita em 16 out 2026 a partir do que a SpeedWiki já tem em produção (`CLAUDE.md` dela: NE40 por CLI, `onu_signal_history`, ACS/reboot, Kanban externo). Nada disto existe ainda na Wiki nem no portal. Itens marcados **[DECIDIR]** dependem do Juan, da diretoria ou do analista de Voalle; itens **[PERGUNTA]** são dúvidas técnicas para a Wiki.

Complementa o [v1](CONTRATO-WIKI-V1.md) (leitura da rede) e o [v2](CONTRATO-WIKI-V2-ATIVACAO.md) (liberação de ONU). Mesmo modelo: rotas no proxy da Wiki, resposta validada pelo portal (o que não bate com o contrato vira erro), escritas assíncronas e idempotentes.

## O que isto destrava no portal
Tela do cliente (semáforo de fibra, PPPoE e contrato, sinal de 30 dias), dashboard com fibra online e PPPoE conectado lado a lado, alarmes, as automações do cliente final (bloquear, desbloquear, reiniciar, cancelar) e os chamados de infraestrutura.

## Regras comuns

- **Prefixo:** `/proxy/redeneutra/v3`. **Leitura** com `X-RedeNeutra-Key`; **escrita** com `X-RedeNeutra-Write-Key` (a mesma chave separada do v2).
- **A chave do cliente é o login PPPoE** (`<contrato>-<CÓDIGO>`, ex.: `12345-JHV`), que é também o `alias` da ONU no OLTCloud (decisão do v2). O portal nunca manda nome de assinante.
- **Defesa em profundidade contra vazamento entre parceiros.** A Wiki não conhece parceiros, e o isolamento é do portal (que só pede os logins do parceiro da sessão). Mesmo assim, toda rota que recebe login exige o header `X-RedeNeutra-Partner: <CÓDIGO>` (ex.: `JHV`), e a Wiki responde `403 login_de_outro_parceiro` se o login não terminar em `-<CÓDIGO>`. `GET /operacoes/{id}` e `GET /chamados/{id}` também mandam o header, e a Wiki confere o dono da operação ou do chamado. Barato e pega erro de programação dos dois lados.
- **Fontes independentes.** Cada fonte (OLTCloud, NE40, Voalle) responde por si: se uma falhar, o campo dela vem `"estado": "desconhecido"` com `motivo`, e a rota continua `200`. Nunca derrubar a resposta inteira por uma fonte fora do ar (o planejamento pede que o portal funcione parcialmente).
- **Frescor explícito.** Toda leitura traz `atualizadoEm` (ISO 8601 com fuso) por fonte. O portal mostra a idade do dado e marca como velho acima de 15 min (fibra) ou 30 min (PPPoE em snapshot).
- **Escritas:** `idempotencyKey` (uuid) obrigatória; mesma chave, mesma operação, nunca duas. Resposta `202` com `operacaoId`; o portal consulta `GET /operacoes/{id}` a cada poucos segundos.
- **Erros:** corpo `{"error": "<codigo>"}`. `404` login desconhecido; `409`/`422` regra de negócio; `5xx` falha da Wiki (o portal trata como indisponível).
- **Sem senha em log, em lista ou em cache** (ver "Senha PPPoE").

---

## A. Leitura do cliente

### `GET /clientes/{login}/status`
O semáforo de três estados da tela do cliente.

```json
{
  "login": "12345-JHV",
  "fibra": {
    "estado": "online",
    "sinalDbm": -21.4,
    "uptimeDesde": "2026-10-10T08:12:00-03:00",
    "ultimaQuedaEm": "2026-10-03T14:40:00-03:00",
    "atualizadoEm": "2026-10-16T10:02:00-03:00"
  },
  "autenticacao": {
    "estado": "conectado",
    "ip": "100.64.12.34",
    "desde": "2026-10-10T08:13:00-03:00",
    "atualizadoEm": "2026-10-16T10:00:00-03:00"
  },
  "contrato": { "estado": "ativo", "desde": "2026-09-30", "atualizadoEm": "2026-10-16T10:01:00-03:00" },
  "onu": { "serial": "ZTEGC1234567", "modelo": "F670L", "olt": "OLT_SANTA_INES", "vlan": 2500 }
}
```

- **`fibra.estado`:** `online` | `offline` | `loss` | `sem_energia` | `inativo` | `desabilitada` | `desconhecido`. São os status reais do OLTCloud (`equipment/list`). `sinalDbm` nulo quando o OLTCloud devolve o sentinela `-99.99` (nunca repassar o sentinela como dBm).
- **`autenticacao.estado`:** `conectado` | `desconectado` | `desconhecido`. Origem: NE40 (`display access-user username <login>`), com `ip` e `desde` quando conectado.
- **`contrato.estado`:** `ativo` | `bloqueado` | `suspenso` | `cancelado` | `desconhecido`. Origem: Voalle (`contracts.status`, bloqueio administrativo).
- **O login não existe (ou a ONU ainda não foi autorizada):** `404`.
- **Parâmetro `?fresh=true`:** força consulta direta ao NE40 e ao OLTCloud só para esse cliente (botão "consultar novamente" da tela). A Wiki **enfileira** essas consultas (no NE40, uma por vez, como já faz no poller) e pode responder `429` com `Retry-After` em vez de abrir conexões em paralelo (o NE40 rejeita SSH simultâneo; 4 de 8 falharam no teste da Wiki). Sem `fresh`, responde do último snapshot.

### `POST /clientes/status`
Para o dashboard (fibra online e PPPoE conectado lado a lado) e para os alarmes. Lote de até 200 logins, **sempre do snapshot**, nunca consulta ao vivo.

```json
{ "logins": ["12345-JHV", "12346-JHV"] }
```
```json
{ "clientes": [
  { "login": "12345-JHV", "fibra": "online", "autenticacao": "conectado", "contrato": "ativo", "fibraEm": "...", "autenticacaoEm": "..." },
  { "login": "12346-JHV", "fibra": "loss", "autenticacao": "desconectado", "contrato": "bloqueado", "fibraEm": "...", "autenticacaoEm": "..." }
] }
```
Login desconhecido aparece com os três estados `desconhecido`, não derruba o lote.

**[PERGUNTA 1]** O poller do NE40 de PPPoE da Wiki hoje cobre os clientes PJ cadastrados, a cada 15 min, com concorrência 5 e intervalo de 2 s. Dá para **incluir os logins da rede neutra nesse mesmo poller** (ou num irmão), gravando `online` e `ip` por login, para servir este lote? Com o piloto (dezenas de clientes) o volume é pequeno. Se existir um comando do NE40 que liste as sessões de uma só vez, é ainda melhor; o portal aceita o intervalo que a Wiki conseguir (15 min está bom).

### `GET /clientes/{login}/sinal?dias=30`
Série para o gráfico da tela do cliente, da `onu_signal_history` (uma leitura a cada 6 h desde 1/7/2026), mais as quedas.

```json
{
  "login": "12345-JHV",
  "dias": 30,
  "pontos": [{ "em": "2026-09-16T00:00:00-03:00", "rxDbm": -21.0 }, { "em": "2026-09-16T06:00:00-03:00", "rxDbm": -21.2 }],
  "quedas": [{ "inicio": "2026-10-03T14:40:00-03:00", "fim": "2026-10-03T15:05:00-03:00", "tipo": "loss" }],
  "instalacao": { "em": "2026-09-30T16:20:00-03:00", "rxDbm": -21.4 }
}
```
- Pontos com o sentinela `-99.99` são **omitidos** (a Wiki já trata o sentinela como "sem leitura óptica").
- `dias` até 90. `quedas.tipo`: `loss` | `sem_energia` | `offline`; `fim` nulo se ainda está caída. `instalacao` é opcional (o portal tem o sinal final da O.S., então pode ficar só no portal).

### Eventos e alarmes
O planejamento pede alarme no dashboard quando um cliente entra em `loss` e aviso opcional por WhatsApp. **Proposta:** o portal compara o `POST /clientes/status` de cada ciclo e gera o alarme na **transição**. Dispensa uma rota de eventos na v3. **[PERGUNTA 2]** Para a **queda regional** (o `cto-off-monitor` da Wiki, que já abre incidente quando 100% dos clientes de uma CTO caem), dá para expor `GET /ctos/{ctoId}/incidente` (aberto ou não, desde quando, tipo isolada ou massiva)? É o que alimenta o aviso "sua CTO está fora" sem o parceiro abrir chamado.

---

## B. Senha PPPoE sob demanda

### `GET /clientes/{login}/senha-pppoe`
O planejamento pede a senha **visível só para quem precisa, com registro de quem consultou**. Proposta: a senha **não é guardada no portal**. O portal a busca na Wiki a cada consulta autorizada, exibe uma vez e registra na auditoria quem pediu (sem gravar o valor).

```json
{ "login": "12345-JHV", "senha": "…", "consultadoEm": "2026-10-16T10:05:00-03:00" }
```
- **Nunca em log, nunca em cache**, e `Cache-Control: no-store`. A Wiki também registra a consulta (login, hora, chave usada).
- **[DECIDIR]** a fonte é o Voalle (`authentication_contracts.password`?). Depende do analista de Voalle (Tarefa 1 do briefing). No contrato v2 a saída do script do OLTCloud traz a senha em texto puro e **não** deve ser usada como fonte.

---

## C. Automações do cliente (escrita, `X-RedeNeutra-Write-Key`)

### `POST /clientes/{login}/bloqueio`
```json
{ "idempotencyKey": "…", "acao": "bloquear", "motivo": "inadimplência" }
```
`acao`: `bloquear` | `desbloquear`. Responde `202 {"operacaoId": "..."}`.

- **Como bloquear:** o planejamento prefere o **bloqueio administrativo do contrato no Voalle** (reversível, mantém histórico). A troca de PPPoE fica como recurso secundário.
- **[DECIDIR / depende do analista]** a rota do Voalle para bloqueio administrativo ainda **não é conhecida** (só o desbloqueio por confiança, `contracts/unlock`, aparece na API de terceiros, e ele tem outro significado). O resultado da Tarefa 2 do briefing do analista define o desenho. Se não houver API, o bloqueio fica **semi-manual**: a operação vira `aguardando_equipe` e abre card no Kanban da Speed.
- O cliente bloqueado **continua ocupando a porta e sendo faturado** (regra comercial do planejamento); o bloqueio não mexe no OLTCloud nem na vaga.

### `POST /clientes/{login}/reinicio`
```json
{ "idempotencyKey": "…" }
```
Reinício remoto da ONU/CPE pelo ACS (TR-069).

- A Wiki já conhece as armadilhas: o device do ACS é resolvido via `rssi_analysis` (serial hexadecimal ou MAC), e o `/reboot` só aceita o serial hexadecimal.
- **O ACS pode devolver 504 mesmo tendo reiniciado.** Por isso a operação **só vira `concluida` quando a Wiki confirma pelo uptime** (o `uptime_since` da ONU volta a zero) dentro de até 5 min. Sem confirmação: `sem_confirmacao` (não é falha), e o portal diz "confira o status antes de tentar de novo".
- ONU sem módulo ACS: `falhou` com `motivo: "sem_acs"`.

### `POST /clientes/{login}/cancelamento`
```json
{ "idempotencyKey": "…", "motivo": "pedido do cliente" }
```
Encerra o contrato, remove a ONU e **devolve a porta**. Três etapas, cada uma com estado próprio na operação:

| Etapa | Onde age |
|---|---|
| `contrato_encerrado` | Voalle |
| `onu_removida` | OLTCloud (desautoriza a ONU) |
| `porta_devolvida` | Codemaps (libera a ocupação) |

- Falha no meio: a operação fica `parcial` com o estado de cada etapa, e **repetir a mesma `idempotencyKey` continua de onde parou**, sem refazer as etapas concluídas.
- **[DECIDIR]** o planejamento pede **impedir o cancelamento com fatura em aberto**, conforme regra comercial. A Wiki consegue consultar títulos em aberto no Voalle (API de terceiros)? Se sim, `409 fatura_em_aberto` antes de qualquer etapa. Caso contrário, a regra fica só no portal, por confirmação explícita do parceiro.
- Ao `concluida`, o portal marca a reserva como cancelada e **libera a vaga** na contagem.

### `GET /operacoes/{id}`
```json
{
  "operacaoId": "…",
  "tipo": "cancelamento",
  "login": "12345-JHV",
  "estado": "parcial",
  "etapas": [
    { "nome": "contrato_encerrado", "estado": "concluida" },
    { "nome": "onu_removida", "estado": "falhou", "motivo": "OLT sem resposta" },
    { "nome": "porta_devolvida", "estado": "pendente" }
  ],
  "atualizadoEm": "2026-10-16T10:07:00-03:00"
}
```
Estados da operação: `recebida` · `executando` · `concluida` · `parcial` · `sem_confirmacao` · `aguardando_equipe` · `falhou`. `motivo` em português curto, nunca com segredo ou saída crua de equipamento.

---

## D. Chamados de infraestrutura

O chamado é do portal para o parceiro; na Wiki cai na fila da Infra, marcado como rede neutra (o parceiro não sabe da Wiki).

### `POST /chamados` (escrita)
```json
{
  "idempotencyKey": "…",
  "tipo": "cto_com_problema",
  "origem": "parceiro",
  "parceiro": { "codigo": "JHV", "nome": "JHV Telecom" },
  "ctoId": "17342",
  "login": "12345-JHV",
  "descricao": "Caixa aberta, fibras desorganizadas.",
  "sinalMedidoDbm": -23.4,
  "slaHoras": 24,
  "fotos": [{ "tipo": "medicao", "url": "https://…/api/photos/shared/…" }]
}
```
- **`tipo`:** `cto_com_problema` · `porta_off` · `conferencia_porta` · `sinal_fora_padrao_cto` · `rompimento_regional` · `trava_sinal` (automático, origem `sistema`, com as duas medições e a justificativa no texto). São os motivos do planejamento.
- **Fotos:** o portal manda **link assinado de 48 h**, sem conta da Infra. Como o link expira, **a Wiki baixa as fotos na hora da criação** e guarda do lado dela. [PERGUNTA 3]
- **SLA:** os prazos por tipo são **configurados no portal** (tela de administração, sem alterar código, como o planejamento pede) e o portal manda `slaHoras`. A Wiki guarda e mostra à Infra; os valores ainda dependem da diretoria **[DECIDIR]**.
- **Resposta `201`:** `{ "chamadoId": "…", "estado": "aberto" }`.
- **[PERGUNTA 4] Onde cai na Wiki.** A tabela `incidents` não tem endpoint externo. O `POST /proxy/kanban/cards` (`X-Kanban-Key`, dedupe por `external_ref`) já existe e serve de caminho curto: card na coluna DEMANDAS de um board da Infra, com `source: "redeneutra"` e `external_ref: <chamadoId>`. Esse caminho cobre a v3? E o estado do chamado se deduz da coluna do card (DEMANDAS = `aberto`, colunas intermediárias = `em_atendimento`, concluído = `resolvido`)? Se preferirem a tabela `incidents`, precisamos de um endpoint novo.

**Trava de sinal (importante, muda o v2):** quando o técnico escolhe `prosseguir`, **o portal abre o chamado** `trava_sinal` por esta rota (`origem: "sistema"`, com as duas medições na descrição e o link da foto da medição). Portanto **a Wiki NÃO deve abrir o card no Kanban por conta própria** na decisão `prosseguir` do v2: só provisiona. Sem isso, a Infra recebe dois cards para a mesma trava.

### `GET /chamados/{id}`
```json
{
  "chamadoId": "…",
  "estado": "em_atendimento",
  "atualizadoEm": "…",
  "historico": [
    { "em": "…", "autor": "sistema", "texto": "Chamado aberto." },
    { "em": "…", "autor": "infra", "texto": "Técnico a caminho." }
  ],
  "resolucao": null
}
```
`estado`: `aberto` · `em_atendimento` · `aguardando_parceiro` · `resolvido` · `cancelado`. `autor`: `parceiro` | `infra` | `sistema` (a Infra aparece só como "Infra da Speed" para o parceiro). **O portal consulta por polling** (a cada poucos minutos, só os chamados abertos); webhook com assinatura HMAC fica para uma versão futura.

### `POST /chamados/{id}/mensagens` (escrita)
`{ "idempotencyKey": "…", "texto": "…" }`: o parceiro acrescenta informação; vai para o histórico e para o card.

---

## E. Ordem sugerida de entrega (do que mais destrava para o que mais depende de terceiros)

1. **`/clientes/{login}/status` e `/clientes/{login}/sinal`** (só leitura, dados que a Wiki já tem). Destravam a tela do cliente.
2. **`POST /clientes/status` com snapshot de PPPoE** (pergunta 1). Destrava o dashboard com fibra e PPPoE lado a lado e os alarmes.
3. **Chamados** (pergunta 4) e a **trava de sinal** automática do v2.
4. **Reinício** (já existe a base no ACS).
5. **Bloqueio e desbloqueio** (depende da rota do Voalle, analista).
6. **Cancelamento** (três sistemas, depende do Voalle) e **senha PPPoE** (depende de onde a senha mora).

## F. Perguntas consolidadas para a Wiki
1. Incluir os logins da rede neutra no poller de PPPoE do NE40 e servir o lote do snapshot? Intervalo possível?
2. Expor o incidente de CTO (`cto-off-monitor`) por CTO?
3. A Wiki baixa as fotos do chamado na criação (link assinado de 48 h)?
4. Chamados: Kanban externo ou `incidents`? Qual board? Como mapear colunas em estados?
5. A busca por `alias` no OLTCloud (`device_alias` = login PPPoE) é confiável para achar a ONU de um login, ou é melhor o portal mandar também a serial (que ele já tem da ativação)?
6. Retenção da `onu_signal_history`: serve para `dias=90`?

## G. No portal
- Interfaces novas em `integrations/types.ts`: `CustomerStatusService`, `TicketService` e `CustomerActions`, cada uma com **mock** e cliente real da Wiki que valida a resposta contra este contrato.
- Escrita (`bloqueio`, `reinicio`, `cancelamento`, `chamados`) atrás de `AUTOMATION_MODE=off|mock|wiki`, **desligado por padrão**, como o `ACTIVATION_MODE`. Só liga com a validação explícita do Juan.
- Auditoria de toda consulta de senha, bloqueio, reinício, cancelamento e chamado (`recordAudit`), sempre sem o valor da senha.
- A leitura (`status`, `sinal`) usa o mesmo `INTEGRATIONS_MODE` e a chave de leitura do v1.
