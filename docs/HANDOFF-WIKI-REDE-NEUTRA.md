# Handoff: SpeedWiki <> Rede Neutra

Escrito em 7 de outubro de 2026, a partir de uma sessão de trabalho feita dentro do repositório da SpeedWiki. Este arquivo reúne **tudo o que se sabe** sobre a relação entre os dois projetos, inclusive o que está errado, incerto ou não foi verificado. Quem lê (Claude ou pessoa) deve conseguir continuar o trabalho sem ter visto aquela conversa.

Complementa `docs/CONTEXTO.md` (regras de negócio, fases, visual) e `docs/BRIEFING-ANALISTA.md` (tarefas do analista de Voalle). Em caso de conflito, **este arquivo é mais recente** que o CONTEXTO.md nos pontos de integração.

## Como ler as marcações

- **[VERIFICADO]** visto diretamente no código ou no sistema real nesta sessão.
- **[DOC WIKI]** vem da documentação (`CLAUDE.md`) e da memória do projeto SpeedWiki, medido ou observado em produção na data indicada. Pode ter mudado.
- **[NÃO VERIFICADO]** suposição ou lacuna. Não tratar como fato.

Nenhuma credencial está neste arquivo, e nenhuma deve ser colocada nele.

---

## 1. Resumo

1. O dono da Speed quer vender **rede neutra**. O portal Rede Neutra é o produto; a **SpeedWiki continua sendo o centro de dados**.
2. O projeto será mais escalável do que um piloto: há expectativa de **mais parceiros** depois do primeiro.
3. O código do portal está bem feito nas partes de segurança e concorrência, mas a **pergunta central do produto ("essa porta está livre?") se apoia em dado fraco**.
4. O **caminho crítico não foi validado**: criar contrato com ponto de acesso no Voalle e autorizar ONU no OLTCloud. Ainda não se sabe se existem por API.
5. Um **analista de dados** cuida do Voalle (contratos e faturamento), só em modo leitura, e devolve respostas em arquivo. Ele não escreve código.
6. Proposta de arquitetura: o portal **não fala direto** com Codemaps, OLTCloud e Voalle. Fala com a SpeedWiki por uma **API versionada** (`/proxy/redeneutra/*`).

---

## 2. Decisões tomadas nesta conversa

- Plataforma nova, separada da Wiki, **escalável** (mais clientes depois do piloto). A Wiki segue como fonte de verdade operacional.
- O visual aprovado é o protótipo `docs/prototipo/modelo-4.html` (confirmado pelo Juan em 7/10). Painel verificado renderizando.
- O analista de dados participa de Voalle, pagamentos e dashboards. Decisão: **ele recebe tarefas e devolve arquivos; a equipe implementa no código original.**
- Ideia levantada pelo Juan: um **MCP da Wiki**. Posição desta sessão: boa ideia como **segunda camada**, uma casca fina em cima da mesma API versionada, sem regra de negócio própria, com token escopado e somente leitura no início.
- Sessões: a sessão da **Wiki** cuida da camada de integração na SpeedWiki e das investigações em produção; a sessão do **portal** cuida do código do portal.

---

## 3. Divisão de trabalho

| SpeedWiki | Portal Rede Neutra | Analista |
|---|---|---|
| Rotas `/proxy/redeneutra/*` e chave dedicada | Visual do modelo 4 em React (viabilidade e reservas primeiro) | Voalle: criar contrato, bloquear/desbloquear, cancelar, faturamento consolidado, preço, cobrança, ponto de acesso |
| Dado tratado de porta livre (gêmeas, cruzamento, cache) | Trocar os clientes de Codemaps e OLTCloud por chamadas à Wiki | Somente leitura, sem código |
| Investigação de OLTCloud (autorizar ONU) | Telas de admin e de gestão de usuários | Entrega `ENTREGA-NN.md` por tarefa |
| Vínculo contrato→parceiro, chamados de infra, avisos de falha | Trava de sinal, Cliente 360, fotos, agenda | |

Regra: **nenhuma escrita** em Voalle, OLTCloud ou Codemaps sem validação explícita do Juan.

---

## 4. Arquitetura alvo (proposta)

