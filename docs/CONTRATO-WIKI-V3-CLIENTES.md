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
- **Sem senha em log, em lista ou em cache.** O portal nunca vê nem guarda senha PPPoE (ver seção B).

---

## A. Leitura do cliente

> **Entregue pela Wiki em 16 out 2026 (v3, leitura).** `GET /v3/clientes/{login}/status`, `POST /v3/clientes/status` (lote até 200) e `GET /v3/clientes/{login}/sinal?dias=1..90`, com a chave de leitura e `X-RedeNeutra-Partner` obrigatório. Erros: 400 `parceiro_invalido` ou `login_invalido`; 403 `login_de_outro_parceiro` (no lote, qualquer login de outro parceiro recusa a requisição inteira); 404 `login_desconhecido` (sem ONU com esse alias). A ONU precisa ter o alias igual ao login (`12345-JHV`). Até o snapshot do NE40 entrar, `autenticacao` vem `desconhecido` com `motivo: "pppoe_ainda_nao_disponivel"` (o portal mostra "leitura do PPPoE ainda não disponível"). `onu.vlan` é null quando a ONU tem mais de uma VLAN. As quedas da série têm resolução de 6 h. `?fresh=true` é aceito mas hoje não muda nada (a leitura já é ao vivo). Pergunta 1: a Wiki vai incluir os logins da rede neutra no poller do NE40 (próximo item deles). Pergunta 5: a ONU é achada por alias, casamento exato (alias ou login PPPoE); a Wiki aceita também a serial se for mais confiável para nós. Pergunta 6: `dias` até 90, histórico desde 01/07/2026.

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

## B. Senha PPPoE: não existe rota

**Decisão da Speed (16 out 2026):** a rede neutra usa a **mesma senha PPPoE padrão** dos demais clientes da Speed. A Wiki a grava ao criar o contrato; não há rota de senha, nem entrega de senha na criação do contrato, nem ação de "trocar senha". O parceiro recebe a senha padrão pelo canal comercial, fora do sistema. A ativação da ONU só precisa do login: o OLTCloud busca a senha sozinho ao configurar a ONU, e o técnico não digita senha no fluxo normal. Por isso a rota `GET /clientes/{login}/senha-pppoe` **saiu do contrato v3**.

---

## C. Automações do cliente (escrita, `X-RedeNeutra-Write-Key`)

### `POST /clientes/{login}/bloqueio`
```json
{ "idempotencyKey": "…", "acao": "bloquear", "motivo": "inadimplência" }
```
`acao`: `bloquear` | `desbloquear`. Responde `202 {"operacaoId": "..."}`.

- **Como bloquear:** o planejamento prefere o **bloqueio administrativo do contrato no Voalle** (reversível, mantém histórico). A troca de PPPoE fica como recurso secundário.
- **[DECIDIR / depende do analista]** a rota do Voalle para bloqueio administrativo ainda **não é conhecida** (só o desbloqueio por confiança, `contracts/unlock`, aparece na API de terceiros, e ele tem outro significado). O resultado da Tarefa 2 do briefing do analista define o desenho. Se não houver API, o bloqueio fica **semi-manual**: a operação vira `aguardando_equipe` e abre card no Kanban da Speed.
- O cliente bloqueado **continua ocupando a porta e sendo faturado** (regra comercial do planejamento); o bloqueio não mexe no OLTCloud nem na vaga. **Atualização (18 out):** como o contrato no Voalle não tem valor, "continuar faturado" é responsabilidade do **portal** (a porta bloqueada segue no fechamento). A **suspensão** do Voalle (`Contract/Suspend`) deixa de ter o problema de parar a cobrança e passa a ser o caminho recomendado para o bloqueio automático, se ela cortar o PPPoE (confirmar).

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
- ~~**[DECIDIR]** impedir o cancelamento com fatura em aberto~~ **(sem efeito, 18 out):** não há fatura no Voalle para esses contratos. A inadimplência do parceiro com a Speed é tratada pela Speed fora do ERP (e, no portal, pelo bloqueio do parceiro). O portal não manda nem espera `409 fatura_em_aberto`.
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
6. **Cancelamento** (três sistemas, depende do Voalle). A senha PPPoE não tem rota (seção B).

