# Pedido à SpeedWiki (22 out 2026): PPPoE no snapshot e bloqueio pela ONU

Complementa o [`PEDIDO-WIKI.md`](PEDIDO-WIKI.md). Obrigado pela etapa `cliente_no_oltcloud`. O contrato e a ativação já estão provados em produção com ONU de bancada (33720, 33721 e 33726). Restam dois assuntos de rede.

## 1. Pedido: PPPoE da rede neutra no snapshot do NE40

Hoje `GET /v3/clientes/{login}/status` e `POST /v3/clientes/status` devolvem `autenticacao: "desconhecido"` para os logins `<contrato>-<CÓDIGO>`. Por isso o portal não mostra PPPoE na tela do cliente nem alarma PPPoE caído.

Pedimos:

- Incluir os logins da rede neutra (`-JHV` no piloto) no poller de PPPoE do NE40, ou num poller irmão.
- Servir pelo snapshot, por login: `autenticacao.estado` (`conectado` | `desconectado`), `ip`, `desde` e `autenticacaoEm`.
- O lote (`POST /v3/clientes/status`, até 200 logins) responde do snapshot, sem abrir SSH por chamada. Qualquer intervalo até 15 min serve.
- `?fresh=true` continua como hoje (fila no NE40, `429` com `Retry-After`).

Perguntas:

1. Como a Wiki vai saber a lista de logins a monitorar? (a) Ela lê do Voalle as conexões que criou por `POST /v3/contratos`. (b) O portal manda a lista, por exemplo `PUT /v3/clientes/monitorados` com `{ "logins": [...] }`. Qual é mais simples para vocês?
2. Qual intervalo do poller é viável?
3. Existe comando no NE40 que liste as sessões de uma vez?

Cuidado conhecido: o NE40 recusa SSH simultâneo (4 de 8 falharam no teste de vocês). Manter a concorrência baixa, como no poller atual (5, intervalo de 2 s).

Validação: com o contrato 33726-JHV e a ONU online, o `status` deve trazer `conectado` com `ip`. Depois desligamos a ONU de bancada e conferimos `desconectado` no ciclo seguinte. O portal já está com `CLIENT_STATUS_MODE=wiki`, então não precisa mudar nada do nosso lado.

## 2. Consulta de viabilidade (sem pedido de implementação): bloquear o cliente pela ONU, sem Voalle

O contrato no Voalle não cobra nada. O parceiro paga à Speed pelo fechamento do portal. Queremos que o supervisor do parceiro aperte "Bloquear" num cliente inadimplente dele e a Speed corte o serviço na rede, sem passar pelo Voalle e sem aprovação manual. Contrato, porta e cobrança do parceiro ficam como estão, e "Desbloquear" desfaz.

Perguntas:

1. Que mecanismos vocês têm, ou conseguem ter, para impedir o tráfego de uma ONU específica? Os que conhecemos são:
   - (a) desativar a ONU no OLTCloud;
   - (b) bloquear WAN ou LAN pelo ACS;
   - (c) derrubar a sessão PPPoE e negar nova autenticação no RADIUS/NE40.

   Já descartamos desautorizar a ONU, porque perde o vínculo. Existe outro?
2. Para cada opção: é reversível em poucos segundos? Mantém o alias, o vínculo com a CTO e as VLANs? A ONU continua visível no monitoramento?
3. A Wiki consegue informar um estado `bloqueado` confiável, para o portal distinguir "bloqueado por nós" de "caiu"? Hoje o alarme ignora cliente bloqueado sem PPPoE.
4. A opção pode afetar outros clientes da mesma PON ou da mesma ONU? Na rede neutra, cada ONU tem um cliente só.
5. Qual a recomendação de vocês e o risco de cada uma? A operação seguiria o mesmo molde das outras: `202`, `idempotencyKey`, estados `recebida` → `executando` → `concluida`, repetível, com `motivo` curto.

Sem pressa nesta segunda parte: queremos a viabilidade antes de desenhar.

## Ordem

O item 1 vem primeiro, porque destrava o painel e os alarmes. O item 2 só quando o Juan fechar a ideia.
