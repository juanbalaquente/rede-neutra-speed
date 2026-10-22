import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { partners, users } from "../src/db/schema.js";
import { createDemoAccounts } from "../src/scripts/demo-eustaquio.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

async function loginWith(email: string, password: string) {
  return ctx.app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

describe("contas de demonstração do Eustáquio", () => {
  it("cria uma conta por perfil, todas entram com a senha sorteada", async () => {
    const accounts = await createDemoAccounts(ctx.db, { resetPasswords: false });
    expect(accounts).toHaveLength(4);
    for (const a of accounts) {
      expect(a.password).toMatch(/^(?=.*[a-zA-Z])(?=.*\d).{12}$/);
      const res = await loginWith(a.email, a.password!);
      expect(res.status).toBe(200);
    }
    const sup = accounts.find((a) => a.email.startsWith("eustaquio.supervisor"))!;
    const cookie = (await loginWith(sup.email, sup.password!)).headers.get("set-cookie")!.split(";")[0]!;
    const { users } = await (await ctx.call(cookie, "GET", "/users")).json();
    expect(users.map((u: { email: string }) => u.email).sort()).toEqual([
      "eustaquio.atendente@demo.local",
      "eustaquio.supervisor@demo.local",
      "eustaquio.tecnico@demo.local",
    ]);
  });

  it("rodar de novo mantém as senhas; com --novas-senhas troca todas", async () => {
    const first = await createDemoAccounts(ctx.db, { resetPasswords: false });
    const again = await createDemoAccounts(ctx.db, { resetPasswords: false });
    expect(again.every((a) => a.password === null)).toBe(true);
    expect((await loginWith(first[0]!.email, first[0]!.password!)).status).toBe(200);

    const reset = await createDemoAccounts(ctx.db, { resetPasswords: true });
    expect((await loginWith(first[0]!.email, first[0]!.password!)).status).toBe(401);
    expect((await loginWith(reset[0]!.email, reset[0]!.password!)).status).toBe(200);
  });

  it("nunca usa um parceiro de verdade: código EUS de outro parceiro para tudo, sem criar nada", async () => {
    const other = await ctx.createPartner("Provedor de Verdade", "33444555000166", { code: "EUS" });
    await expect(createDemoAccounts(ctx.db, { resetPasswords: false })).rejects.toThrow(/Provedor de Verdade/);
    const all = await ctx.db.select().from(users).where(eq(users.partnerId, other.partner.id));
    expect(all).toHaveLength(2);
    expect((await ctx.db.select().from(users)).some((u) => u.email.startsWith("eustaquio."))).toBe(false);
  });

  it("conta do Eustáquio que ficou em outro parceiro volta para o de demonstração", async () => {
    const other = await ctx.createPartner("TESTE - Provedor Exemplo Ltda", "11222333000181");
    await ctx.db.insert(users).values({ partnerId: other.partner.id, email: "eustaquio.supervisor@demo.local", name: "Eustáquio (Supervisor)", role: "supervisor", passwordHash: "x" });
    const accounts = await createDemoAccounts(ctx.db, { resetPasswords: false });
    expect(accounts.find((a) => a.email === "eustaquio.supervisor@demo.local")!.moved).toBe(true);
    const [demo] = await ctx.db.select().from(partners).where(eq(partners.code, "EUS"));
    expect(demo!.name).toBe("Eustáquio Telecom");
    const [sup] = await ctx.db.select().from(users).where(eq(users.email, "eustaquio.supervisor@demo.local"));
    expect(sup!.partnerId).toBe(demo!.id);
  });
});
