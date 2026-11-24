# Viabilidade, vagas e reserva

Diário do módulo, movido de `docs/CONTEXTO.md` §6 em 2026-11-23 (card T-013). Entradas mais novas primeiro, com a data em que foram escritas; o que está "no ar" nelas é o que o doc dizia na data, não conferido de novo no servidor. Cobre: modelo de vagas, área por sigla, reserva de 48 h, pedido de vaga em CTO cheia, gestão de parceiros, e o estado do código de 6 e 7 out 2026 (histórico).

Volta para o índice: [`CONTEXTO.md` §6](../CONTEXTO.md#6-estado-do-código).

---

**Pedido de vaga em CTO cheia (20 out 2026, decisão dos donos: "não vamos perder vendas"), 267 testes, migration 0015:** CTO sem vaga livre, no limite do parceiro ou em "conferir" (dentro do raio de 300 m e da área liberada) ganha o botão "Pedir vaga nesta CTO". O pedido (`capacity_requests`) **não ocupa vaga nem passa pela trava**; o administrador Speed decide na tela "Pedidos de vaga" (sino e menu avisam). **Confirmar** cria uma reserva normal de 48 h para o parceiro (a Speed estende a rede se precisar); **recusar** exige motivo. O parceiro acompanha em Reservas e só depois da confirmação segue para contrato e agenda. Limite de pedidos em espera = limite de reservas do parceiro. Tudo auditado (`pedido_vaga.*`). A confirmação é pelo portal; a ligação com um chamado na Wiki fica para depois.

**Atualização de 7 out 2026 (sessão do portal), 67 testes passando:**

- **Modelo de vagas (decisões do Juan, 7 out 2026):** reserva por vaga, não por porta. Vaga = saída de splitter livre no diagrama do Codemaps, descontando clientes que o OLTCloud tem a mais; só Codemaps e OLTCloud entram na conta (Voalle e as caixas "nativas" ficam fora). CTO sem caixa no OLTCloud ou com dado velho (mais de 1 h) é "conferir". **Área do piloto por sigla no nome da CTO:** R1 (Backbone Central), ITA (Itacolomi) e FAT (Fátima); o administrador Speed define as siglas liberadas por parceiro (`allowedRegions`, vazio = nada é oferecido).
- **Integração por interface:** `NetworkMap` usa `ctoId` (id do Codemaps) e `getCtoVagas`. Modo `INTEGRATIONS_MODE=wiki` (`integrations/wiki.ts`), só leitura, valida a resposta contra [`CONTRATO-WIKI-V1.md`](../CONTRATO-WIKI-V1.md). A Wiki implementou e publicou as três rotas v1 (14 out 2026), mas está **bloqueada pelo Codemaps** (o IP de saída novo, 189.112.67.129, ainda recebe "dns not authorized"; chamado aberto com o suporte). Enquanto isso o portal segue em `INTEGRATIONS_MODE=mock` e `/health` devolve `ok:false`, o que é esperado.
- **Reserva por id:** a trava é `(cto_id, port)` (migration 0001). Reservar exige uma viabilidade do mesmo parceiro, para o mesmo endereço, nas últimas 24 h que tenha listado a CTO.
- **Painel da rede, auditoria e equipe:** o administrador Speed entra no Painel da rede (consultas de parceiros por dia, com viabilidade, sem viabilidade e fora da área; mapa de calor de ocupação das CTOs vistas, por sigla; visão em tabela) e tem Auditoria com nome de quem fez, parceiro e filtros. O supervisor do parceiro gerencia a própria Equipe. O mapa mostra só as CTOs que apareceram em consultas; o mapa completo por sigla depende de uma rota da Wiki (proposta no contrato).
- **Gestão de parceiros (administrador Speed):** tela "Parceiros" com uso atual (reservas abertas, usuários ativos), siglas liberadas (atalho para o piloto R1, ITA, FAT), limites, bloqueio com motivo obrigatório e reativação, e usuários do parceiro (cadastro do primeiro supervisor com senha gerada, desativar e reativar respeitando o limite). Telas conferidas em Chrome headless, claro, escuro e celular.
- **Reserva:** a trava virou contagem sob lock por CTO (reservas vivas de todos os parceiros + 1 ≤ vagas livres), com limite de 50% de `totalVagas` por parceiro, leitura `?fresh=true` e área conferida de novo no servidor. Migration 0002.
- **Front:** o visual do modelo 4 já está em Nova venda e Reservas (casca, Ctrl K, tema, anéis). As demais telas do protótipo ainda não existem. **Não foi verificado em navegador nesta sessão**; só typecheck e build.
- **Cobertura real:** os testes cobrem viabilidade, reserva, isolamento entre parceiros, login, cliente da Wiki e `/partner`. Não cobrem criação de parceiro e de usuário com limite, nem `GET /admin/audit`.
- **Pendências do portal:** trava de sinal (depende da média por CTO vinda da Wiki), limpeza do contador de login em memória, `clientIp` confiando em `x-forwarded-for`, ciclo de vida da reserva `convertida`.

**Pronto e testado até 6 out (18 testes):**

- Login, sessão, três perfis, trava de tentativas de login.
- Isolamento por `partner_id` validado no servidor; recurso de outro parceiro responde 404.
- Viabilidade: CTOs próximas, portas livres descontando reservas do portal, planos. Toda consulta registrada.
- Reserva 48 h com trava real no banco (índice único parcial em `cto_name + port` para status `ativa`/`convertida`), expiração, cancelamento pelo parceiro e pela Speed com motivo, limite de reservas simultâneas, limite de 50% por CTO.
- Supervisor cria e desativa os próprios atendentes dentro do limite.
- Admin Speed (só API): parceiros, limites, bloqueio do parceiro inteiro, auditoria.
- `audit_log` em toda ação e `api_call_log` em toda chamada a sistema de origem.
- Clientes reais de Codemaps (endereço → CTOs), OLTCloud (ocupação porta a porta) e Voalle (só autenticação), **nunca testados contra os sistemas reais**, porque eles liberam acesso por IP e só o servidor da SpeedWiki está liberado.

**Lista "Ainda não feito" de 6 out 2026 (histórico, superada; a lista atual fica no `CONTEXTO.md` §6):**

- Contrato no Voalle com ponto de acesso, aceite e PPPoE.
- Liberação de ONU no OLTCloud com trava de sinal.
- Telas de admin e de gestão de usuários (a API existe).
- Visual do protótipo aplicado ao código.
- Aviso de reserva, agenda, fotos e O.S., chamados, financeiro, dashboards e segundo fator já existem (rodando contra mock onde dependem da Wiki).
