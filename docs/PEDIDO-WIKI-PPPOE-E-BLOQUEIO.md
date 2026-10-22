# Pedido à SpeedWiki (22 out 2026): PPPoE no snapshot e bloqueio pela ONU

Complementa o [`PEDIDO-WIKI.md`](PEDIDO-WIKI.md). O fluxo de contrato e ativação já está provado em produção (contratos 33720, 33721 e 33726 em ONU de bancada); obrigado pela etapa `cliente_no_oltcloud`. Restam dois assuntos de rede. O primeiro é um pedido; o segundo é só uma consulta de viabilidade, sem prazo.

## 1. PPPoE de rede neutra no snapshot do NE40 (pedido)

**Situação hoje.** `GET /v3/clientes/{login}/status` e `POST /v3/clientes/status` respondem, mas a fonte NE40 vem `autenticacao: "desconhecido"` para os logins `<contrato>-<CÓDIGO>`. No portal isso mostra "leitura do PPPoE ainda não disponível" na tela do cliente, e o painel do parceiro não consegue mostrar fibra online e PPPoE conectado lado a lado nem alarmar PPPoE caído.

**O que pedimos** (já combinado em princípio na pergunta 1 do contrato v3):

1. Incluir os logins da rede neutra (terminados em `-JHV` no piloto; depois outros códigos) no poller de PPPoE do NE40, ou num poller irmão.
2. Servir pelo snapshot, por login: `autenticacao.estado` (`conectado` | `desconectado`), `ip` e `desde` quando conectado, e `autenticacaoEm` (hora da leitura, para o portal marcar dado velho acima de 30 min).
3. `POST /v3/clientes/status` (lote de até 200) passa a devolver isso do snapshot, sem abrir SSH por chamada.
4. Intervalo de até 15 min serve. Se o NE40 tiver um comando que liste as sessões de uma vez, melhor ainda; o portal aceita o que a Wiki conseguir.
5. `?fresh=true` segue como está (fila no NE40, uma consulta por vez, `429` com `Retry-After`).

**Como a Wiki descobre a lista de logins.** Duas opções, a que for mais simples para vocês:

- (a) a Wiki lê os contratos com conexão `<contrato>-<CÓDIGO>` no Voalle (os que ela mesma criou por `POST /v3/contratos`);
- (b) o portal manda a lista, por exemplo `PUT /v3/clientes/monitorados` com `{ "logins": [...] }`. Podemos construir se a Wiki preferir.

**Como validamos.** Contrato 33726-JHV (ou um novo da bancada) com a ONU online: `status` deve trazer `autenticacao: conectado` com `ip`. Depois, desconectar a ONU de bancada e conferir `desconectado` no ciclo seguinte. Não precisa mudar nada no portal: `CLIENT_STATUS_MODE=wiki` já está ligado e a tela passa a mostrar o dado sozinha.

**Cuidado conhecido.** O NE40 recusa SSH simultâneo (4 de 8 falharam no teste de vocês). Manter a concorrência baixa, como no poller atual (5, intervalo de 2 s).

## 2. Bloqueio pela ONU, sem depender do Voalle (consulta de viabilidade)

**Contexto.** O contrato no Voalle não cobra nada: o parceiro paga à Speed pelo fechamento do portal. Por isso o bloqueio por inadimplência do assinante é decisão do **parceiro**, e a Speed só precisa ter um jeito confiável de cortar o serviço. Hoje o portal pede `POST /v3/clientes/{login}/bloqueio` e a Wiki depende de a suspensão do Voalle cortar o PPPoE (ainda não testado).

**Ideia em estudo (Juan).** O supervisor do parceiro aperta "Bloquear" no cliente e a Speed corta o serviço **na própria ONU/rede**, sem passar pelo Voalle. O contrato, a porta e a cobrança do parceiro continuam como estão; desbloquear desfaz.

**O que queremos saber da Wiki, antes de desenhar qualquer coisa:**

1. Quais mecanismos a Wiki tem hoje, ou consegue ter, para impedir o tráfego de uma ONU específica? Candidatos que conhecemos: (a) desabilitar/desativar a ONU no OLTCloud, (b) bloquear a porta LAN ou a WAN pelo ACS, (c) desautorizar a ONU (descartado, perde o vínculo e exige reautorizar), (d) derrubar a sessão PPPoE e impedir nova autenticação no RADIUS/NE40.
2. Para cada um: é **reversível em poucos segundos**, mantém o alias, o vínculo com a CTO e as VLANs, e a ONU continua visível para o monitoramento (para o portal mostrar "bloqueado" e não "offline")?
3. Dá para o portal distinguir "bloqueado por nós" de "caiu"? Hoje o alarme ignora cliente bloqueado sem PPPoE; precisaríamos de um estado `bloqueado` confiável vindo da Wiki.
4. Algum deles afeta outros clientes da mesma PON ou da mesma ONU (ONU de rede neutra tem um cliente só)?
5. A operação seguiria o mesmo molde das outras: `202`, `idempotencyKey`, estados `recebida` → `executando` → `concluida`, repetível, com `motivo` curto.

Sem pedido de implementação agora: respondam o que é possível e o risco de cada opção, e a gente fecha o desenho com o Juan.

## Ordem

1 primeiro (destrava painel e alarmes). 2 só quando o Juan fechar a ideia.
