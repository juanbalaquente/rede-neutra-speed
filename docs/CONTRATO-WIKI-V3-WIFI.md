# Resposta da Wiki à seção J: trocar o Wi-Fi da ONU do cliente (26 out 2026)

**Estado:** a rota **está implementada e no ar na Wiki, e o interruptor `REDENEUTRA_WIFI_MODO` está ligado** (a rota já pode ser usada pelo portal; desligado, ela responde `503 wifi_desligado`). O mecanismo foi testado em produção numa ONU de bancada (seção 1); a rota foi testada ponta a ponta na bancada em 26/10/2026 (seção 5.1), e o que falta provar está na seção 5. Este documento é a resposta ao pedido da seção J do `CONTRATO-WIKI-V3-CLIENTES.md` do portal.

Mesmas regras comuns da seção "Regras comuns" do v3 (prefixo `/proxy/redeneutra/v3`, chave de escrita `X-RedeNeutra-Write-Key`, `X-RedeNeutra-Partner`, login PPPoE como chave). Interruptor próprio na Wiki, **desligado por padrão**: sem `REDENEUTRA_WIFI_MODO=live` o `POST` responde `503 wifi_desligado`.

## 1. O que foi provado (ONU de bancada EG8145X6-10, 26 out 2026)

| Pergunta | Resultado |
|---|---|
| Existe como trocar pelo ACS? | Sim: `POST /api/v2/acs/{sn}/config_wifi` do OLTCloud, corpo `{ssid, wifi_pass, ssid_5, wifi_pass_5}`. |
| Aceita trocar só uma banda? | Sim, corpo parcial funciona; a outra banda não é tocada. |
| Quanto demora? | 8 a 10 s por chamada. |
| Sobrevive ao religamento? | **Sim.** Depois de um reboot completo o nome novo continuou nas duas bandas (lido ao vivo do aparelho). |
| Dá para conferir o resultado? | O **nome** se confere ao vivo no aparelho (`info?force=1`). A **senha** só se confere pela cópia que o OLTCloud guarda (ver 4.2). |
| E valor inválido? | O OLTCloud recusa com 400 e **não altera nada**: senha de 7 e de 64 caracteres, nome de 33 bytes e nome vazio. |
| A mensagem de erro ajuda? | Não: é a mesma para valor inválido e para ONU fora do ar. Por isso **a Wiki valida antes de enviar** e não repassa o erro cru. |

## 2. Contrato proposto

### `POST /proxy/redeneutra/v3/clientes/{login}/wifi`
Escrita (`X-RedeNeutra-Write-Key`), `X-RedeNeutra-Partner` obrigatório.

```json
{ "ssid": "Casa do Joao", "senha": "Segredo-Wifi-9876" }
```

- `ssid`: opcional (`null` ou ausente = só troca a senha). Regras na seção 3.
- `senha`: obrigatória. Regras na seção 3.
- **Síncrona, sem `operacaoId` e sem `idempotencyKey`**, como o portal pediu. Repetir com os mesmos valores é seguro.
- As duas bandas recebem o mesmo nome e a mesma senha (a Wiki grava **uma banda por vez**, 2,4G e depois 5G: a chamada única com as quatro chaves ficou 5 min pendurada e aplicou só o nome).

Resposta `200`: `{ "aplicado": true, "ssid": "Casa do Joao" }`. O `ssid` é o nome lido de volta do aparelho. `aplicado` só é `true` depois dessa conferência; sem ela, erro.

Erros (corpo `{ "error": "<código>" }`), os mesmos que o portal já traduz:

| Código | Status | Quando |
|---|---|---|
| `onu_offline` | 409 | ONU offline ou sem comunicação nos dois sentidos com o ACS agora |
| `cliente_bloqueado` | 409 | cliente com bloqueio ativo (ONU desabilitada) |
| `senha_invalida` / `senha_fraca` / `ssid_invalido` | 422 | fora das regras da seção 3 |
| `login_de_outro_parceiro` | 403 | login não termina com o código do `X-RedeNeutra-Partner` |
| `login_desconhecido` | 404 | sem ONU com esse login |
| `limite_de_trocas` | 429 | mais de 5 trocas na última hora para o mesmo login |
| `falha_no_aparelho` | 502 | o OLTCloud recusou mesmo com valores válidos e a ONU online (caso raro) |
| `wifi_desligado` | 503 | interruptor desligado na Wiki |

O resultado só vale pela **releitura** (cópia do OLTCloud e nome ao vivo): um 400 ou timeout do OLTCloud não prova que nada foi aplicado, a tarefa fica na fila do ACS e chegou ao aparelho depois nos testes. Se passar de 45 s, a Wiki responde `504` **e termina a troca sozinha**, como o portal descreveu. A mensagem ao atendente fica "não deu para confirmar, teste no aparelho antes de repetir".

## 3. Regras de validação (a Wiki valida de novo; o portal valida antes)

- **Senha:** 8 a 63 caracteres ASCII imprimíveis (de espaço a `~`). Sem acentos (`senha_invalida`). **Precisa ter as quatro classes: maiúscula, minúscula, número e caractere especial** (`senha_fraca`): sem qualquer uma o OLTCloud recusa com 400 genérico (medido na bancada). Especiais testados e aceitos: aspas, barra invertida, & < > ' % $ # ! ; e espaço no meio. O portal deve mostrar a regra e validar antes.
- **Nome da rede (ssid):** de 1 a **32 bytes**, **só ASCII imprimível na v1**, sem espaço no início ou no fim.

