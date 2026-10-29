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

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap(), new MockActivationService(), {}, new MockCustomerActions());
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";

async function installedClient() {
  const a = await ctx.createPartner("JHV Telecom", "11111111000111", { code: "JHV", maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  const sup = await ctx.login(a.supervisor);
  await ctx.call(sup, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(sup, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  await ctx.setCliente(sup, reservation.id);
  await ctx.upload(sup, reservation.id, { kind: "medicao" });
  const { activation } = await (await ctx.call(sup, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: "10001", sinalCtoDbm: -20 })).json();
  for (let i = 0; i < 5; i++) await ctx.call(sup, "GET", `/activations/${activation.id}`);
  for (const kind of OS_REQUIRED_KINDS.filter((k) => k !== "medicao")) await ctx.upload(sup, reservation.id, { kind });
  await ctx.call(sup, "POST", `/reservations/${reservation.id}/os/close`, { sinalFinalDbm: -21, modeloOnu: "F670L", serialOnu: "ZTEGC0000001" });
  return { sup, id: reservation.id as string };
}

const startOp = (cookie: string, id: string, body: object) => ctx.call(cookie, "POST", `/installations/${id}/operations`, body);

describe("aprovação da Speed", () => {
  it("por padrão nada exige aprovação: a operação segue direto", async () => {
    const { sup, id } = await installedClient();
    const res = await startOp(sup, id, { type: "bloqueio", reason: "inadimplência" });
    expect(res.status).toBe(202);
    expect((await res.json()).operation.state).toBe("recebida");
  });

  it("tipo que exige aprovação espera sem chegar à Wiki; aprovar envia e o parceiro vê o andamento", async () => {
    const { sup, id } = await installedClient();
    const adm = await ctx.login("admin@speed.test");
    expect((await ctx.call(adm, "PUT", "/admin/settings/aprovacoes", { types: ["cancelamento"] })).status).toBe(200);
    // Bloqueio não exige: segue.
    expect((await (await startOp(sup, id, { type: "bloqueio", reason: "motivo de teste" })).json()).operation.state).toBe("recebida");
    const res = await startOp(sup, id, { type: "cancelamento", reason: "pedido do cliente" });
    expect(res.status).toBe(202);
    const op = (await res.json()).operation;
    expect(op.state).toBe("aguardando_aprovacao");
    // Consultar não manda nada à Wiki enquanto espera.
    expect((await (await ctx.call(sup, "GET", `/operations/${op.id}`)).json()).operation.state).toBe("aguardando_aprovacao");
    // Repetir o pedido não vira uma segunda ordem.
    expect((await startOp(sup, id, { type: "cancelamento", reason: "de novo" })).status).toBe(409);

    const pending = (await (await ctx.call(adm, "GET", "/admin/operations/pending")).json()).operations;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: op.id, type: "cancelamento", partnerName: "JHV Telecom", contract: "10001" });

    const ok = await ctx.call(adm, "POST", `/admin/operations/${op.id}/approve`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).operation.state).toBe("recebida");
    let state = "recebida";
    for (let i = 0; i < 8 && state !== "concluida"; i++) state = (await (await ctx.call(sup, "GET", `/operations/${op.id}`)).json()).operation.state;
    expect(state).toBe("concluida");
    expect((await ctx.db.select().from(portReservations).where(eq(portReservations.id, id)))[0]!.status).toBe("cancelada");
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toEqual(expect.arrayContaining(["config.aprovacao", "cliente.operacao_aprovada"]));
    expect((await ctx.call(adm, "POST", `/admin/operations/${op.id}/approve`)).status).toBe(409); // já decidida
  });

  it("recusar exige motivo, o parceiro vê o motivo e pode pedir de novo", async () => {
    const { sup, id } = await installedClient();
    const adm = await ctx.login("admin@speed.test");
    await ctx.call(adm, "PUT", "/admin/settings/aprovacoes", { types: ["cancelamento"] });
    const op = (await (await startOp(sup, id, { type: "cancelamento", reason: "pedido do cliente" })).json()).operation;
    expect((await ctx.call(adm, "POST", `/admin/operations/${op.id}/refuse`, { reason: "x" })).status).toBe(400);
    const refused = await ctx.call(adm, "POST", `/admin/operations/${op.id}/refuse`, { reason: "Fatura do parceiro em aberto" });
    expect(refused.status).toBe(200);
    const view = (await (await ctx.call(sup, "GET", `/operations/${op.id}`)).json()).operation;
    expect(view).toMatchObject({ state: "recusada", decisionReason: "Fatura do parceiro em aberto" });
    expect((await ctx.db.select().from(portReservations).where(eq(portReservations.id, id)))[0]!.status).toBe("convertida"); // nada mudou
    expect((await startOp(sup, id, { type: "cancelamento", reason: "novo pedido" })).status).toBe(202);
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toContain("cliente.operacao_recusada_pela_speed");
  });

  it("só a Speed configura e decide; tipo inválido é recusado", async () => {
    const { sup, id } = await installedClient();
    expect((await ctx.call(sup, "PUT", "/admin/settings/aprovacoes", { types: ["bloqueio"] })).status).toBe(403);
    expect((await ctx.call(sup, "GET", "/admin/operations/pending")).status).toBe(403);
    const adm = await ctx.login("admin@speed.test");
    expect((await ctx.call(adm, "PUT", "/admin/settings/aprovacoes", { types: ["troca_de_senha"] })).status).toBe(400);
    await ctx.call(adm, "PUT", "/admin/settings/aprovacoes", { types: ["reinicio"] });
    const op = (await (await startOp(sup, id, { type: "reinicio" })).json()).operation;
    expect((await ctx.call(sup, "POST", `/admin/operations/${op.id}/approve`)).status).toBe(403);
    expect((await (await ctx.call(adm, "GET", "/admin/settings/aprovacoes")).json()).types).toEqual(["reinicio"]);
  });
});