## F. Perguntas consolidadas para a Wiki
1. Incluir os logins da rede neutra no poller de PPPoE do NE40 e servir o lote do snapshot? Intervalo possível?
2. Expor o incidente de CTO (`cto-off-monitor`) por CTO?
3. A Wiki baixa as fotos do chamado na criação (link assinado de 48 h)?
4. Chamados: Kanban externo ou `incidents`? Qual board? Como mapear colunas em estados?
5. A busca por `alias` no OLTCloud (`device_alias` = login PPPoE) é confiável para achar a ONU de um login, ou é melhor o portal mandar também a serial (que ele já tem da ativação)?
6. Retenção da `onu_signal_history`: serve para `dias=90`?

## H. Criação de contrato (proposta da Wiki, 16 out 2026; aceita pelo portal, decisões abertas)

A Wiki já tem a criação de contrato no Voalle construída e desligada: `contracts/create` cria o contrato no nome do **parceiro** (um CNPJ com todos os contratos), a conexão PPPoE nasce junto com login igual ao número do contrato, e a Wiki troca para `<contrato>-<CÓDIGO>`, gera a senha (nunca devolvida nem em log), define o ponto de acesso pela sigla da CTO (R1 = 2, ITA = 3, FAT = 11) e o concentrador acompanha. O Voalle sobrescreve o endereço principal do cliente a cada contrato, então a Wiki manda sempre o endereço do cadastro do parceiro e grava o endereço real do assinante só na conexão (API de mapas, com coordenada). Falta só configuração no Voalle (tipo de contrato com "Integração" e campanha "E-commerce - Integração").

### `POST /proxy/redeneutra/v3/contratos` (escrita, `X-RedeNeutra-Write-Key`, `X-RedeNeutra-Partner` obrigatório)
```json
{
  "idempotencyKey": "uuid",
  "reservaId": "id da reserva no portal (vai na observação do contrato)",
  "parceiroCnpj": "00000000000000",
  "plano": { "velocidadeMbps": 600, "valorMensal": 0 },
  "ctoId": "24109",
  "endereco": { "cep": "34505000", "rua": "Rua ...", "numero": "10", "complemento": "", "bairro": "...", "cidade": "Sabará", "uf": "MG" },
  "location": { "lat": -19.89, "lng": -43.86 }
}
```
- `422 parceiro_sem_cadastro`: o parceiro precisa estar no Voalle com esse CNPJ e endereço completo. `422 plano_nao_configurado`: a velocidade não tem serviço mapeado na Wiki.
- Nenhum nome de assinante. O endereço e a coordenada são da instalação e só vão para a conexão.
- `202 { "operacaoId": "..." }`; `GET /v3/operacoes/{id}` com `tipo: "contrato"`, etapas `contrato_criado`, `conexao_ajustada` e `endereco_gravado`, e, ao concluir, `resultado: { "contrato": "33431", "login": "33431-JHV" }`.
- **Contrato sem valor (Juan, 18 out 2026):** o contrato no Voalle **não cobra nada**. Ele existe só para **identificar o cliente** (o número do contrato é a chave) e **gerar a conexão PPPoE** (login `<contrato>-<CÓDIGO>`, ponto de acesso, perfil de velocidade no RADIUS). O parceiro **paga direto ao dono da Speed, fora do ERP**, pelo fechamento do portal (portas ativas × valor fixo por plano). O portal manda sempre `valorMensal: 0`; a velocidade só escolhe o serviço/perfil. **Por isso a aprovação deixa de ser decisão de cobrança:** se o Voalle exigir contrato aprovado para a conexão autenticar, a Wiki pode aprovar já na criação. ~~Proposta da Wiki: aprovar quando a ONU chega a `online`, para a cobrança começar na porta ativada~~ (superada). Reserva cancelada antes da ativação: o contrato é cancelado (rota de cancelamento abaixo).

**Estados e repetição (como o portal trata):** `recebida`, `executando`, `concluida`, `parcial`, `aguardando_equipe` e `falhou`. Em `parcial` o portal repete o `POST` com a **mesma `idempotencyKey`** e a Wiki deve continuar de onde parou, sem criar outro contrato. Em `falhou` **depois de uma etapa concluída** (`contrato_criado`, por exemplo) o portal **não permite novo pedido**, porque uma chave nova criaria um segundo contrato e deixaria o primeiro órfão: a Speed conclui ou cancela no Voalle e marca como abandonado no portal. Em `falhou` sem etapa concluída (recusa na entrada: `parceiro_sem_cadastro`, `plano_nao_configurado`) o parceiro pode pedir de novo. `aguardando_equipe` vale para etapa manual. O fluxo inteiro está em [`FLUXO-CONTRATO-E-CONEXAO.md`](FLUXO-CONTRATO-E-CONEXAO.md).

