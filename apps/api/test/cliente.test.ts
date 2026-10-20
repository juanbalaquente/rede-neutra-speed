import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, plans, portReservations } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { setup, TEST_NOW } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap(), new MockActivationService());
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";

async function reserved(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code });
  const cookie = await ctx.login(a.atendente);
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  return { a, cookie, reservation };
}

const planId = async () => (await ctx.db.select().from(plans).orderBy(plans.speedMbps))[0]!.id;

describe("dados do cliente", () => {
  it("guarda plano, apelido, visita e técnico e mostra na instalação", async () => {
    const { cookie, reservation } = await reserved();
    const res = await ctx.setCliente(cookie, reservation.id, { nickname: "  Casa do Zé  " });
    expect(res.status).toBe(200);
    const { installation } = await res.json();
    expect(installation).toMatchObject({ nickname: "Casa do Zé", technician: "Carlos Técnico", visitStatus: "agendada", planMbps: 600 });
    expect(new Date(installation.visitAt).toISOString()).toBe("2026-10-20T13:00:00.000Z");
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toContain("cliente.dados");
  });

  it("o apelido é opcional; plano, visita e técnico não", async () => {
    const { cookie, reservation } = await reserved();
    expect((await ctx.setCliente(cookie, reservation.id, { nickname: null })).status).toBe(200);
    const url = `/reservations/${reservation.id}/cliente`;
    const base = { planId: await planId(), visitAt: "2026-10-20T10:00:00-03:00", technician: "Carlos" };
    expect((await ctx.call(cookie, "PATCH", url, { ...base, planId: undefined })).status).toBe(400);
    expect((await ctx.call(cookie, "PATCH", url, { ...base, visitAt: undefined })).status).toBe(400);
    expect((await ctx.call(cookie, "PATCH", url, { ...base, visitAt: "amanhã" })).status).toBe(400);
    expect((await ctx.call(cookie, "PATCH", url, { ...base, technician: "" })).status).toBe(400);
  });

  it("guarda o endereço da instalação junto com os dados do cliente e valida o CEP", async () => {
    const { cookie, reservation } = await reserved();
    const endereco = { cep: "34505000", rua: "Rua Tomé de Souza", numero: "507", complemento: "", bairro: "Rosário", cidade: "Sabará", uf: "mg" };
    expect((await ctx.setCliente(cookie, reservation.id, { endereco: { ...endereco, cep: "345-05" } })).status).toBe(400);
    expect((await ctx.setCliente(cookie, reservation.id, { endereco })).status).toBe(200);
    const [row] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, reservation.id));
    expect(row?.installAddress).toEqual({ ...endereco, uf: "MG" });
    // Sem endereço no pedido, o que estava salvo continua.
    expect((await ctx.setCliente(cookie, reservation.id, { nickname: "Zé" })).status).toBe(200);
    const [kept] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, reservation.id));
    expect(kept?.installAddress).toMatchObject({ cep: "34505000", numero: "507" });
  });

  it("recusa visita no passado ou a mais de um ano, mas aceita hoje e editar o resto de uma visita antiga", async () => {
    const { cookie, reservation } = await reserved();
    const past = await ctx.setCliente(cookie, reservation.id, { visitAt: "2020-01-01T10:00:00-03:00" });
    expect(past.status).toBe(422);
    expect((await past.json()).error).toBe("visita_no_passado");
    const far = await ctx.setCliente(cookie, reservation.id, { visitAt: "9999-12-31T10:00:00Z" });
    expect(far.status).toBe(422);
    expect((await far.json()).error).toBe("visita_distante");
    // Duas horas atrás ainda é "hoje" (tolerância de um dia para quem registra depois da visita).
    expect((await ctx.setCliente(cookie, reservation.id, { visitAt: new Date(TEST_NOW.getTime() - 2 * 3600_000).toISOString() })).status).toBe(200);
    // Visita antiga já gravada não impede trocar o apelido, desde que a data não mude.
    await ctx.db.update(portReservations).set({ visitAt: new Date("2020-01-01T13:00:00Z") }).where(eq(portReservations.id, reservation.id));
    expect((await ctx.setCliente(cookie, reservation.id, { visitAt: "2020-01-01T13:00:00Z", nickname: "Novo apelido" })).status).toBe(200);
    // Reagendar para o passado é recusado, também pela agenda.
    const res = await ctx.call(cookie, "PATCH", `/reservations/${reservation.id}/visita`, { visitAt: "2020-02-01T10:00:00Z" });
    expect(res.status).toBe(422);
  });

  it("recusa UF que não existe", async () => {
    const { cookie, reservation } = await reserved();
    const endereco = { cep: "34505000", rua: "Rua Tomé de Souza", numero: "507", complemento: "", bairro: "Rosário", cidade: "Sabará", uf: "XX" };
    expect((await ctx.setCliente(cookie, reservation.id, { endereco })).status).toBe(400);
    expect((await ctx.setCliente(cookie, reservation.id, { endereco: { ...endereco, uf: "mg" } })).status).toBe(200);
  });

  it("recusa plano que não existe ou foi desativado", async () => {
    const { cookie, reservation } = await reserved();
    const res = await ctx.setCliente(cookie, reservation.id, { planId: "00000000-0000-4000-8000-000000000000" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("plano_invalido");
    const [p] = await ctx.db.select().from(plans).orderBy(plans.speedMbps);
    await ctx.db.update(plans).set({ active: false }).where(eq(plans.id, p!.id));
    expect((await ctx.setCliente(cookie, reservation.id, { planId: p!.id })).status).toBe(422);
  });

  it("mudar a data de uma visita marcada vira reagendada; repetir a mesma não", async () => {
    const { cookie, reservation } = await reserved();
    await ctx.setCliente(cookie, reservation.id);
    const same = await (await ctx.setCliente(cookie, reservation.id, { technician: "Outro Técnico" })).json();
    expect(same.installation.visitStatus).toBe("agendada");
    const moved = await (await ctx.setCliente(cookie, reservation.id, { visitAt: "2026-10-22T14:00:00-03:00" })).json();
    expect(moved.installation.visitStatus).toBe("reagendada");
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toContain("visita.reagendada");
  });

  it("a ONU só é liberada com os dados do cliente; ao liberar a visita fica em execução", async () => {
    const { cookie, reservation } = await reserved();
    await ctx.upload(cookie, reservation.id, { kind: "medicao" });
    const body = { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: "12345", sinalCtoDbm: -20 };
    const blocked = await ctx.call(cookie, "POST", "/activations", body);
    expect(blocked.status).toBe(422);
    const err = await blocked.json();
    expect(err.error).toBe("dados_cliente_obrigatorios");
    expect(err.message).toContain("plano");
    expect(err.message).toContain("técnico responsável");
    await ctx.setCliente(cookie, reservation.id);
    expect((await ctx.call(cookie, "POST", "/activations", body)).status).toBe(202);
    const [r] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, reservation.id));
    expect(r?.visitStatus).toBe("em_execucao");
  });

  it("isolamento, perfis e O.S. fechada", async () => {
    const mine = await reserved();
    const other = await ctx.createPartner("Outro", "44444444000144", { code: "OUT" });
    const otherCookie = await ctx.login(other.atendente);
    expect((await ctx.setCliente(otherCookie, mine.reservation.id)).status).toBe(404);
    expect((await ctx.setCliente(await ctx.login("admin@speed.test"), mine.reservation.id)).status).toBe(403);
    await ctx.db.update(portReservations).set({ osClosedAt: new Date() }).where(eq(portReservations.id, mine.reservation.id));
    expect((await ctx.setCliente(mine.cookie, mine.reservation.id)).status).toBe(409);
  });

  it("sugere os técnicos já usados, só do próprio parceiro", async () => {
    const { cookie, reservation } = await reserved();
    await ctx.setCliente(cookie, reservation.id, { technician: "Carlos Técnico" });
    const other = await ctx.createPartner("Outro", "44444444000144", { code: "OUT" });
    const oc = await ctx.login(other.atendente);
    await ctx.call(oc, "POST", "/viability", { address: ADDRESS });
    const { reservation: r2 } = await (await ctx.call(oc, "POST", "/reservations", { ctoId: "CTO-TESTE-03", address: ADDRESS })).json();
    await ctx.setCliente(oc, r2.id, { technician: "Técnico do Outro" });
    expect((await (await ctx.call(cookie, "GET", "/technicians")).json()).technicians).toEqual(["Carlos Técnico"]);
  });
});
