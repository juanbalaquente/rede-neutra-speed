import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, photos } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { signPhotoLink, sniffImage, verifyPhotoLink } from "../src/services/photos.js";
import { LocalPhotoStorage } from "../src/storage/photos.js";
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

async function partnerWithReservation(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code });
  const cookie = await ctx.login(a.atendente);
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  return { a, cookie, reservation };
}

describe("envio de fotos", () => {
  it("guarda o arquivo e os metadados (contrato, GPS, hora) e registra na auditoria", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const res = await ctx.upload(cookie, reservation.id, { kind: "medicao", lat: "-19.9191", lng: "-43.9386", accuracyM: "12.5", capturedAt: "2026-10-15T10:00:00-03:00" });
    expect(res.status).toBe(201);
    const { photo } = await res.json();
    expect(photo).toMatchObject({ kind: "medicao", lat: -19.9191, lng: -43.9386, accuracyM: 12.5 });
    expect(photo).not.toHaveProperty("storageKey");
    const [row] = await ctx.db.select().from(photos).where(eq(photos.id, photo.id));
    expect(row?.mime).toBe("image/jpeg");
    expect(row?.sha256).toHaveLength(64);
    expect(row?.storageKey.startsWith(`${row!.partnerId}/${reservation.id}/`)).toBe(true);
    expect(ctx.photoStorage.files.has(row!.storageKey)).toBe(true);
    const log = (await ctx.db.select().from(auditLog)).find((l) => l.action === "foto.enviada");
    expect(log?.data).toMatchObject({ kind: "medicao", gps: true });
  });

  it("o nome do arquivo enviado nunca vira caminho", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const res = await ctx.upload(cookie, reservation.id, {}, ctx.JPEG, "../../../etc/passwd.jpg");
    expect(res.status).toBe(201);
    const [row] = await ctx.db.select().from(photos);
    expect(row?.storageKey).not.toMatch(/etc|passwd|\.\./);
  });

  it("recusa o que não é imagem, mesmo com tipo declarado de imagem", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const res = await ctx.upload(cookie, reservation.id, {}, new TextEncoder().encode("<html>não sou imagem</html>"));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("formato_invalido");
  });

  it("recusa foto acima do limite", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const big = new Uint8Array(9 * 1024 * 1024);
    big.set(ctx.JPEG);
    const res = await ctx.upload(cookie, reservation.id, {}, big);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("foto_grande_demais");
  });

  it("valida tipo da foto e coordenadas", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    expect((await ctx.upload(cookie, reservation.id, { kind: "selfie" })).status).toBe(400);
    expect((await ctx.upload(cookie, reservation.id, { lat: "99" })).status).toBe(400);
  });

  it("isolamento: reserva, foto e link de outro parceiro respondem 404", async () => {
    const mine = await partnerWithReservation();
    const { photo } = await (await ctx.upload(mine.cookie, mine.reservation.id)).json();
    const other = await ctx.createPartner("Outro", "44444444000144", { code: "OUT" });
    const otherCookie = await ctx.login(other.atendente);
    expect((await ctx.upload(otherCookie, mine.reservation.id)).status).toBe(404);
    expect((await ctx.call(otherCookie, "GET", `/photos/${photo.id}/file`)).status).toBe(404);
    expect((await ctx.call(otherCookie, "POST", `/photos/${photo.id}/link`, {})).status).toBe(404);
    expect((await (await ctx.call(otherCookie, "GET", `/reservations/${mine.reservation.id}/photos`)).json()).photos).toHaveLength(0);
  });

  it("o dono e a Speed veem o arquivo; sem login não", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const { photo } = await (await ctx.upload(cookie, reservation.id)).json();
    const own = await ctx.call(cookie, "GET", `/photos/${photo.id}/file`);
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toBe("image/jpeg");
    expect(own.headers.get("cache-control")).toMatch(/no-store/);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(ctx.JPEG);
    expect((await ctx.call(await ctx.login("admin@speed.test"), "GET", `/photos/${photo.id}/file`)).status).toBe(200);
    expect((await ctx.call(null, "GET", `/photos/${photo.id}/file`)).status).toBe(401);
  });
});

