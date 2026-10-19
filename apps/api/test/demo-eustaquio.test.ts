import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