### Dois ajustes que a Wiki pede ao portal
1. **O limite do nome é em bytes, não em caracteres.** Com acento, "João" tem 5 bytes e "Casa da Conceição" passa de 17 para 19. Na v1 a Wiki só aceita ASCII; quem quiser acento depende de um teste no aparelho (fica para uma v2). O portal deve validar ASCII e mostrar a regra ao atendente.
2. **Timeout de 45 s para esta rota** (medido na rota real: 34 s para as duas bandas, então a margem é pequena; não baixar disso), em vez de 15 s. Cada banda leva ~8 s para gravar e ~6 s para convergir; as duas somam ~28 s com a verificação. Se o portal preferir manter 15 s, a Wiki segue o plano do próprio portal (`504` e conclui sozinha), só que isso vai acontecer com frequência.

## 4. Segurança

1. **A senha nunca é gravada, logada nem devolvida pela Wiki**: nem no log de chamadas, nem no card interno, nem na tabela de operações, nem em mensagem de erro. Como a rota é síncrona, a senha só existe em memória durante a chamada.
2. **O OLTCloud guarda uma cópia da senha do Wi-Fi em texto puro** e a devolve em `config_wifi`. Isso é do lado deles e a Wiki não controla. Dentro da Wiki, ao mesmo tempo, **qualquer usuário logado conseguia ler essa rota** pelo repasse genérico do proxy. A Wiki ainda vai restringir isso (só `sistemas`), independente desta rota; não está feito.
3. **Limite por login:** 5 trocas por hora, para evitar uso abusivo.
4. **Auditoria** na Wiki: quem trocou (parceiro), quando e o nome da rede. Nunca a senha.

## 5. O que a Wiki ainda precisa testar antes de ligar

- Testados: caracteres especiais aceitos (seção 3); chamada única com as quatro chaves não serve (pendurou), então uma chamada por banda. Trocas em rajada geram 400 e timeouts rápidos, por isso o limite de 5/hora e a espera pela convergência.
- **Senha nova valendo no aparelho depois do boot:** o nome já foi provado; a senha só se prova conectando um celular depois do reboot. Fica como teste final.
- **Efeito nos aparelhos conectados:** esperado que caiam por alguns segundos e voltem; não medido.

### 5.1 Teste ponta a ponta da rota (26/10/2026, ONU de bancada, alias `32804-JHV`)

| Caso | Resultado |
|---|---|
| Senha sem as quatro classes | `422 senha_fraca`, resposta imediata, nada gravado |
| Nome com acento | `422 ssid_invalido`, imediato |
| `X-RedeNeutra-Partner` diferente do sufixo do login | `403 login_de_outro_parceiro`, imediato |
| Login sem ONU | `404 login_desconhecido`, imediato |
| Troca real (nome e senha) | `200 { aplicado: true, ssid }` em **34 s**; cópia do OLTCloud e nome ao vivo conferidos nas duas bandas |

A senha nova só foi conferida pela cópia do OLTCloud; falta o teste com um celular conectando depois de religar a ONU. Efeito nos aparelhos conectados continua não medido.

## 6. Resposta ao que o portal não pediu, mas ficou claro

- **Ativação com Wi-Fi do cliente:** hoje a ativação deixa o Wi-Fi de fábrica, como o portal descreveu. Dá para a ativação receber nome e senha e já entregar a ONU configurada (mesma regra de segredo). **Não está no escopo desta rota**; fica como pedido separado, se fizer sentido.
- **Ler a senha atual:** não será oferecido (decisão do portal na seção J). A leitura de status (seção I) continua sem senha.

## 7. Resumo do que mudou na Wiki nesta etapa (para o portal acompanhar)

### 7.1 Ativação de ONU agora provisiona em 5 etapas
Dentro do estado `provisionando` da ativação (v2), a Wiki passou a executar, em ordem: **reset de fábrica** (a ONU de cancelamento vem com Wi-Fi e senhas do cliente anterior), **AUTENTICADOR**, **senha web** (troca o admin de fábrica pelo padrão da Speed), **perfil** (DHCP 3 dias, DNS `179.106.110.84,8.8.8.8`, LAN secundária desligada, UPnP, acesso web remoto permanente) e **IPv6** (WAN PPPoE com delegação de prefixo; o NE40 delega o /56 em ~30 s). Validado na bancada e na X9: ONU online na 1ª tentativa em **2,5 a 5 min**.

O que o portal pode notar:
- **O reset nunca se repete.** Se a ativação falhar depois dele, o retry recomeça no AUTENTICADOR.
- **Fora da ativação automática:** OLTs **Jaqueline** e **Santa Luzia** (têm dois scripts AUTENTICADOR e regras próprias), ONUs que não são Huawei (`HWTC`) e modelos sem ACS (EG8010H, 010H, 546M). Esses casos viram erro claro/atendimento da equipe **antes** do reset, sem mexer na ONU.
- **Wi-Fi não é configurado na ativação:** o cliente decide nome e senha; é exatamente o que a rota `/wifi` desta seção entrega depois.
- **Sem telefonia por ora** (`VOIP_INTERNET` fica guardado para outro momento; a OLT reaplica `INTERNET` no boot).
- A senha web padrão fica no Vaultwarden; ela apareceu num chat e vale só para as próximas ativações.

### 7.2 Para o portal
- Tela de troca de Wi-Fi: mostrar a regra da senha (8 a 63, ASCII, as quatro classes) e do nome (1 a 32 bytes, ASCII), tratar `senha_fraca` e `504` ("não deu para confirmar, teste no aparelho antes de repetir"), e usar timeout de 45 s.
- A ONU de bancada (HWTCb705b8b5, alias `32804-JHV`) fica no OLTCloud para novos testes; não é cliente real.
- Pendências da Wiki: restringir o `config_wifi` do repasse `/proxy/oltcloud/*` a `sistemas`; Wi-Fi na ativação (pedido separado); nome com acento (v2); whitelist de origem do acesso web da ONU (precisa do `config-flow`).
