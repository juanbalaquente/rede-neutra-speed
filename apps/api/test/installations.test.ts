import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, portReservations } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { OS_REQUIRED_KINDS } from "../src/services/installations.js";
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
const OS = { porta: "05", sinalFinalDbm: -21.2, modeloOnu: "F670L", serialOnu: "ztegc0000001", observacao: "Cliente satisfeito" };

async function partnerReservation(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code });
  const cookie = await ctx.login(a.atendente);
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  return { a, cookie, reservation };
}

/** Leva a reserva até a ONU online (medição na CTO enviada, ativação concluída). */
async function toOnline(cookie: string, reservationId: string) {
  await ctx.upload(cookie, reservationId, { kind: "medicao" });
  const { activation } = await (
    await ctx.call(cookie, "POST", "/activations", { reservationId, serial: "ZTEGC0000001", contrato: "12345", sinalCtoDbm: -20 })
  ).json();
  for (let i = 0; i < 5; i++) await ctx.call(cookie, "GET", `/activations/${activation.id}`);
}

const uploadAll = async (cookie: string, reservationId: string, kinds: readonly string[] = OS_REQUIRED_KINDS) => {
  for (const kind of kinds) expect((await ctx.upload(cookie, reservationId, { kind })).status).toBe(201);
};

describe("fechar a O.S.", () => {
  it("só depois que a ONU subiu", async () => {
    const { cookie, reservation } = await partnerReservation();
    const res = await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, OS);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("onu_nao_liberada");
  });

  it("exige as fotos do checklist e diz quais faltam", async () => {
    const { cookie, reservation } = await partnerReservation();
    await toOnline(cookie, reservation.id);
    const res = await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, OS);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("fotos_obrigatorias");
    expect(body.message).toContain("cto_aberta");
    expect(body.message).not.toContain("medicao,"); // a da CTO já foi enviada
    const detail = await (await ctx.call(cookie, "GET", `/installations/${reservation.id}`)).json();
    expect(detail.installation.fotosFaltando).toEqual(["cto_aberta", "etiqueta_porta", "medicao_onu", "sobra_fibra", "onu_instalada"]);
  });

  it("fecha com tudo: guarda os dados, conclui a visita e audita", async () => {
    const { cookie, reservation } = await partnerReservation();
    await toOnline(cookie, reservation.id);
    await uploadAll(cookie, reservation.id, OS_REQUIRED_KINDS.filter((k) => k !== "medicao"));
    const res = await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, OS);
    expect(res.status).toBe(200);
    const { installation } = await res.json();
    expect(installation.osClosedAt).toBeTruthy();
    expect(installation.visitStatus).toBe("concluida");
    expect(installation.os).toMatchObject({ porta: "05", sinalFinalDbm: -21.2, modeloOnu: "F670L", serialOnu: "ZTEGC0000001", observacao: "Cliente satisfeito" });
    expect(installation.fotosFaltando).toEqual([]);
    const log = (await ctx.db.select().from(auditLog)).find((l) => l.action === "os.fechada");
    expect(log?.data).toMatchObject({ contract: "12345", sinalFinalDbm: -21.2 });
    // Não fecha duas vezes.
    expect((await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, OS)).status).toBe(409);
  });

  it("a porta é opcional (a reserva é por vaga)", async () => {
    const { cookie, reservation } = await partnerReservation();
    await toOnline(cookie, reservation.id);
    await uploadAll(cookie, reservation.id, OS_REQUIRED_KINDS.filter((k) => k !== "medicao"));
    const { porta, ...semPorta } = OS;
    void porta;
    const res = await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, semPorta);
    expect(res.status).toBe(200);
    expect((await res.json()).installation.os.porta).toBeNull();
  });

  it("a Speed pode tornar as fotos opcionais, com auditoria", async () => {
    const { cookie, reservation } = await partnerReservation();
    const adm = await ctx.login("admin@speed.test");
    expect((await ctx.call(cookie, "PUT", "/admin/settings/fotos-os", { obrigatorias: false })).status).toBe(403);
    expect((await (await ctx.call(adm, "GET", "/admin/settings/fotos-os")).json()).obrigatorias).toBe(true);
    expect((await ctx.call(adm, "PUT", "/admin/settings/fotos-os", { obrigatorias: false })).status).toBe(200);
    await toOnline(cookie, reservation.id);
    expect((await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, OS)).status).toBe(200);
    const cfg = (await ctx.db.select().from(auditLog)).find((l) => l.action === "config.fotos_os");
    expect(cfg?.data).toMatchObject({ before: true, after: false });
  });

  it("valida os dados", async () => {
    const { cookie, reservation } = await partnerReservation();
    const url = `/reservations/${reservation.id}/os/close`;
    expect((await ctx.call(cookie, "POST", url, { ...OS, sinalFinalDbm: 5 })).status).toBe(400);
    expect((await ctx.call(cookie, "POST", url, { ...OS, serialOnu: "abc" })).status).toBe(400);
    expect((await ctx.call(cookie, "POST", url, { ...OS, modeloOnu: "" })).status).toBe(400);
  });

  it("isolamento: outro parceiro não fecha, não vê e a Speed vê tudo", async () => {
    const mine = await partnerReservation();
    await toOnline(mine.cookie, mine.reservation.id);
    const other = await ctx.createPartner("Outro", "44444444000144", { code: "OUT" });
    const otherCookie = await ctx.login(other.atendente);
    expect((await ctx.call(otherCookie, "POST", `/reservations/${mine.reservation.id}/os/close`, OS)).status).toBe(404);
    expect((await ctx.call(otherCookie, "GET", `/installations/${mine.reservation.id}`)).status).toBe(404);
    expect((await (await ctx.call(otherCookie, "GET", "/installations")).json()).installations).toHaveLength(0);

    const adm = await ctx.login("admin@speed.test");
    const all = (await (await ctx.call(adm, "GET", "/installations")).json()).installations;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: mine.reservation.id, partnerName: "JHV Telecom", activationState: "online" });
    // O parceiro não recebe o nome do parceiro (nem o dele) na lista.
    expect((await (await ctx.call(mine.cookie, "GET", "/installations")).json()).installations[0].partnerName).toBeNull();
    // A Speed não fecha O.S. pelo parceiro.
    expect((await ctx.call(adm, "POST", `/reservations/${mine.reservation.id}/os/close`, OS)).status).toBe(403);
  });
});

describe("VLAN na liberação", () => {
  it("aparece no estado da ativação depois da autorização", async () => {
    const { cookie, reservation } = await partnerReservation();
    await ctx.upload(cookie, reservation.id, { kind: "medicao" });
    const { activation } = await (
      await ctx.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: "12345", sinalCtoDbm: -20 })
    ).json();
    const first = await (await ctx.call(cookie, "GET", `/activations/${activation.id}`)).json(); // autorizando
    expect(first.activation.snapshot.vlan).toBeNull();
    let last = first;
    for (let i = 0; i < 4; i++) last = await (await ctx.call(cookie, "GET", `/activations/${activation.id}`)).json();
    expect(last.activation.snapshot.vlan).toBe(2500);
    const [r] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, reservation.id));
    expect(r?.status).toBe("convertida");
  });
});