1. **API versionada entre portal e Wiki** (`/api/v1` ou equivalente em `/proxy/redeneutra`). A Wiki muda toda semana (migrations, colunas). O portal nunca deve ler tabelas da Wiki diretamente. Quebra de contrato vira `v2`, com as duas convivendo um tempo.
2. **Portal passa pela Wiki** para Codemaps, OLTCloud e Voalle. Motivos: esses sistemas liberam acesso por IP (hoje só a Wiki), credenciais ficam em um lugar só, e a Wiki já resolveu várias armadilhas de dado (seção 6).
3. **Webhooks em vez de consulta repetida.** A Wiki avisa o portal quando algo acontece (CTO caiu, ONU ativada, chamado atualizado), com confirmação e reenvio. O `cto-off-monitor` já gera esses eventos.
4. **Login dos parceiros fora do Supabase da Wiki.** O portal já tem usuários próprios, o que está certo. Não misturar usuário externo com a equipe interna.
5. **Hospedagem separada da VM da Wiki.** Hoje a Wiki roda tudo em uma VM (ESXi 6.0): Supabase, proxy, Evolution. Se o portal rodar junto e consumir recurso, o NOC fica cego. [DOC WIKI]
6. **Leitura pesada fora do banco principal** (BI e relatórios) por réplica de leitura, mais adiante.
7. **MCP**: ver seção 2. Token com escopo por parceiro, sem dado pessoal por padrão, log de toda chamada. Lição do MCP da Upchat: o token deles era de administrador total, inclusive com ferramenta de apagar a base inteira de contatos. [DOC WIKI]

---

## 5. O que a SpeedWiki já tem (inventário)

### 5.1 Padrão de integração para outros sistemas [DOC WIKI]

- O SpeedParceiros (sistema irmão, outro servidor) chama a Wiki em `/proxy/parceiros/*` com header `X-SpeedParceiros-Key`, rate limit e log. Mão única, sem JWT de usuário. **Este é o modelo a copiar** para `/proxy/redeneutra/*` (sugestão: header `X-RedeNeutra-Key`).
- Rotas existentes desse padrão: `GET /proxy/parceiros/viabilidade?endereco=` (raio de 1 km, devolve CTOs com `distanceM`, `portasLivres`, `usoPercent`, recusa Plus Code com 422 `plus_code_not_supported`), `GET /proxy/parceiros/voalle/client-by-txid?tx_id=` (resolve cliente por CPF/CNPJ, com caso `ambiguous:true`), `GET /proxy/parceiros/voalle/status-contrato?contractId=` (`contractStatus` e `beginningDate`). **O `contractId` é o id do contrato, não do cliente.**
- Rate limit do proxy: chave `${ip}:${rota}`. A empresa inteira sai por um IP, então um servidor novo chamando a Wiki terá cota própria por rota; ajustar se o volume do portal for alto.
- Chave nova de API: precisa entrar no arquivo de ambiente do servidor **e** no item `speedwiki-proxy-env` do Vaultwarden. Um sincronizador sobrescreve o arquivo de ambiente em cerca de 1 hora; chave que existe só no arquivo some. [DOC WIKI]
- Deploy: push em `main` publica código e frontend, **não roda migrations** (aplicadas à mão) e **não copia a pasta `deploy/`** do repositório.

### 5.2 Codemaps [DOC WIKI]

- Login: `POST /geo2/login/token` com `{token, secret}` devolve um validador que vai no header `validator` das chamadas. O cliente do portal (`integrations/codemaps.ts`) segue exatamente isso.
- Busca por endereço: `POST /geo2/equipment/nearbyaddress`. A resposta usa `list` (não `equipment`); cada item tem `name`, `distance` (m), `avaliable` (portas livres, grafia deles), `usage` (%), `geometry`.
- Libera acesso por IP (hoje só o servidor da Wiki).
- **Plus Code não geocodifica**: o mapa cai no centro da cidade sem avisar e devolve CTOs plausíveis e erradas. O portal já recusa.
- **Raio:** o portal usa 300 m; a rota de parceiros da Wiki usa 1 km; a URA usa 150 m. Em zona densa, a CTO mais próxima pode estar errada (caso real de 10 m de diferença). Decidir um critério único e documentar.
- Diagrama de conexões (`GET /geo2/equipment/{id}/connectionDiagram`) dá a topologia de splitters. Usado pela detecção por splitter em modo sombra.

