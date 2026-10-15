import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activations, auditLog, partners, portReservations } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { expireOverdueReservations } from "../src/services/reservations.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap(), new MockActivationService());
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const GOOD = "ZTEGC0000001";
const BAD = "ZTEGC0000BAD";

async function partnerWithReservation(cnpj = "11111111000111", code: string | null = "JHV", withPhoto = true) {
  const a = await ctx.createPartner("JHV Telecom", cnpj, code ? { code } : {});
  const cookie = await ctx.login(a.atendente);
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const res = await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS });
  const { reservation } = await res.json();
  // A foto da medição na CTO é exigida antes de pedir a ativação.
  if (withPhoto) await ctx.upload(cookie, reservation.id, { kind: "medicao" });
  return { a, cookie, reservation };
}

const start = (cookie: string, reservationId: string, serial = GOOD, extra: object = {}) =>
  ctx.call(cookie, "POST", "/activations", { reservationId, serial, contrato: "12345", sinalCtoDbm: -20, ...extra });

async function poll(cookie: string, id: string, times: number) {
  let last: { activation: { state: string; snapshot: { sinal: { perdaDb: number } | null } } } | undefined;
  for (let i = 0; i < times; i++) last = await (await ctx.call(cookie, "GET", `/activations/${id}`)).json();
  return last!.activation;
}

