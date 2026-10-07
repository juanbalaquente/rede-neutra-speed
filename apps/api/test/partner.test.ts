import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("GET /partner", () => {
  it("cada usuário vê só o próprio parceiro e os limites dele", async () => {
    const ctx = await setup();
    try {
      const a = await ctx.createPartner("Alfa", "11111111000111", { maxActiveReservations: 7 });
      const b = await ctx.createPartner("Beta", "22222222000122");
      const ra = await (await ctx.call(await ctx.login(a.atendente), "GET", "/partner")).json();
      expect(ra.partner).toMatchObject({ id: a.partner.id, name: "Alfa", maxActiveReservations: 7 });
      const rb = await (await ctx.call(await ctx.login(b.supervisor), "GET", "/partner")).json();
      expect(rb.partner.id).toBe(b.partner.id);
      expect(rb.partner).not.toHaveProperty("cnpj");
    } finally {
      await ctx.close();
    }
  });

  it("administrador Speed não tem parceiro e sem sessão é 401", async () => {
    const ctx = await setup();
    try {
      expect((await (await ctx.call(await ctx.login("admin@speed.test"), "GET", "/partner")).json()).partner).toBeNull();
      expect((await ctx.call(null, "GET", "/partner")).status).toBe(401);
    } finally {
      await ctx.close();
    }
  });
});