### 5.3 OLTCloud [DOC WIKI]

- Auth: `POST /api/token` com Bearer; o cliente do portal já faz isso. Conta de API é **somente leitura**, mais três escritas conhecidas: ativar usuário, desativar usuário e reiniciar ONU por ACS.
- A criação de **usuário** do OLTCloud só existe no painel web (sessão Django, não na API). Isso é um sinal de que **autorizar ONU** também pode estar só na sessão web. **[NÃO VERIFICADO]**. O schema completo está em `GET /api/schema?format=json` e é a primeira coisa a pesquisar (procurar por "authorize", "provision", "onu" e rotas `POST`).
- A sessão web tem cota baixa e trava (cerca de 6 requisições na experiência anterior). Não dá para automatizar em volume por ali. **[DOC WIKI]**
- `GET /api/v2/box/list`: ~129 páginas, ~40 s, traz a ocupação porta a porta de **todas** as ~12,8 mil caixas. Não precisa chamar `box/{id}` caixa por caixa.
- `GET /api/v2/box/attenuations`: por CTO, `avg_rx_onu`, contagem e percentual de ONUs em alerta. É a base natural para a trava de sinal de 1,5.
- `GET /api/v2/ftth/equipment/list`: ONUs com `status`, `model`, `uptime_since`, `last_disconnection`, `device_alias` (formato `"<login>-NOME"`). Status reais: `Online`, `Sem Energia`, `LOSS`, `Inativo`, `Desabilitada`. Horário de `last_disconnection` vem **sem fuso e é BRT**.
- **`rx_power_dbm = -99.99` é sentinela** (sem leitura óptica), não dBm. Piso real de medição ~-33,97. A média por CTO precisa excluir o sentinela.
- ACS (Wi-Fi e reboot): os identificadores de um roteador **não são intercambiáveis**. O RSSI aceita MAC ou serial hexadecimal; o reboot só aceita o serial hexadecimal de `device.serial_number`. O primeiro MAC do array nem sempre resolve. Reboot pode devolver 504 mesmo tendo funcionado.

### 5.4 Voalle [DOC WIKI]

- **API de terceiros** (OAuth, token de 1 h, cacheado): fatura por CPF/CNPJ, boletos, títulos em aberto, status do ponto de acesso, `contract/getpaged`, `contracts/unlock` (desbloqueio por confiança), módulo de CRM. **Não se conhece nenhuma rota de criação de contrato.**
- **Banco Postgres de leitura** (schema `erp`): `people` (`tx_id` = CPF/CNPJ), `contracts` (`status` 1 Normal, 3 Cortesia, 4 Cancelado; `cancellation_date` sozinho não é confiável), `authentication_contracts` (linha apagada no cancelamento), `v_contract_clients`.
- **Cada contrato tem dois números:** o "N" (`contract_number`) e o "L" (login PPPoE, `authentication_contracts.user`).
- Serial da ONU no contrato (`equipment_serial_number`, em hexadecimal): ~70% dos contratos ativos. Porta de splitter ligada ao contrato: ~4% das portas (2.649 de 64.080). Não serve como fonte principal.
- Existe um resolvedor de login para contrato em lote na Wiki (3 caminhos: login ativo, histórico de conexões, `people.id`).
- Na tela de usuários do Voalle o botão Salvar **não persistiu** em um caso anterior e precisou de contorno. Desconfiar de qualquer "salvou" sem conferir.

### 5.5 Monitoramento e dados de rede [DOC WIKI]

- **`cto-off-monitor`**, em produção desde 5/10/2026 (modo `live`): abre incidente real quando 100% dos clientes ativos de uma CTO (N≥3) caem em LOSS por 2 rodadas; fecha quando 1 ou mais voltam. Distingue CTO isolada de falha massiva. Detecção por splitter em modo sombra. Eventos prontos para virar aviso ao parceiro.
- **`onu_signal_history`**: sinal de todas as ~11,7 mil ONUs a cada 6 h, desde 1/7/2026. Cobre o "sinal de 30 dias" da tela do cliente.
- **Verificação de login PPPoE** no concentrador (NE40) por linha de comando SSH: existe, e o semáforo "autenticação PPPoE" da tela do cliente poderia usá-la. **Cuidado:** é equipamento de produção, e abrir várias conexões ao mesmo tempo faz o equipamento recusar parte delas (testado: 4 de 8 falharam). Exige escalonamento e retry. Não colocar numa rota chamada a cada abertura de tela sem cache.
- **Chamados:** a Wiki guarda incidentes na tabela `incidents`, **sem endpoint externo para abrir ou consultar**. É a primeira rota nova necessária. Existe também `POST /proxy/kanban/cards` (cria card no Kanban, por chave) como atalho para avisar a equipe.