**Respostas da Wiki (18 out):** contrato sem valor funciona (510 contratos de valor zero autenticam); a Wiki **aprova na criação** (contrato não aprovado quase nunca autentica no NE40); o estado do contrato vem `pendente_aprovacao`, `rejeitado` (novo), `ativo`, `bloqueado`, `suspenso` ou `cancelado`; repetir `parcial` com a mesma chave é seguro; ao cancelar, o Voalle apaga a conexão. O cancelamento abaixo foi **aceito** (com `contrato_cancelado` em `aguardando_equipe`, porque o Voalle não cancela por API). Detalhes em [`FLUXO-CONTRATO-E-CONEXAO.md`](FLUXO-CONTRATO-E-CONEXAO.md).

**Pedido à Wiki sobre cancelamento (aceito):** hoje não há como cancelar por API um contrato criado e não aprovado (reserva abandonada, cliente que desistiu). Proposta: `POST /v3/contratos/{operacaoId}/cancelamento` (escrita, mesma chave e headers), válido só para contrato **não aprovado**, devolvendo `202 {operacaoId}` e acompanhado por `GET /v3/operacoes/{id}` (etapas `contrato_cancelado` e `conexao_removida`). Sem isso a Speed cancela à mão no Voalle.

**Estado do contrato na leitura (seção A):** para contrato criado e ainda não aprovado, o portal espera `contrato.estado = "pendente_aprovacao"`. Estado que o portal não conheça vira "Sem leitura" (com aviso no log), sem derrubar a resposta. Confirmar o texto.

**Entregue pela Wiki (21 out 2026, 00:18 BRT):** a etapa `cliente_no_oltcloud` está no ar. A Wiki procura o login no OLTCloud; se não existe, **importa a conexão do Voalle** (como a importação manual do 33720), e não usa `client/create`: o cliente nasce igual ao da sincronização e não duplica. Recusa do OLTCloud deixa a etapa `falhou` e a operação `parcial` (repetir com a mesma chave continua dali); erro de rede tenta de novo sozinho; quando precisa de alguém (pedido sem lat/lng, mais de uma conexão, importação sem confirmação) a **etapa** fica `aguardando_equipe` e vira card para a equipe. O `resultado` passa a trazer também `oltcloudClienteId` (o portal ignora). A sincronização automática Voalle → OLTCloud está **desligada** no OLTCloud; o teto de 2 h da ativação fica só como rede de segurança. Ajuste no portal (21 out): as etapas aceitam `aguardando_equipe` (contratos e ações do cliente); antes a resposta inteira era recusada.

**Pedido à Wiki: o cliente nasce no OLTCloud junto com o contrato (21 out 2026, urgente).** No primeiro teste real (contratos 33719 e 33720) a ativação ficou em `aguardando_cliente` até a Wiki importar o cliente no OLTCloud à mão, e a sincronização Voalle → OLTCloud não tem prazo. Com o técnico na casa do cliente essa espera não pode existir. Proposta: uma 4ª etapa na mesma operação, **`cliente_no_oltcloud`**, depois de `endereco_gravado`, que cria o cliente no OLTCloud (`POST /api/v2/client/create`) com o login `<contrato>-<CÓDIGO>` e conclui quando ele já pode receber a ONU. Regras:
- A operação só fica `concluida` depois dessa etapa. Falha nela segue as regras de sempre: `parcial` (repetir com a mesma chave continua daqui, sem criar outro contrato) ou `aguardando_equipe` se precisar de alguém.
- Cliente já existente no OLTCloud com o mesmo login (sincronização chegou antes) conta como concluída, sem duplicar.
- O `resultado` não muda (`contrato`, `login`). O id do cliente no OLTCloud é opcional e o portal não depende dele.
- **Portal (pronto, 21 out 2026):** o contrato agora é criado **no agendamento**, pelo cartão da reserva, e não mais com o técnico em campo. O cartão mostra "Pronto para instalar" **só** com `cliente_no_oltcloud` concluída; sem ela mostra "Contrato criado". O sino avisa visita de hoje ou amanhã sem contrato concluído. A etapa já tem texto na tela ("Cliente no sistema de rede"); nada mais muda do lado do portal.

**Impacto no portal (a construir):** hoje o atendente digita o número do contrato ao pedir a ativação. Com esta rota o número nasce da criação automática, e o login passa a vir da operação. Isso muda o fluxo da etapa de contrato e fica atrás de um modo próprio (desligado por padrão) até a Wiki entregar e o Juan validar.