describe("operações em lote", () => {
  async function second(partnerCookie: string, contract: string) {
    // Mais um cliente instalado do mesmo parceiro.
    await ctx.call(partnerCookie, "POST", "/viability", { address: ADDRESS });
    const { reservation } = await (await ctx.call(partnerCookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
    await ctx.setCliente(partnerCookie, reservation.id);
    await ctx.upload(partnerCookie, reservation.id, { kind: "medicao" });
    const { activation } = await (await ctx.call(partnerCookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: contract, sinalCtoDbm: -20 })).json();
    for (let i = 0; i < 5; i++) await ctx.call(partnerCookie, "GET", `/activations/${activation.id}`);
    for (const kind of OS_REQUIRED_KINDS.filter((k) => k !== "medicao")) await ctx.upload(partnerCookie, reservation.id, { kind });
    await ctx.call(partnerCookie, "POST", `/reservations/${reservation.id}/os/close`, { sinalFinalDbm: -21, modeloOnu: "F670L", serialOnu: "ZTEGC0000001" });
    return reservation.id as string;
  }
  const batch = (cookie: string, body: object) => ctx.call(cookie, "POST", "/operations/batch", body);

  it("bloqueia vários de uma vez, pula quem não pode e não deixa o lote cair", async () => {
    const { sup, id: a } = await installedClient();
    const b = await second(sup, "10002");
    const ghost = crypto.randomUUID();
    await startOp(sup, b, { type: "bloqueio", reason: "já bloqueado antes" });
    const res = await batch(sup, { type: "bloqueio", reservationIds: [a, b, ghost], reason: "inadimplência" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ feitos: 1, pulados: 2 });
    const by = Object.fromEntries(body.results.map((r: { reservationId: string }) => [r.reservationId, r]));
    expect(by[a]).toMatchObject({ ok: true, state: "recebida" });
    expect(by[b].ok).toBe(false); // já tem bloqueio em andamento
    expect(by[ghost]).toMatchObject({ ok: false, error: "Cliente não encontrado." });
    expect((await ctx.db.select().from(auditLog)).filter((l) => l.action === "cliente.lote")).toHaveLength(1);
  });

  it("não aceita cancelamento em lote, passa de 50 ou lista vazia; respeita a aprovação da Speed", async () => {
    const { sup, id } = await installedClient();
    expect((await batch(sup, { type: "cancelamento", reservationIds: [id], reason: "x" })).status).toBe(400);
    expect((await batch(sup, { type: "reinicio", reservationIds: [] })).status).toBe(400);
    expect((await batch(sup, { type: "reinicio", reservationIds: Array.from({ length: 51 }, () => crypto.randomUUID()) })).status).toBe(400);
    const adm = await ctx.login("admin@speed.test");
    await ctx.call(adm, "PUT", "/admin/settings/aprovacoes", { types: ["reinicio"] });
    const res = await (await batch(sup, { type: "reinicio", reservationIds: [id] })).json();
    expect(res.results[0]).toMatchObject({ ok: true, state: "aguardando_aprovacao" });
  });

  it("não alcança cliente de outro parceiro", async () => {
    const { id } = await installedClient();
    const other = await ctx.createPartner("Outro", "22222222000122", { code: "OUT" });
    const cookie = await ctx.login(other.supervisor);
    const res = await (await batch(cookie, { type: "bloqueio", reservationIds: [id], reason: "motivo de teste" })).json();
    expect(res).toMatchObject({ feitos: 0, pulados: 1 });
    expect(res.results[0].error).toBe("Cliente não encontrado.");
  });
});