---

## 6. Qualidade dos dados de rede (o que mais afeta o produto)

- Porta só aparece como ocupada no OLTCloud **se a ONU estiver vinculada à caixa**. Medições: **53,3%** das ONUs vinculadas em 21/09. Em 29/09 um lote de correção reduziu "sem CTO real" de 49,6% para 39,0% (cerca de 61% com CTO). As duas medições têm bases diferentes, não tratar como série contínua, e a memória do projeto manda **reconferir** antes de reportar (houve um número anterior inflado por usar o campo errado).
- **Caixas gêmeas:** a mesma CTO física existe duas vezes no OLTCloud (nativa e normal, a ≤30 m; 5.503 pares). Clientes ficam divididos entre elas. Olhar uma caixa só **subestima** a ocupação.
- **Nomes repetidos:** cerca de 20 nomes de CTO aparecem em caixas distintas. Chave segura = id da caixa, não o nome.
- ~300 ONUs ficam offline crônicas (cliente desligou ou abandonou). Influenciam qualquer cálculo de saúde da CTO.
- Cliente cancelado que nunca saiu do mapa ainda existe no Codemaps/OLTCloud; o cadastro está sendo limpo, mas **não está limpo**.

---

## 7. Revisão do código do portal

O que foi lido: `db/schema.ts`, `services/reservations.ts`, `services/viability.ts`, `integrations/oltcloud.ts`, `integrations/codemaps.ts`, `integrations/types.ts`, `auth/session.ts` e as primeiras 120 linhas de `app.ts`. **Não foram lidos:** o resto de `app.ts`, `mock.ts`, `http.ts`, `voalle.ts`, `config.ts`, `seed.ts`, os testes, nem as páginas do `apps/web`. Os testes **não foram executados**.

### O que está bom [VERIFICADO]

Trava de reserva por índice único parcial; serialização das reservas do mesmo parceiro com `FOR UPDATE`; usuário e parceiro relidos do banco a cada requisição (evita role desatualizada); recurso de outro parceiro responde 404; Plus Code recusado; toda consulta de viabilidade registrada.

### Achados, por prioridade [VERIFICADO no código; impacto depende dos dados]

1. **Porta "livre" não é confiável** (`oltcloud.ts`, `getCtoPorts`). Ocupada = marcada pelo OLTCloud; só vale com ONU vinculada (seção 6). `viability.ts` **ignora** o `freePorts` que o Codemaps já devolve. Mínimo: cruzar as duas fontes e marcar a CTO como "conferir" quando divergirem, em vez de oferecer a porta.
2. **Ligação por nome de CTO** (`loadBoxIndex`): `Map` nome → id; nome repetido sobrescreve; caixas gêmeas ignoradas. A trava de reserva também é por `cto_name + port`. Migrar a chave para id da caixa (ou par id do Codemaps + porta).
3. **Primeira consulta demora e se repete** (`loadBoxIndex`): `box/list` leva ~40 s e é montado dentro da requisição do usuário, só em memória; duas consultas simultâneas baixam tudo duas vezes. Além disso, `runViability` chama `getCtoPorts` em sequência por CTO (até 5 chamadas `box/{id}`). Solução: job que atualiza a ocupação em segundo plano e guarda em disco (ou, melhor, a Wiki entrega isso pronto).
4. **Trava de sinal ainda não existe** e precisa excluir o sentinela -99.99 da média.
5. `clientIp()` confia no `x-forwarded-for` sem condição; se a API ficar exposta diretamente, a chave do bloqueio de login pode ser falsificada. O contador de falhas de login é em memória (zera ao reiniciar, não escala para mais de uma instância). Aceitável no piloto, não para escala.

---

## 8. Lacunas de regra de negócio e riscos