## Respostas da Wiki ao pedido (16 out 2026, após as respostas do suporte da Voalle)

- **Bloqueio:** a API do Voalle não tem bloqueio administrativo, só **suspensão** (`Contract/Suspend`, com justificativa). `contracts/unlock` não desfaz bloqueio administrativo. A suspensão provavelmente **interrompe a cobrança**, o que contradiz "bloqueio mantém porta e cobrança". **[DECIDIR - Juan]** (a) inadimplência vira suspensão via API, aceitando que a cobrança pare, ou (b) bloqueio administrativo manual: a operação vira `aguardando_equipe` e abre card no Kanban (fallback já previsto no portal).
- **Senha PPPoE:** decidido que não haverá rota (ver seção B). A Wiki grava a senha padrão da Speed ao criar o contrato.
- **Cancelamento:** não há endpoint de cancelar contrato na API para Terceiros (perguntado à Voalle). Até a resposta, a etapa `contrato_encerrado` vira `aguardando_equipe` (card no Kanban) e as outras duas (OLTCloud e Codemaps) seguem automáticas. **`409 fatura_em_aberto`:** quem paga é o parceiro, não o assinante, então consultar "fatura em aberto do cliente" não faz sentido. **[DECIDIR - Juan]** a regra vira "parceiro com fatura vencida não cancela", ou sai.
- **PPPoE no snapshot do NE40** é o próximo item da Wiki; o **incidente por CTO** (`cto-off-monitor`) entra junto.
- **VLAN:** a ONU tem mais de uma (ex.: 1000 e 29) e a Wiki ainda não sabe qual é a de gerência; fica `null` até confirmar com a Infra. Não bloqueia.
- **CTO 52108 (`CTO_12_P2_P4_R1`):** sem caixa no OLTCloud, então `/vagas` responde 404 e ela fica fora do mapa por sigla (esperado: "conferir"). As fontes divergem (Codemaps: 8 saídas ocupadas no diagrama, 1 livre na lista).
- **CTO 24109:** Rua Carvalho de Brito, bairro Nações Unidas, Sabará. O geocoder do Codemaps erra o ponto nessa rua (370 a 840 m); para validar a reserva, usar a CTO pelo mapa por sigla, não por endereço.
- **Viabilidade do Codemaps** devolve no máximo 10 CTOs, mesmo com raio de 1 km. Em área densa, uma CTO mais distante pode não aparecer.
- **Achar a ONU:** por casamento exato do alias ou do login PPPoE; mandar a serial também é bem-vindo.
- **Chamados:** Kanban externo com `external_ref = chamadoId`, `source: "redeneutra"` serve. **[DECIDIR - Juan]** qual board e quais colunas valem como `em_atendimento` e `resolvido`, e confirmar que a Wiki baixa as fotos na criação (o link expira em 48 h). Trava de sinal: a Wiki não abre card próprio no `prosseguir`. SLA: a Wiki só guarda e mostra.
- **Ordem na Wiki:** PPPoE no snapshot + incidente por CTO; criação de contrato (assim que o Voalle estiver configurado, testada primeiro num contrato da Speed); chamados; reinício, ativação (v2), bloqueio e cancelamento. Toda escrita continua desligada até a validação do Juan.

## I. Diagnóstico da ONU para o suporte do parceiro (pedido do portal, 22 out 2026)

**Para quê:** a tela "ONUs" do portal, onde o suporte ou o dono do provedor vê todas as ONUs dos seus clientes e diagnostica um chamado do assinante sem ligar para a Speed. O semáforo da seção A diz *se* o cliente está no ar; isto diz *por quê* não está (luz chegando, energia, distância, porta inteira caída, Wi-Fi ruim dentro de casa). Tudo é leitura do que a Wiki já consulta no OLTCloud para a própria tela "Consultar ONU" (`equipment/list`, `ftth/pons/attenuations`, `acs/{id}/rssi_analysis`).

### `GET /clientes/{login}/onu` (leitura, `X-RedeNeutra-Key`, `X-RedeNeutra-Partner` obrigatório)
Leitura **ao vivo** do OLTCloud, uma ONU por vez (o portal chama quando o suporte abre a ONU e no botão "Atualizar", no máximo a cada 60 s por tela aberta). Mesmas regras de sempre: `403 login_de_outro_parceiro`, `404 login_desconhecido` (corpo JSON com esse `error`; o portal trata 404 sem esse corpo como "rota ainda não publicada"), `429` com `Retry-After` se precisar enfileirar.