describe("liberação de ONU", () => {
  it("fica desligada quando não há serviço de ativação", async () => {
    const off = await setup();
    const a = await off.createPartner("A", "22222222000122", { code: "AAA" });
    const res = await off.call(await off.login(a.atendente), "GET", "/activations");
    expect(res.status).toBe(503);
    await off.close();
  });

  it("caminho feliz: login PPPoE contrato-código, online converte a reserva", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const res = await start(cookie, reservation.id);
    expect(res.status).toBe(202);
    const { activation } = await res.json();
    expect(activation.pppLogin).toBe("12345-JHV");
    expect(activation.limiteDb).toBe(1.5);

    const final = await poll(cookie, activation.id, 5);
    expect(final.state).toBe("online");
    expect(final.snapshot.sinal?.perdaDb).toBe(0.8);
    const [r] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, reservation.id));
    expect(r?.status).toBe("convertida");
    expect(r?.contractNumber).toBe("12345");
    const actions = (await ctx.db.select().from(auditLog)).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["ativacao.pedida", "ativacao.online"]));
  });

  it("não guarda nada além do estado e das medições (sem senha)", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const { activation } = await (await start(cookie, reservation.id)).json();
    await poll(cookie, activation.id, 5);
    const [row] = await ctx.db.select().from(activations);
    expect(JSON.stringify(row)).not.toMatch(/senha|password/i);
  });

  it("trava de sinal: reprova, espera decisão e prossegue só com justificativa", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const { activation } = await (await start(cookie, reservation.id, BAD)).json();
    const parado = await poll(cookie, activation.id, 4);
    expect(parado.state).toBe("aguardando_decisao");
    expect(parado.snapshot.sinal?.perdaDb).toBe(3);

    const curta = await ctx.call(cookie, "POST", `/activations/${activation.id}/decision`, { acao: "prosseguir", justificativa: "ok" });
    expect(curta.status).toBe(422);
    const ok = await ctx.call(cookie, "POST", `/activations/${activation.id}/decision`, { acao: "prosseguir", justificativa: "Conector refeito e medição repetida." });
    expect(ok.status).toBe(200);
    expect((await poll(cookie, activation.id, 3)).state).toBe("online");
    const [log] = (await ctx.db.select().from(auditLog)).filter((l) => l.action === "ativacao.decisao");
    expect(JSON.stringify(log?.data)).toContain("Conector refeito");
  });

  it("cancelar na trava deixa a reserva ativa e libera novo pedido", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const { activation } = await (await start(cookie, reservation.id, BAD)).json();
    await poll(cookie, activation.id, 4);
    const res = await ctx.call(cookie, "POST", `/activations/${activation.id}/decision`, { acao: "cancelar" });
    expect((await res.json()).activation.state).toBe("cancelada");
    const [r] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, reservation.id));
    expect(r?.status).toBe("ativa");
    expect((await start(cookie, reservation.id, GOOD)).status).toBe(202);
  });

  it("decisão fora de aguardando_decisao é recusada", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const { activation } = await (await start(cookie, reservation.id)).json();
    const res = await ctx.call(cookie, "POST", `/activations/${activation.id}/decision`, { acao: "cancelar" });
    expect(res.status).toBe(409);
  });

  it("o limite de sinal é da Speed, auditado, e vale por ativação", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const adm = await ctx.login("admin@speed.test");
    expect((await ctx.call(cookie, "PUT", "/admin/settings/limite-sinal", { limiteDb: 3 })).status).toBe(403);
    expect((await ctx.call(adm, "PUT", "/admin/settings/limite-sinal", { limiteDb: 3.5 })).status).toBe(200);
    const { activation } = await (await start(cookie, reservation.id, BAD)).json();
    expect(activation.limiteDb).toBe(3.5);
    // Perda de 3 dB com limite de 3,5: passa direto.
    expect((await poll(cookie, activation.id, 5)).state).toBe("online");
    const cfg = (await ctx.db.select().from(auditLog)).find((l) => l.action === "config.limite_sinal");
    expect(cfg?.data).toMatchObject({ before: 1.5, after: 3.5 });
  });

  it("serial fora da lista de pendentes é recusada e marcada como falhou", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const res = await start(cookie, reservation.id, "ZTEGC9999999");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("serial_nao_pendente");
    const [row] = await ctx.db.select().from(activations);
    expect(row?.state).toBe("falhou");
  });

  it("repetir o pedido com a mesma chave não duplica", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const key = "2f6c0c9e-1111-4222-8333-444455556666";
    const one = await (await start(cookie, reservation.id, GOOD, { idempotencyKey: key })).json();
    const two = await (await start(cookie, reservation.id, GOOD, { idempotencyKey: key })).json();
    expect(two.activation.id).toBe(one.activation.id);
    expect(await ctx.db.select().from(activations)).toHaveLength(1);
  });

  it("segunda ativação na mesma reserva em andamento é conflito", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    await start(cookie, reservation.id);
    expect((await start(cookie, reservation.id)).status).toBe(409);
  });

  it("reserva com ativação em andamento não expira; depois de cancelada, expira", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const { activation } = await (await start(cookie, reservation.id, BAD)).json();
    await poll(cookie, activation.id, 4);
    const later = new Date(Date.now() + 49 * 3600_000);
    expect(await expireOverdueReservations(ctx.db, later)).toBe(0);
    const [still] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, reservation.id));
    expect(still?.status).toBe("ativa");
    await ctx.call(cookie, "POST", `/activations/${activation.id}/decision`, { acao: "cancelar" });
    expect(await expireOverdueReservations(ctx.db, later)).toBe(1);
  });

  it("parceiro sem código não ativa", async () => {
    const { cookie, reservation } = await partnerWithReservation("33333333000133", null);
    const res = await start(cookie, reservation.id);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("codigo_parceiro_ausente");
  });

  it("isolamento: reserva e ativação de outro parceiro respondem 404", async () => {
    const mine = await partnerWithReservation();
    const other = await ctx.createPartner("Outro", "44444444000144", { code: "OUT" });
    const otherCookie = await ctx.login(other.atendente);
    expect((await start(otherCookie, mine.reservation.id)).status).toBe(404);
    expect((await ctx.call(otherCookie, "GET", `/reservations/${mine.reservation.id}/onus-pendentes`)).status).toBe(404);
    const { activation } = await (await start(mine.cookie, mine.reservation.id)).json();
    expect((await ctx.call(otherCookie, "GET", `/activations/${activation.id}`)).status).toBe(404);
    expect((await ctx.call(otherCookie, "POST", `/activations/${activation.id}/decision`, { acao: "cancelar" })).status).toBe(404);
  });

  it("lista as ONUs pendentes da OLT da CTO reservada", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const res = await ctx.call(cookie, "GET", `/reservations/${reservation.id}/onus-pendentes`);
    expect((await res.json()).onus.map((o: { serial: string }) => o.serial)).toEqual([GOOD, BAD]);
  });

  it("código do parceiro: só admin define, em maiúsculas e único", async () => {
    const adm = await ctx.login("admin@speed.test");
    const a = await ctx.createPartner("A", "55555555000155");
    const b = await ctx.createPartner("B", "66666666000166");
    expect((await ctx.call(adm, "PATCH", `/admin/partners/${a.partner.id}`, { code: "jhv" })).status).toBe(200);
    const [p] = await ctx.db.select().from(partners).where(eq(partners.id, a.partner.id));
    expect(p?.code).toBe("JHV");
    expect((await ctx.call(adm, "PATCH", `/admin/partners/${b.partner.id}`, { code: "JHV" })).status).toBe(409);
    expect((await ctx.call(adm, "PATCH", `/admin/partners/${b.partner.id}`, { code: "J-1" })).status).toBe(400);
  });
});
