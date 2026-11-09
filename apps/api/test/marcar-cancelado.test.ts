import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, portReservations } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockClientStatus } from "../src/integrations/mock-client-status.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { markCancelledOutside } from "../src/scripts/marcar-cancelado.js";
import { OS_REQUIRED_KINDS } from "../src/services/installations.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap(), new MockActivationService(), {}, undefined, undefined, new MockClientStatus());
});
afterEach(async () => {
  await ctx.close();
});

let addrSeq = 0;
async function installed(cookie: string, contract: string) {
  const addr = `Rua do Cancelamento, ${++addrSeq}, Belo Horizonte`;
  await ctx.call(cookie, "POST", "/viability", { address: addr });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: addr })).json();
  await ctx.setCliente(cookie, reservation.id);
  await ctx.upload(cookie, reservation.id, { kind: "medicao" });
  const { activation } = await (await ctx.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: contract, sinalCtoDbm: -20 })).json();
  for (let i = 0; i < 5; i++) await ctx.call(cookie, "GET", `/activations/${activation.id}`);
  for (const kind of OS_REQUIRED_KINDS.filter((k) => k !== "medicao")) await ctx.upload(cookie, reservation.id, { kind });
  expect((await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, { sinalFinalDbm: -21, modeloOnu: "F670L", serialOnu: "ZTEGC0000001" })).status).toBe(200);
  return reservation.id as string;
}

describe("marcar cancelado fora do portal", () => {
  it("sem --apply não muda nada; com --apply cancela no portal, audita e tira da lista de ONUs", async () => {
    const a = await ctx.createPartner("JHV Telecom", "11111111000111", { code: "JHV", maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
    const ate = await ctx.login(a.atendente);
    const id = await installed(ate, "33726");
    const at = new Date("2026-10-21T15:00:00Z");
    const base = { partnerCode: "jhv", contracts: ["33726", "99999"], at, reason: "Teste de bancada cancelado no Voalle" };

    expect(await markCancelledOutside(ctx.db, { ...base, apply: false })).toEqual([
      { contract: "33726", outcome: "seria_marcado", openOperations: 0 },
      { contract: "99999", outcome: "nao_encontrado", openOperations: 0 },
    ]);
    expect((await ctx.db.select().from(portReservations).where(eq(portReservations.id, id)))[0]!.customerStatus).toBe("ativo");

    expect((await markCancelledOutside(ctx.db, { ...base, apply: true }))[0]).toMatchObject({ contract: "33726", outcome: "marcado" });
    const [r] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, id));
    expect(r).toMatchObject({ status: "cancelada", customerStatus: "cancelado", cancelReason: "Teste de bancada cancelado no Voalle" });
    expect(r!.cancelledAt?.toISOString()).toBe(at.toISOString());
    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.action, "cliente.cancelado_fora_do_portal"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityId: id, userId: null });

    expect((await (await ctx.call(ate, "GET", "/onus")).json()).onus).toHaveLength(0);
    expect((await markCancelledOutside(ctx.db, { ...base, contracts: ["33726"], apply: true }))[0]!.outcome).toBe("ja_cancelado");
  });

  it("não alcança cliente de outro parceiro com o mesmo número", async () => {
    const out = await ctx.createPartner("Outro", "44444444000144", { code: "OUT", maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
    await installed(await ctx.login(out.atendente), "33726");
    await ctx.createPartner("JHV Telecom", "11111111000111", { code: "JHV" });
    expect((await markCancelledOutside(ctx.db, { partnerCode: "JHV", contracts: ["33726"], apply: true, at: new Date(), reason: "x" }))[0]!.outcome).toBe("nao_encontrado");
    await expect(markCancelledOutside(ctx.db, { partnerCode: "NOPE", contracts: ["1"], apply: false, at: new Date(), reason: "x" })).rejects.toThrow(/NOPE/);
  });
});