```json
{
  "login": "12345-JHV",
  "lidoEm": "2026-10-22T15:04:00-03:00",
  "onu": {
    "serial": "HWTC6FE1FCB2",
    "modelo": "EG8145X6",
    "estado": "online",
    "olt": "OLT_BACKBONE_CENTRAL",
    "slot": 1,
    "pon": 15,
    "rxDbm": -21.4,
    "txDbm": 2.1,
    "rxOltDbm": -24.8,
    "temperaturaC": 48.0,
    "distanciaM": 1830,
    "ligadaDesde": "2026-10-20T09:12:00-03:00",
    "ultimaQuedaEm": "2026-10-19T22:40:00-03:00",
    "sinalLidoEm": "2026-10-22T15:01:00-03:00"
  },
  "pon": { "onus": 42, "offline": 3, "mediaRxDbm": -20.9 },
  "wifi": {
    "online": true,
    "lidoEm": "2026-10-22T15:03:00-03:00",
    "dispositivos": [
      { "nome": "Galaxy-A54", "mac": "AA:BB:CC:DD:EE:01", "banda": "5GHz", "ssid": "CASA", "rssiDbm": -58, "online": true }
    ]
  }
}
```
- **`onu`:** campos do `equipment/list` (`device_rx`, `device_tx`, `olt_rx`, `temperature`, `distance` em metros, `uptime_since`, `last_disconnection`, `last_signal_update`). `estado` com os mesmos valores de `fibra.estado` da seção A. Sentinela `-99.99` vira `null`; qualquer campo que o OLTCloud não tenha vem `null`.
- **`pon`:** a porta inteira da OLT (todas as ONUs dessa `olt`/`slot`/`pon`, de todos os clientes da Speed, só a contagem): total, quantas fora de Online e a média de RX da porta (`avg_rx_onu` do `pons/attenuations`). É o que separa "problema do cliente" de "falha na rede". Nunca vem lista de ONUs nem nome de outro cliente. `null` se não der para ler.
- **`wifi`:** do módulo ACS (`rssi_analysis`, tentando a serial e os MACs como a Wiki já faz). `dispositivos` são os aparelhos ligados no roteador do assinante (nome do aparelho, MAC, banda, SSID, RSSI médio). `null` quando a ONU não tem roteador no ACS ou o ACS não responde. **Nunca a senha do Wi-Fi.**
- Cada bloco responde por si: `pon` ou `wifi` fora do ar vêm `null` e a rota segue `200`.

### Pedido junto: `sinalDbm` no lote
No `POST /clientes/status`, mandar também `sinalDbm` (o `device_rx` do snapshot, `null` sem leitura). A lista da tela "ONUs" mostra o sinal de cada cliente sem abrir um por um. Opcional: sem o campo, a lista mostra "—".

### No portal (pronto contra mock, 22 out 2026)
Tela **ONUs** (atendente e supervisor do parceiro): lista de todas as ONUs com O.S. fechada, do snapshot (`POST /clientes/status`), com busca e filtro "com problema"; ao abrir uma, `GET /clientes/{login}/onu` e um **diagnóstico em português** calculado pelo portal (porta inteira caída, sem luz, sem energia, sinal abaixo do mínimo da instalação, PPPoE caído com fibra boa, Wi-Fi com aparelhos de sinal ruim). Ações que já existem (reiniciar, abrir chamado) ficam na mesma tela. Enquanto a rota não existir, o detalhe mostra só o semáforo da seção A e avisa que o diagnóstico completo ainda não está disponível.

## G. No portal
- Interfaces novas em `integrations/types.ts`: `CustomerStatusService`, `TicketService` e `CustomerActions`, cada uma com **mock** e cliente real da Wiki que valida a resposta contra este contrato.
- Escrita (`bloqueio`, `reinicio`, `cancelamento`, `chamados`) atrás de `AUTOMATION_MODE=off|mock|wiki`, **desligado por padrão**, como o `ACTIVATION_MODE`. Só liga com a validação explícita do Juan.
- Auditoria de toda consulta de senha, bloqueio, reinício, cancelamento e chamado (`recordAudit`), sempre sem o valor da senha.
- A leitura (`status`, `sinal`) usa o mesmo `INTEGRATIONS_MODE` e a chave de leitura do v1.