1. **Chave única "contrato = PPPoE" pode não valer.** O CONTEXTO.md assume `CONTRATO-PRIMEIRONOME` como identificador do contrato, do PPPoE, da porta e do cadastro no OLTCloud. Mas no Voalle cada contrato tem **dois números** (N e L). Na Wiki, o `device_alias` do OLTCloud usa o prefixo do **login** (L), enquanto o cabo do cliente no Codemaps usa o **código do contrato**. Para a ativação criar o vínculo certo, o formato do identificador precisa ser decidido sabendo qual número é qual. A Tarefa 1 do analista pergunta se o PPPoE é gerado pelo Voalle ou informado; a resposta decide isso.
2. **Reservas do portal são invisíveis para a Speed.** A reserva vive só no banco do portal. O comercial da Speed (viabilidade interna, esteira de solicitações) não a enxerga, e o Codemaps só é atualizado na ativação. Dois lados podem vender a mesma porta. Ao contrário: venda da Speed ocupa porta que o portal só descobre quando o OLTCloud refletir.
3. **Reserva `convertida` nunca devolve a porta.** Hoje a porta fica presa em `ativa`/`convertida`. Falta o ciclo de vida de cancelamento do cliente (devolver porta, encerrar contrato). Sem isso, a ocupação do parceiro só cresce.
4. **Conflito de interesse.** O parceiro concorre com o varejo da Speed. Esperar exigência de tratamento igual e de que o comercial da Speed não veja a base dele. Pede isolamento de dados e auditoria desde o início.
5. **LGPD.** Dados de clientes finais de outra empresa: definir contratualmente quem é controlador e quem é operador.
6. **Regulatório e SLA** (Anatel, contrato de atacado) fora do escopo técnico; confirmar com jurídico antes de prometer prazo.
7. Decisões abertas da diretoria listadas no CONTEXTO.md (SLA por tipo de chamado, porta que não funciona em campo, fotos obrigatórias, tabela de preço fixa ou degressiva, limite por CTO, WhatsApp no piloto, indicadores) continuam abertas.
8. **Quem instala:** técnico do parceiro ou da Speed? O protótipo mostra o técnico logado no portal; a Wiki tem módulo próprio de logística e vagas de instalação. Isso define se o portal precisa de agenda própria. **[NÃO decidido]**

---

## 9. O que não funciona ou não se sabe

| Item | Estado |
|---|---|
| Criar contrato com ponto de acesso no Voalle por API | Não se sabe. Nenhuma rota de criação conhecida. Analista investiga (Tarefa 1). |
| Autorizar ONU no OLTCloud por API | Não se sabe. API REST é de leitura; pode existir só na sessão web. Procurar no schema. |
| Bloquear contrato por API (administrativo) | Só o desbloqueio por confiança é conhecido. Analista (Tarefa 2). |
| Cobrança consolidada por CNPJ, preço por parceiro, proporcional | Desconhecido. Analista (Tarefas 4 e 5). |
| Regra do concentrador por OLT e região | Desconhecida. Analista (Tarefa 7). |
| Rotas `/proxy/redeneutra/*` | Não existem. |
| Chamado para a infra a partir de fonte externa | Não existe endpoint. |
| `validate:integrations` do portal contra os sistemas reais | **Nunca rodou.** Precisa de servidor liberado por IP. |

Se criar contrato e autorizar ONU só existirem pela tela, o MVP precisa de um **fluxo semi-manual**: o portal registra o pedido e acompanha; a Speed executa a parte manual. Decidir isso cedo muda toda a ordem das fases.

---

## 10. Estado do front

- O protótipo `docs/prototipo/modelo-4.html` é o visual aprovado. Confirmado renderizando: sidebar com grupos e contadores, busca Ctrl K, tema claro e escuro, painel com KPIs, gráfico de área, donut de saúde, mapa de calor de ocupação, vendas por atendente.
- `apps/web` (React) tem só 3 telas simples (login, viabilidade, reservas), **sem** o visual aprovado. Falta portar.
- Observação de uma captura, **não investigada**: no tema escuro, na tela "Campo", os títulos dos cartões da direita pareciam com contraste muito baixo (quase invisíveis sobre o fundo). Conferir durante o port.

---

## 11. Regras e lições da Wiki que valem aqui

