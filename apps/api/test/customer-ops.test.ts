import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, portReservations } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockCustomerActions } from "../src/integrations/mock-actions.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { OS_REQUIRED_KINDS } from "../src/services/installations.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
let actions: MockCustomerActions;

beforeEach(async () => {
  actions = new MockCustomerActions();
  ctx = await setup(new MockNetworkMap(), new MockActivationService(), {}, actions);
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const OS = { sinalFinalDbm: -21, modeloOnu: "F670L", serialOnu: "ZTEGC0000001" };

async function partner(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code, maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  return { a, sup: await ctx.login(a.supervisor), ate: await ctx.login(a.atendente) };
}

/** Cliente instalado: ONU online e O.S. fechada. */
async function installed(cookie: string, contract = "10001") {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  await ctx.setCliente(cookie, reservation.id);
  await ctx.upload(cookie, reservation.id, { kind: "medicao" });
  const { activation } = await (await ctx.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: contract, sinalCtoDbm: -20 })).json();
  for (let i = 0; i < 5; i++) await ctx.call(cookie, "GET", `/activations/${activation.id}`);
  for (const kind of OS_REQUIRED_KINDS.filter((k) => k !== "medicao")) await ctx.upload(cookie, reservation.id, { kind });
  expect((await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, OS)).status).toBe(200);
  return reservation.id as string;
}

const start = (cookie: string, id: string, body: object) => ctx.call(cookie, "POST", `/installations/${id}/operations`, body);

/** Consulta até a operação sair do andamento. */
async function settle(cookie: string, opId: string, max = 8) {
  let op: { state: string; steps: { nome: string; estado: string }[] } = { state: "recebida", steps: [] };
  for (let i = 0; i < max; i++) {
    op = (await (await ctx.call(cookie, "GET", `/operations/${opId}`)).json()).operation;
    if (["concluida", "parcial", "sem_confirmacao", "falhou"].includes(op.state)) break;
  }
  return op;
}

const statusOf = async (id: string) => (await ctx.db.select().from(portReservations).where(eq(portReservations.id, id)))[0]!;
const vagas = async (cookie: string) => {
  const v = await (await ctx.call(cookie, "POST", "/viability", { address: ADDRESS })).json();
  return v.ctos.find((c: { ctoId: string }) => c.ctoId === "CTO-TESTE-01").vagas as number;
};