describe("link assinado para a Infra", () => {
  it("abre sem login, registra o acesso e some quando adulterado", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const { photo } = await (await ctx.upload(cookie, reservation.id)).json();
    const res = await ctx.call(cookie, "POST", `/photos/${photo.id}/link`, { hours: 24 });
    expect(res.status).toBe(201);
    const link = await res.json();
    expect(link.path).toMatch(/^\/api\/photos\/shared\//);
    const exp = new Date(link.expiresAt).getTime() - Date.now();
    expect(exp).toBeGreaterThan(23 * 3600_000);
    expect(exp).toBeLessThanOrEqual(24 * 3600_000);

    const open = await ctx.app.request(link.path);
    expect(open.status).toBe(200);
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(ctx.JPEG);
    const actions = (await ctx.db.select().from(auditLog)).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["foto.link_criado", "foto.vista_por_link"]));

    const tampered = link.path.slice(0, -2) + (link.path.endsWith("aa") ? "bb" : "aa");
    expect((await ctx.app.request(tampered)).status).toBe(404);
    expect((await ctx.app.request("/api/photos/shared/lixo")).status).toBe(404);
  });

  it("não passa de 48 h", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const { photo } = await (await ctx.upload(cookie, reservation.id)).json();
    expect((await ctx.call(cookie, "POST", `/photos/${photo.id}/link`, { hours: 72 })).status).toBe(400);
  });

  it("token vencido ou de outro segredo não vale", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const ok = signPhotoLink("p1", new Date(now.getTime() + 3600_000), "segredo-a");
    expect(verifyPhotoLink(ok, "segredo-a", now)).toBe("p1");
    expect(verifyPhotoLink(ok, "segredo-b", now)).toBeNull();
    const old = signPhotoLink("p1", new Date(now.getTime() - 1000), "segredo-a");
    expect(verifyPhotoLink(old, "segredo-a", now)).toBeNull();
    expect(verifyPhotoLink(`${ok}.extra`, "segredo-a", now)).toBeNull();
  });
});

describe("foto da medição e ativação", () => {
  const body = (reservationId: string) => ({ reservationId, serial: "ZTEGC0000001", contrato: "12345", sinalCtoDbm: -20 });

  it("sem foto de medição não libera a ONU; outros tipos de foto não contam", async () => {
    const { cookie, reservation } = await partnerWithReservation();
    const none = await ctx.call(cookie, "POST", "/activations", body(reservation.id));
    expect(none.status).toBe(422);
    expect((await none.json()).error).toBe("foto_medicao_obrigatoria");
    await ctx.upload(cookie, reservation.id, { kind: "etiqueta_porta" });
    expect((await ctx.call(cookie, "POST", "/activations", body(reservation.id))).status).toBe(422);
    await ctx.upload(cookie, reservation.id, { kind: "medicao" });
    expect((await ctx.call(cookie, "POST", "/activations", body(reservation.id))).status).toBe(202);
  });
});

describe("armazenamento em disco", () => {
  it("grava, lê e recusa chave que sai da pasta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fotos-"));
    try {
      const s = new LocalPhotoStorage(dir);
      await s.put("p/r/a.jpg", new Uint8Array([1, 2, 3]));
      expect(Array.from((await s.get("p/r/a.jpg"))!)).toEqual([1, 2, 3]);
      expect(await s.get("p/r/nao-existe.jpg")).toBeNull();
      await expect(s.put("../fora.jpg", new Uint8Array([1]))).rejects.toThrow(/inválida/);
      await expect(s.get("../../etc/passwd")).rejects.toThrow(/inválida/);
      await expect(s.put("p/r/a.jpg", new Uint8Array([9]))).rejects.toThrow(); // nunca sobrescreve
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reconhece o formato pelos bytes", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe("image/png");
    expect(sniffImage(new TextEncoder().encode("GIF89a......"))).toBeNull();
  });
});
