import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, recoveryCodes, users } from "../src/db/schema.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { base32Decode, base32Encode, decryptSecret, encryptSecret, hotp, stepOf, verifyTotp } from "../src/services/totp.js";
import { setup, PASSWORD } from "./helpers.js";

describe("TOTP: núcleo", () => {
  const rfc = new TextEncoder().encode("12345678901234567890");

  it("bate com os vetores oficiais da RFC 6238 (SHA-1, 8 dígitos)", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ];
    for (const [t, code] of vectors) expect(hotp(rfc, stepOf(new Date(t * 1000)), 8)).toBe(code);
  });

  it("base32 vai e volta", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
    expect(() => base32Decode("1!?")).toThrow();
  });

  it("aceita o intervalo atual e os vizinhos, recusa os distantes e o código já usado", () => {
    const secret = base32Encode(rfc);
    const now = new Date("2026-10-15T12:00:10Z");
    const step = stepOf(now);
    const code = (s: number) => hotp(rfc, s);
    expect(verifyTotp(secret, code(step), now)).toBe(step);
    expect(verifyTotp(secret, code(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, code(step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, code(step - 2), now)).toBeNull();
    expect(verifyTotp(secret, code(step), now, step)).toBeNull(); // replay
    expect(verifyTotp(secret, "12345", now)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now)).toBeNull();
  });

  it("o segredo só abre com a mesma chave", () => {
    const enc = encryptSecret("JBSWY3DPEHPK3PXP", "chave-a-0123456789");
    expect(enc).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(enc, "chave-a-0123456789")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptSecret(enc, "chave-b-0123456789")).toThrow();
  });
});

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap(), undefined, { MFA_REQUIRED: "true" });
});
afterEach(async () => {
  await ctx.close();
});

const nowCode = (secret: string, offset = 0) => hotp(base32Decode(secret), stepOf(new Date()) + offset);

async function loginPassword(email: string, password = PASSWORD) {
  const res = await ctx.app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { res, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]! };
}

const second = (challenge: string, body: object) =>
  ctx.app.request("/api/auth/login/2fa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge, ...body }) });

/** Supervisor com o segundo fator já configurado. */
async function enrolledSupervisor() {
  const a = await ctx.createPartner("A", "11111111000111");
  const { cookie } = await loginPassword(a.supervisor);
  const setup = await (await ctx.call(cookie, "POST", "/auth/2fa/setup")).json();
  const enabled = await ctx.call(cookie, "POST", "/auth/2fa/enable", { code: nowCode(setup.secret) });
  const { recoveryCodes } = await enabled.json();
  return { a, secret: setup.secret as string, recoveryCodes: recoveryCodes as string[], enrolCookie: cookie };
}

describe("segundo fator obrigatório", () => {
  it("supervisor sem segundo fator entra, mas só alcança a configuração", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const { res, cookie } = await loginPassword(a.supervisor);
    expect(res.status).toBe(200);
    expect(cookie).toContain("rn_session=");
    const blocked = await ctx.call(cookie, "POST", "/viability", { address: "Rua dos Testes, 100, Belo Horizonte" });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe("mfa_obrigatorio");
    const me = await (await ctx.call(cookie, "GET", "/auth/me")).json();
    expect(me.mfa).toEqual({ enabled: false, required: true, setupRequired: true });
  });

  it("atendente não é obrigado", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const { cookie } = await loginPassword(a.atendente);
    expect((await ctx.call(cookie, "POST", "/viability", { address: "Rua dos Testes, 100, Belo Horizonte" })).status).toBe(200);
    expect((await (await ctx.call(cookie, "GET", "/auth/me")).json()).mfa.required).toBe(false);
  });

  it("administrador Speed também é obrigado", async () => {
    const { cookie } = await loginPassword("admin@speed.test");
    const res = await ctx.call(cookie, "GET", "/admin/partners");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("mfa_obrigatorio");
  });

  it("com MFA_REQUIRED desligado nada muda", async () => {
    const off = await setup();
    const a = await off.createPartner("A", "22222222000122");
    expect((await off.call(await off.login(a.supervisor), "GET", "/users")).status).toBe(200);
    await off.close();
  });
});

describe("configurar o segundo fator", () => {
  it("segredo cifrado no banco, QR gerado, código errado recusado, certo libera tudo", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const { cookie } = await loginPassword(a.supervisor);
    const setup = await (await ctx.call(cookie, "POST", "/auth/2fa/setup")).json();
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Rede%20Neutra:/);
    expect(setup.qr).toMatch(/^data:image\/png;base64,/);
    const [row] = await ctx.db.select().from(users).where(eq(users.email, a.supervisor));
    expect(row?.totpSecretEnc).toBeTruthy();
    expect(row?.totpSecretEnc).not.toContain(setup.secret);
    expect(row?.totpEnabled).toBe(false);

    const wrong = await ctx.call(cookie, "POST", "/auth/2fa/enable", { code: "000000" });
    expect(wrong.status).toBe(422);
    const ok = await ctx.call(cookie, "POST", "/auth/2fa/enable", { code: nowCode(setup.secret) });
    expect(ok.status).toBe(200);
    const { recoveryCodes: codes } = await ok.json();
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);

    expect((await ctx.call(cookie, "GET", "/users")).status).toBe(200); // liberado
    const stored = await ctx.db.select().from(recoveryCodes);
    expect(stored).toHaveLength(10);
    expect(JSON.stringify(stored)).not.toContain(codes[0]); // só o hash
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toContain("auth.2fa_ativado");
    // Já ativo: não reconfigura por cima.
    expect((await ctx.call(cookie, "POST", "/auth/2fa/setup")).status).toBe(409);
  });
});

