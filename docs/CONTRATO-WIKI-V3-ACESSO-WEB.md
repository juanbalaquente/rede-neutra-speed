# Rota da Wiki: abrir a página do roteador (30 out 2026)

**Estado:** a rota está em produção na Wiki, em `https://roteador.spdlink.com.br` (certificado ok), e funcionou pelo portal com um login `-JHV` real (seção abaixo). Só EG8145V5 (bancada) e HG8145V5 (33766-JHV) foram testados; os outros modelos, não.

Regras comuns do `CONTRATO-WIKI-V3-CLIENTES.md`: prefixo `/proxy/redeneutra/v3`, chave de escrita `X-RedeNeutra-Write-Key`, `X-RedeNeutra-Partner`, login PPPoE como chave.

## Abrir

`POST /proxy/redeneutra/v3/clientes/{login}/acesso-web`

Corpo opcional: `{ "solicitante": "nome do técnico" }`, até 120 caracteres; fica na auditoria da Wiki. O portal sempre manda o nome do usuário logado.

Resposta `200`: `{ "url": "https://roteador.spdlink.com.br/abrir/<token>", "expiraEm": "<ISO 8601>" }`

- Abrir em aba nova, com um clique do técnico.
- **Uso único:** não salvar, não logar e não fazer pré-carregamento (o preview consumiria o link).
- Para abrir de novo, chamar a rota de novo. A nova abertura encerra a sessão anterior do mesmo login.
- A chamada pode levar cerca de 1 minuto, quando a Wiki precisa gravar a senha na ONU. Timeout de pelo menos 90 s.

| Status | Código | Quando |
|---|---|---|
| 400 | `parceiro_invalido`, `login_invalido` | dado do pedido |
| 401 | `unauthorized` | chave errada |
| 403 | `login_de_outro_parceiro` | |
| 404 | `login_desconhecido` | não há ONU com esse login |
| 409 | `cliente_bloqueado` | |
| 409 | `onu_offline` | ONU fora do ar |
| 409 | `onu_sem_acs`, `onu_sem_conta_comum` | equipamento não suporta; falar com a Speed |
| 409 | `onu_sem_resposta` | a ONU não respondeu ao abrir a página, ou o ACS recusou a gravação; tentar de novo em cerca de 15 minutos e, se repetir, falar com a Speed |
| 409 | `login_recusado_pela_onu` | tentar de novo em 1 ou 2 minutos; se repetir, falar com a Speed |
| 429 | `limite_de_aberturas` | máximo de 10 por hora por login |
| 429 | `muitas_sessoes_abertas` | tentar de novo em alguns minutos |
| 429 | `Too many requests` | limite de chamadas à rota; tentar de novo em 1 minuto |
| 502 | `fonte_indisponivel` | tentar de novo |
| 503 | `acesso_web_desligado` | recurso desligado na Wiki |

**Primeira tentativa real (33766-JHV, HG8145V5, 30 out 2026, 13:08):** `502 fonte_indisponivel` em 20,6 s, tempo limite da Wiki ao abrir a página da ONU. O acesso à página pela rede de gerência estava desligado na ONU, e o mais provável é que tenha voltado a 0 no religamento de 29/10. A falha foi antes do login: nenhuma senha gravada, conta comum intacta. Isso depende do modelo: HG8546M e EG8145X6 mantiveram o acesso depois de religar; HG8245W5-6T e HG8145V5 perderam; os outros não foram medidos.

**Correção da Wiki, no ar desde 30 out 2026:** em cada abertura ela confere esse ajuste e, com a página fechada, religa o acesso e a senha da conta comum na mesma gravação, antes do login (se já estiver ligado, nada é gravado). A chamada não muda. Essa abertura leva mais tempo (17 s no teste da Wiki, até cerca de 1 minuto), e a seguinte a um religamento pode voltar a demorar. Se o ACS recusar a gravação ou a ONU não responder, a resposta é `409 onu_sem_resposta`, caso que ainda não aconteceu em teste real.

**Teste pelo portal (30 out 2026, Juan, 33766-JHV):** funcionou pelo botão. Outros modelos seguem sem teste.

## Encerrar antes do prazo (opcional)

`DELETE /proxy/redeneutra/v3/clientes/{login}/acesso-web`, mesmos headers. Resposta: `{ "encerrado": true | false }`.

## Avisos ao parceiro

- O acesso vale 15 minutos; depois a página mostra "Acesso encerrado" e é preciso abrir de novo pelo portal.
- A sessão também cai se a Wiki for atualizada; basta abrir de novo.
- As telas da ONU ficam em inglês.
- Reset de fábrica, reinício, firmware, contas e senhas, senha da OLT, WAN/PPPoE, regras de acesso à ONU e modo AP estão bloqueados. Alguns itens continuam no menu da ONU, mas mostram "Não disponível".
- Na primeira abertura, a senha da etiqueta pode deixar de valer para a conta comum daquela ONU. Depois disso, o cliente final não entra mais com ela.

## No portal

Rotas `POST` e `DELETE /installations/:id/acesso-web`, para atendente e supervisor, com a mesma regra do Wi-Fi: ONU liberada, cliente nem bloqueado nem cancelado (encerrar vale sempre). Usa `AUTOMATION_MODE`.

- **O link só atravessa o portal:** não vai para banco, auditoria nem log, e a resposta sai com `Cache-Control: no-store`. A auditoria guarda quem abriu e até quando vale (`cliente.acesso_web_aberto`, `_recusado`, `_falhou`, `_encerrado`). O `api_call_log` só registra o endereço do pedido, que não leva o token.
- **Sem repetição automática:** POST não é repetido pelo `http.ts`.
- **Tempos:** 95 s da API até a Wiki, 110 s no nginx. O nginx precisa ser sempre maior que a API.
- **Aba nova:** a resposta pode levar 1 minuto, e abrir a aba depois dela faria o navegador bloquear o pop-up. A aba nasce no clique com "Abrindo…", recebe o link quando ele chega e fecha se houver recusa. Se o navegador bloquear mesmo assim, a tela mostra o botão "Abrir agora", que usa o link uma vez e o descarta.
- **Confirmação:** o botão mostra os avisos antes de abrir, porque a primeira abertura pode invalidar a senha da etiqueta.