1. **Verificar no destino antes de reportar número.** Um percentual de cobertura foi levado à diretoria inflado porque conferiu o campo errado. Releia o estado real depois de qualquer escrita externa.
2. **Preferir vínculo explícito a proximidade.** Achar CTO por raio errou ~24,5% dos casos. Se existe um vínculo registrado, usar o vínculo.
3. **Falha silenciosa em Postgres:** RLS que bloqueia UPDATE/DELETE devolve 0 linhas sem erro; `UNIQUE` com coluna `NULL` não deduplica (usar `NULLS NOT DISTINCT`); PostgREST corta resultados em 1000 linhas; deletar antes de inserir apaga rodadas anteriores. O portal usa Drizzle direto no Postgres (sem PostgREST/RLS), mas o princípio de "ausência de erro não é sucesso" vale para a integração.
4. **Ausência de sinal ruim não é presença de sinal bom.** Para "a porta está livre", usar atestação de duas fontes, não só a falta de uma marcação.
5. **Não adivinhar payload ou configuração de sistema de produção.** Capturar a resposta real primeiro, escrever o parser depois. Um fallback que "adivinhava o primeiro da lista" criou um usuário administrador por engano.
6. **Equipamento de produção embarcado é frágil.** Nada de conexões paralelas ao concentrador ou a switches; escalonar e fazer retry.
7. **Dado pessoal:** consulta de cliente é sob demanda, com registro de acesso; tabelas lidas por muita gente não guardam nome nem telefone.
8. **Auditoria de acesso roda em par:** rotas do proxy **e** políticas de acesso a dados. Toda rota nova de `/proxy/redeneutra/*` precisa ser testada com tokens de parceiros diferentes provando que um não vê o outro.

---

## 12. Ordem de trabalho proposta

**Na SpeedWiki (outra sessão):**
1. Procurar no schema do OLTCloud rota de autorização de ONU (somente leitura).
2. Rodar `validate:integrations` do portal no servidor liberado (somente leitura).
3. Desenhar o contrato de `/proxy/redeneutra/*`: viabilidade e portas livres tratadas, chamados (abrir e consultar), status de contrato, avisos.

**No portal (esta sessão):**
1. Atualizar este documento conforme as respostas chegarem.
2. Portar o visual do modelo 4 para `apps/web`, começando por viabilidade e reservas (já têm API).
3. Preparar o cliente de integração do portal para falar com a Wiki atrás de uma interface (`types.ts` já tem `NetworkMap`), com mock para teste. Não depende de a Wiki estar pronta.
4. Corrigir os achados da seção 7 que são só do portal (chave por id, cruzamento de fontes, trava de sinal sem sentinela).
5. **Só depois** escrever integração de escrita (criar contrato, autorizar ONU), com validação do Juan a cada passo.

### Perguntas abertas

1. Se criar contrato ou autorizar ONU só existir por tela, o MVP aceita fluxo semi-manual?
2. Quem instala: técnico do parceiro ou da Speed?
3. Cobrança por porta: sai do Voalle (contratos no nome do parceiro) ou de uma tabela do portal?
4. Piloto restrito às CTOs com cadastro conferido?
5. Qual raio de viabilidade (150 m, 300 m ou 1 km) e como tratar a CTO mais próxima errada?
6. Onde o portal vai rodar (servidor próprio, separado da VM da Wiki)?

---

## 13. Analista de Voalle

Recebeu `docs/BRIEFING-ANALISTA.md`: escopo **somente Voalle, contratos e faturamento**, somente leitura, sem código, 7 tarefas (criar contrato, bloqueio e desbloqueio, estados e cancelamento, faturamento consolidado, preço por porta, consulta de cobrança, ponto de acesso). Devolve `ENTREGA-01.md` a `ENTREGA-07.md`. As tarefas 1 e 2 vêm primeiro porque decidem se o MVP é automático ou semi-manual.

Ao receber uma entrega: **conferir no sistema de origem antes de implementar**, e atualizar a seção 9 deste arquivo. Ele usa Claude como apoio e tem pouca experiência em código; por isso o escopo é fechado e as respostas exigem evidência.

---

## Pendente de decisão do Juan antes de implementar

- Autorização para rodar qualquer coisa contra Voalle, OLTCloud ou Codemaps reais (hoje só leitura, a partir do servidor da Wiki).
- Escolha entre sessão da Wiki e do portal para cada passo da seção 12.
