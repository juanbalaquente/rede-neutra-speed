# Rede Neutra: resumo do que foi feito, descoberto e pendente

Atualizado em 16 out 2026, para quem trabalha na SpeedWiki. Complementa [`PEDIDO-WIKI.md`](PEDIDO-WIKI.md) (o que o portal precisa receber) e os contratos [v1](CONTRATO-WIKI-V1.md), [v2](CONTRATO-WIKI-V2-ATIVACAO.md) e [v3](CONTRATO-WIKI-V3-CLIENTES.md). O handoff de 7 out ([`HANDOFF-WIKI-REDE-NEUTRA.md`](HANDOFF-WIKI-REDE-NEUTRA.md)) está desatualizado nos pontos de integração: vale este.

Nenhuma credencial está aqui.

## 1. Onde estamos

- O portal está **no ar** (https://redeneutra.spdlink.com.br, commit `30c95ae`) e fala com a Wiki em **v1** com dado real (viabilidade, vagas, mapa por sigla). `INTEGRATIONS_MODE=wiki`.
- Tudo o que depende de escrita ou das rotas v2/v3 está **construído e testado contra mock** (232 testes) e **desligado em produção** (`ACTIVATION_MODE`, `AUTOMATION_MODE`, `CONTRACT_MODE`, `CLIENT_STATUS_MODE` em `off`). Cada modo só liga com a validação do Juan numa ONU ou contrato de teste da Speed.
- O que os contratos dizem e o que o portal já espera estão alinhados com as respostas da Wiki de 14 a 16 out.

## 2. O que o portal já faz (por etapa do planejamento)

| Etapa | Estado no portal |
|---|---|
| Viabilidade e reserva de 48 h | Feito, com dado real da Wiki v1. Reserva por **vaga** (não por porta), limite por parceiro **e por CTO**, trava sob lock. |
| Contrato | Criação automática pronta contra mock (`POST /v3/contratos` proposto pela Wiki): endereço estruturado, etapas, idempotência, login vindo do contrato. Com o contrato pedido a reserva deixa de expirar e não cancela. |
| Agenda, fotos e O.S. | Feito. Seis fotos, GPS, fechamento de O.S. |
| Liberação de ONU (v2) | Pronta contra mock: lista de pendentes, serial confirmada pela etiqueta, trava de sinal (limite editável, hoje 1,5 dB), decisão em 30 min, justificativa, chamado automático, VLAN na tela. Envia `X-RedeNeutra-Partner`, trata os 503 de rota desligada como "ainda não liberada" e as recusas `serial_em_ativacao` e `login_fora_do_padrao`. |
| Tela do cliente | Semáforo de fibra, PPPoE e contrato, sinal de 7/30/90 dias, consulta ao vivo. Lê as rotas v3 de leitura que a Wiki já entregou. |
| Automações do cliente | Bloquear, desbloquear, reiniciar e cancelar (e em lote até 50, sem cancelamento), com etapas e repetição de operação parcial. A Speed pode exigir aprovação por tipo (desligada). |
| Chamados | Abertura, histórico, resposta, SLA por tipo editável, chamado automático da trava de sinal, fotos por link assinado de 48 h. |
| Financeiro e painéis | Preços, custo, lucro, pagamento manual, planilhas com filtros, impressão em PDF. Painel da Speed por parceiro, rede inteira por sigla, alerta de CTO com muitos chamados, qualidade de sinal da base. |

## 3. O que descobrimos (vale para a Wiki)

**OLTCloud**
- A lista de ONUs pendentes traz serial, modelo, slot, pon e `onu_hash`, **sem sinal**. O id da ONU muda a cada reautorização: a chave é a **serial**.
- Autorizar pela rota do **painel** funciona (testado em 9 out); a rota oficial `POST /api/v2/ftth/equipment/auth` recusou o corpo e o suporte não respondeu.
- O script AUTENTICADOR é repetível e a saída traz a senha PPPoE em texto puro (nunca exibida nem guardada). O OLTCloud busca a senha sozinho ao configurar a ONU: o técnico não digita senha.
- ONU com mais de uma VLAN (ex.: 1000 e 29): ainda não se sabe qual é a de gerência, então `onu.vlan` vai `null`.
- A CTO `52108` não tem caixa no OLTCloud: `/vagas` dá 404 e as fontes divergem (Codemaps 8 ocupadas no diagrama, 1 livre na lista).

**Voalle**
- A API não tem **bloqueio administrativo**, só **suspensão** (`Contract/Suspend`), que provavelmente **interrompe a cobrança**. O planejamento exige que o cliente bloqueado continue faturado.
- Não há endpoint de **cancelar contrato** na API para Terceiros (perguntado à Voalle). Quem paga é o **parceiro** (um CNPJ com todos os contratos), não o assinante.
- O Voalle sobrescreve o endereço principal a cada contrato: a Wiki manda o endereço do cadastro do parceiro e grava o do assinante só na conexão, pela API de mapas.
- Ponto de acesso pela sigla: R1 = 2, ITA = 3, FAT = 11. Falta vincular os 4 planos da Speed (serviços 00229, 00232, 00233 e 00332) a um tipo de contrato no Voalle (a chave "Integração" não é necessária).

**Codemaps**
- A viabilidade devolve no máximo 10 CTOs; em área densa uma CTO mais distante pode não aparecer. O geocoder erra o ponto na Rua Carvalho de Brito (CTO 24109).

**Decisões de produto**
- Login = `<contrato>-<CÓDIGO>` do provedor (ex.: `12345-JHV`), igual ao alias da ONU. O técnico não informa porta e a Wiki não a vincula.
- A referência da trava de sinal é a **medição do técnico na CTO, com foto**, não a média do OLTCloud.
- **Senha PPPoE:** senha padrão da Speed gravada pela Wiki ao criar o contrato, entregue ao parceiro pelo canal comercial. Sem rota de senha e sem troca de senha.
- Aprovação do contrato (que inicia o faturamento): proposta de aprovar quando a ONU fica online.

## 4. Pendências

### 4.1 OLTCloud (onde a experiência da Wiki mais ajuda)

São as perguntas que o que a Wiki já fez com o OLTCloud pode fechar:

1. ~~Sinal na janela "Inativo"~~ **resolvido em 16 out:** a Wiki testou ponta a ponta numa ONU da Speed (cerca de 70 s) e o sinal aparece logo depois de autorizar, por leitura forçada na OLT (3 leituras, mediana; até 2 min de tentativa, depois `sem_leitura_de_sinal`).
2. **Ligar a ativação com o primeiro cliente real do piloto**: depende do contrato no Voalle com login `<contrato>-JHV`. As rotas de leitura da v2 já estão ativas; `POST /ativacoes` e `/decisao` seguem em 503 `ativacao_desligada`. Depois o Juan valida e liga `ACTIVATION_MODE=wiki`.
3. **Sincronização Voalle → OLTCloud:** quanto tempo o contrato novo leva para aparecer no OLTCloud (nunca medido)? Se demorar, `POST /api/v2/client/create` resolve? Isso decide a ordem contrato → autorização.
4. **Qual é a VLAN de gerência e qual a de serviço** nas ONUs com duas VLANs? Dá para devolver `vlans: [{ tipo, id }]`?
5. **Rota oficial de autorização:** vale cobrar o suporte do OLTCloud de novo, ou a Wiki já tem a rota do painel estável o bastante para o piloto?
6. **Capacidade da sessão do painel:** quantas ativações em sequência aguenta? O contrato prevê uma por vez no piloto.
7. **Cancelamento:** a etapa `onu_removida` é desautorizar a ONU. Dá para antecipar só essa etapa, mesmo com o Voalle pendente?
8. **Reinício:** a base de ACS existe. Pode entrar primeiro entre as escritas?
9. **Cadastro:** o que fazer com CTOs sem caixa no OLTCloud (`52108`)? O portal as mantém como "conferir".

### 4.2 Wiki (demais)

- PPPoE no snapshot do NE40 para a rede neutra e incidente por CTO (`cto-off-monitor`).
- Rotas v3: chamados (escolher board e colunas do Kanban, baixar as fotos por link de 48 h), contratos (e o cancelamento do contrato não aprovado), reinício, bloqueio, cancelamento.
- Opcional: `POST /v3/clientes/sinal-resumo` (sinal da base em lote). Hoje o portal faz uma chamada por cliente, guardada por 10 min.

### 4.3 Voalle

Vincular os 4 planos da Speed (serviços 00229, 00232, 00233 e 00332) a um tipo de contrato no Voalle. (Cancelamento de contrato: a API não tem; vira tarefa da equipe. Limite por CNPJ: sem problema conhecido até 107 contratos.)

### 4.4 Decisões do Juan

**Mudança de 18 out: o contrato no Voalle não tem valor** (só identifica e gera o PPPoE; o parceiro paga a Speed por fora do ERP, pelo fechamento do portal). Com isso, gatilho de aprovação, bloqueio por suspensão e fatura em aberto deixaram de ser decisões de cobrança. Ficam:

1. Regra de cobrança no fechamento do portal: mês cheio ou proporcional, na ativação e no cancelamento.
2. Board e colunas do Kanban dos chamados.

### 4.5 Diretoria

SLA por tipo de chamado, preço fixo ou degressivo, fotos obrigatórias, módulo de WhatsApp no piloto, indicadores do painel da Speed.

### 4.6 Antes do piloto (operação)

Religar `MFA_REQUIRED=true`, trocar ou desativar a conta de teste, cadastrar o parceiro real (JHV), backup fora da VM, monitoramento no Zabbix. Roteiro em [`DEPLOY.md`](DEPLOY.md).

## 5. Como validar cada entrega da Wiki

1. A Wiki avisa qual rota entrou e entrega a chave de escrita, quando for o caso.
2. O Juan troca o modo no servidor (`ACTIVATION_MODE`, `AUTOMATION_MODE`, `CONTRACT_MODE`, `CLIENT_STATUS_MODE`) e valida numa ONU ou contrato de teste da Speed.
3. Se a resposta não bater com o contrato, o portal registra o campo exato (`fora do contrato vN (campo: motivo)`) e a gente devolve o caso.
4. Toda escrita continua desligada até a validação explícita do Juan.