describe("automações do cliente", () => {
  it("ficam desligadas sem o serviço de automação", async () => {
    const off = await setup(new MockNetworkMap(), new MockActivationService());
    const a = await off.createPartner("A", "22222222000122", { code: "AAA" });
    const res = await off.call(await off.login(a.atendente), "GET", "/operations/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(503);
    await off.close();
  });

  it("bloquear e desbloquear mudam a situação do contrato, mas não a vaga", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    const before = await vagas(ate);
    const res = await start(ate, id, { type: "bloqueio", reason: "inadimplência" });
    expect(res.status).toBe(202);
    const { operation } = await res.json();
    expect(operation).toMatchObject({ type: "bloqueio", login: "10001-JHV", state: "recebida" });
    expect((await settle(ate, operation.id)).state).toBe("concluida");
    expect((await statusOf(id)).customerStatus).toBe("bloqueado");
    expect(await vagas(ate)).toBe(before); // continua ocupando a porta

    // Não bloqueia duas vezes; só desbloqueia quem está bloqueado.
    expect((await start(ate, id, { type: "bloqueio" })).status).toBe(409);
    const un = (await (await start(ate, id, { type: "desbloqueio" })).json()).operation;
    expect((await settle(ate, un.id)).state).toBe("concluida");
    expect((await statusOf(id)).customerStatus).toBe("ativo");
    expect((await start(ate, id, { type: "desbloqueio" })).status).toBe(409);
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toEqual(expect.arrayContaining(["cliente.bloqueio_pedido", "cliente.bloqueio_concluida", "cliente.desbloqueio_concluida"]));
  });

  it("reiniciar não muda o cadastro; sem confirmação do equipamento não é falha", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    const op = (await (await start(ate, id, { type: "reinicio" })).json()).operation;
    expect((await settle(ate, op.id)).state).toBe("concluida");
    expect((await statusOf(id)).customerStatus).toBe("ativo");

    const odd = await partner("33333333000133", "SEMACK");
    const id2 = await installed(odd.ate, "20002");
    const op2 = (await (await start(odd.ate, id2, { type: "reinicio" })).json()).operation;
    expect((await settle(odd.ate, op2.id)).state).toBe("sem_confirmacao");
  });

  it("só cliente com a O.S. fechada recebe operação", async () => {
    const { ate } = await partner();
    await ctx.call(ate, "POST", "/viability", { address: ADDRESS });
    const { reservation } = await (await ctx.call(ate, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
    const res = await start(ate, reservation.id, { type: "bloqueio" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("operacao_indisponivel");
  });

  it("uma operação aberta por tipo; repetir a mesma chave devolve a mesma", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    const key = "2f6c0c9e-1111-4222-8333-444455556666";
    const one = (await (await start(ate, id, { type: "reinicio", idempotencyKey: key })).json()).operation;
    const two = (await (await start(ate, id, { type: "reinicio", idempotencyKey: key })).json()).operation;
    expect(two.id).toBe(one.id);
    expect((await start(ate, id, { type: "reinicio" })).status).toBe(409); // outra chave, mesma operação aberta
  });

  it("isolamento: outro parceiro não vê, não pede e não consulta", async () => {
    const mine = await partner();
    const id = await installed(mine.ate);
    const op = (await (await start(mine.ate, id, { type: "reinicio" })).json()).operation;
    const other = await partner("44444444000144", "OUT");
    expect((await start(other.ate, id, { type: "reinicio" })).status).toBe(404);
    expect((await ctx.call(other.ate, "GET", `/installations/${id}/operations`)).status).toBe(404);
    expect((await ctx.call(other.ate, "GET", `/operations/${op.id}`)).status).toBe(404);
    expect((await ctx.call(await ctx.login("admin@speed.test"), "GET", `/operations/${op.id}`)).status).toBe(403);
  });
});

describe("cancelar o cliente e devolver a vaga", () => {
  it("só o supervisor cancela, e com motivo", async () => {
    const { ate, sup } = await partner();
    const id = await installed(ate);
    expect((await start(ate, id, { type: "cancelamento", reason: "pedido do cliente" })).status).toBe(403);
    const noReason = await start(sup, id, { type: "cancelamento" });
    expect(noReason.status).toBe(422);
    expect((await noReason.json()).error).toBe("motivo_obrigatorio");
  });

  it("três etapas, a vaga volta e o cliente sai do financeiro e do painel", async () => {
    const { ate, sup } = await partner();
    const id = await installed(ate);
    const during = await vagas(ate);
    const dash0 = await (await ctx.call(ate, "GET", "/dashboard")).json();
    expect(dash0.portasAtivas).toBe(1);

    const op = (await (await start(sup, id, { type: "cancelamento", reason: "pedido do cliente" })).json()).operation;
    const done = await settle(sup, op.id);
    expect(done.state).toBe("concluida");
    expect(done.steps.map((s) => `${s.nome}:${s.estado}`)).toEqual(["contrato_encerrado:concluida", "onu_removida:concluida", "porta_devolvida:concluida"]);

    const r = await statusOf(id);
    expect(r).toMatchObject({ status: "cancelada", customerStatus: "cancelado", cancelReason: "pedido do cliente" });
    expect(await vagas(ate)).toBe(during + 1); // a vaga voltou
    expect((await (await ctx.call(ate, "GET", "/dashboard")).json()).portasAtivas).toBe(0);
    // A cobrança é do portal: o mês do cancelamento ainda é cobrado (mês cheio); o seguinte, não.
    const { monthBounds, monthOf } = await import("../src/services/finance.js");
    const month = monthOf(new Date());
    expect((await (await ctx.call(sup, "GET", `/finance?month=${month}`)).json()).resumo.portasAtivas).toBe(1);
    const next = monthOf(new Date(monthBounds(month).end.getTime() + 24 * 3600_000));
    expect((await (await ctx.call(sup, "GET", `/finance?month=${next}`)).json()).resumo.portasAtivas).toBe(0);
    // Cancelado continua na lista como histórico (fotos e O.S.), mas uma reserva cancelada antes de instalar não.
    const listed = (await (await ctx.call(sup, "GET", "/installations")).json()).installations as { id: string; customerStatus: string }[];
    expect(listed.find((i) => i.id === id)?.customerStatus).toBe("cancelado");
    expect((await ctx.call(sup, "GET", `/installations/${id}`)).status).toBe(200);
    // Cliente cancelado não recebe mais operação.
    expect((await start(sup, id, { type: "reinicio" })).status).toBe(409);
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toContain("cliente.cancelamento_concluida");
  });

  it("falha no meio fica parcial, a vaga NÃO volta, e repetir continua de onde parou", async () => {
    const p = await partner("55555555000155", "ERR");
    const id = await installed(p.ate, "30003");
    const before = await vagas(p.ate);
    const op = (await (await start(p.sup, id, { type: "cancelamento", reason: "teste de falha" })).json()).operation;
    const first = await settle(p.sup, op.id);
    expect(first.state).toBe("parcial");
    expect(first.steps.map((s) => `${s.nome}:${s.estado}`)).toEqual(["contrato_encerrado:concluida", "onu_removida:falhou", "porta_devolvida:pendente"]);
    expect((await statusOf(id)).status).toBe("convertida");
    expect(await vagas(p.ate)).toBe(before);

    const retry = await ctx.call(p.sup, "POST", `/operations/${op.id}/retry`);
    expect(retry.status).toBe(200);
    const second = await settle(p.sup, op.id);
    expect(second.state).toBe("concluida");
    expect((await statusOf(id)).status).toBe("cancelada");
    expect(await vagas(p.ate)).toBe(before + 1);
    // Concluída não se repete.
    expect((await ctx.call(p.sup, "POST", `/operations/${op.id}/retry`)).status).toBe(409);
  });

  it("pedido que não chegou à Wiki (automação desligada lá, 21 out 2026) fica marcado para reenviar e reenvia sem duplicar", async () => {
    const p = await partner("66666666000166", "OFF");
    const id = await installed(p.ate, "30004");
    const { IntegrationError } = await import("../src/integrations/types.js");
    const original = actions.start.bind(actions);
    actions.start = async () => {
      throw new IntegrationError("wiki", "POST /operacoes 503", 503);
    };
    expect((await start(p.sup, id, { type: "cancelamento", reason: "teste de reenvio" })).status).toBeGreaterThanOrEqual(500);
    const [op] = (await (await ctx.call(p.sup, "GET", `/installations/${id}/operations`)).json()).operations;
    expect(op).toMatchObject({ state: "recebida", notSent: true });

    actions.start = original;
    const resent = await ctx.call(p.sup, "POST", `/operations/${op.id}/retry`);
    expect(resent.status).toBe(200);
    expect((await resent.json()).operation.notSent).toBe(false);
    expect((await settle(p.sup, op.id)).state).toBe("concluida");
    const ops = (await (await ctx.call(p.sup, "GET", `/installations/${id}/operations`)).json()).operations;
    expect(ops).toHaveLength(1);
  });
});