describe("login em duas etapas", () => {
  it("senha certa só devolve o desafio, sem cookie; o código troca por sessão", async () => {
    const { a, secret } = await enrolledSupervisor();
    const { res, cookie } = await loginPassword(a.supervisor);
    const body = await res.json();
    expect(body.mfa).toBe("required");
    expect(body.user).toBeUndefined();
    expect(cookie).toBe(""); // nenhuma sessão ainda

    // O código do mesmo intervalo da ativação já foi usado; o seguinte (janela +1) vale.
    const ok = await second(body.challenge, { code: nowCode(secret, 1) });
    expect(ok.status).toBe(200);
    const session = (ok.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(session).toContain("rn_session=");
    expect((await ctx.call(session, "GET", "/users")).status).toBe(200);
    expect((await ctx.db.select().from(auditLog)).find((l) => l.action === "auth.login" && (l.data as { segundoFator?: boolean } | null)?.segundoFator)).toBeTruthy();
  });

  it("código errado, repetido (replay) e desafio vencido ou falso são recusados", async () => {
    const { a, secret } = await enrolledSupervisor();
    const { res } = await loginPassword(a.supervisor);
    const { challenge } = await res.json();
    expect((await second(challenge, { code: "000000" })).status).toBe(401);
    const good = nowCode(secret, 1);
    expect((await second(challenge, { code: good })).status).toBe(200);
    expect((await second(challenge, { code: good })).status).toBe(401); // o mesmo código não vale de novo
    expect((await second("lixo-lixo-lixo-lixo", { code: good })).status).toBe(401);
  });

  it("o desafio não funciona como sessão", async () => {
    const { a } = await enrolledSupervisor();
    const { challenge } = await (await loginPassword(a.supervisor)).res.json();
    expect((await ctx.call(`rn_session=${challenge}`, "GET", "/auth/me")).status).toBe(401);
    const bearer = await ctx.app.request("/api/auth/me", { headers: { Authorization: `Bearer ${challenge}` } });
    expect(bearer.status).toBe(401);
  });

  it("código de recuperação vale uma vez só e fica na auditoria", async () => {
    const { a, recoveryCodes: codes } = await enrolledSupervisor();
    const first = await (await loginPassword(a.supervisor)).res.json();
    expect((await second(first.challenge, { recoveryCode: codes[0] })).status).toBe(200);
    const again = await (await loginPassword(a.supervisor)).res.json();
    expect((await second(again.challenge, { recoveryCode: codes[0] })).status).toBe(401);
    expect((await second(again.challenge, { recoveryCode: codes[1] })).status).toBe(200);
    const log = (await ctx.db.select().from(auditLog)).filter((l) => l.action === "auth.2fa_codigo_recuperacao");
    expect(log).toHaveLength(2);
    expect(log[0]?.data).toMatchObject({ restantes: 9 });
  });

  it("bloqueia depois de muitas tentativas erradas de código", async () => {
    const { a } = await enrolledSupervisor();
    const { challenge } = await (await loginPassword(a.supervisor)).res.json();
    for (let i = 0; i < 10; i++) expect((await second(challenge, { code: "000000" })).status).toBe(401);
    expect((await second(challenge, { code: "000000" })).status).toBe(429);
  });
});

describe("redefinição pelo administrador", () => {
  it("o admin redefine; o usuário volta a ter de configurar; ninguém redefine a si mesmo", async () => {
    const { a, secret } = await enrolledSupervisor();
    // O admin entra (também precisa de segundo fator em modo obrigatório): configura o dele.
    const { cookie: adminPwd } = await loginPassword("admin@speed.test");
    const adminSetup = await (await ctx.call(adminPwd, "POST", "/auth/2fa/setup")).json();
    expect((await ctx.call(adminPwd, "POST", "/auth/2fa/enable", { code: nowCode(adminSetup.secret) })).status).toBe(200);

    const [sup] = await ctx.db.select().from(users).where(eq(users.email, a.supervisor));
    const reset = await ctx.call(adminPwd, "POST", `/admin/users/${sup!.id}/2fa/reset`);
    expect(reset.status).toBe(200);
    const [after] = await ctx.db.select().from(users).where(eq(users.id, sup!.id));
    expect(after).toMatchObject({ totpEnabled: false, totpSecretEnc: null });
    expect(await ctx.db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, sup!.id))).toHaveLength(0);
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toContain("auth.2fa_redefinido");

    // Entra só com senha de novo e cai na configuração; o código antigo não vale mais.
    const { res, cookie } = await loginPassword(a.supervisor);
    const again = await res.json();
    expect(again.challenge).toBeUndefined();
    expect(again.mfa).toEqual({ enabled: false, required: true, setupRequired: true });
    expect((await ctx.call(cookie, "GET", "/users")).status).toBe(403);
    // O código do aplicativo antigo não vale: o segredo foi apagado.
    expect((await ctx.call(cookie, "POST", "/auth/2fa/enable", { code: nowCode(secret, 1) })).status).toBe(409);

    const [adm] = await ctx.db.select().from(users).where(eq(users.email, "admin@speed.test"));
    expect((await ctx.call(adminPwd, "POST", `/admin/users/${adm!.id}/2fa/reset`)).status).toBe(422);
    // Quem não é admin não redefine.
    expect((await ctx.call(cookie, "POST", `/admin/users/${sup!.id}/2fa/reset`)).status).toBe(403);
  });
});
