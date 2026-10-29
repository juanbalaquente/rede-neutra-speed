import { describe, expect, it } from "vitest";
import { MockNetworkMap, MOCK_CTOS } from "../src/integrations/mock.js";
import { setup } from "./helpers.js";

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
// Rede do mock + uma CTO cujo mapa diverge da leitura (vira "conferir").
const NET = () => new MockNetworkMap([...MOCK_CTOS, { id: "div", name: "CTO-DIVERGE", lat: -19.9192, lng: -43.9385, totalPorts: 8, occupied: [], mapFree: 2 }]);

describe("painel da Speed", () => {
  it("consultas por dia (só de parceiros) e estado mais recente das CTOs por sigla", async () => {
    const ctx = await setup(NET());
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      const fora = await ctx.createPartner("Fora", "22222222000122", { allowedRegions: ["R1"] });
      const ca = await ctx.login(a.atendente);
      await ctx.call(ca, "POST", "/viability", { address: ADDRESS });
      expect((await ctx.call(ca, "POST", "/reservations", { ctoId: "CTO-TESTE-03", address: ADDRESS })).status).toBe(201);
      await ctx.call(ca, "POST", "/viability", { address: ADDRESS }); // leitura depois da reserva
      await ctx.call(await ctx.login(fora.atendente), "POST", "/viability", { address: ADDRESS });
      const admin = await ctx.login("admin@speed.test");
      await ctx.call(admin, "POST", "/viability", { address: ADDRESS }); // não conta como demanda

      const p = await (await ctx.call(admin, "GET", "/admin/painel?days=7")).json();
      expect(p.totals).toMatchObject({ consultas: 3, viaveis: 2, foraDaArea: 1, reservasAbertas: 1, ctosVistas: 4, ctosConferir: 1 });
      expect(p.porDia).toHaveLength(7);
      expect(p.porDia.at(-1)).toMatchObject({ viavel: 2, foraDaArea: 1, semViabilidade: 0 });

      const ita = p.regioes.find((r: { regiao: string }) => r.regiao === "ITA");
      expect(ita).toMatchObject({ comVaga: 2, semVaga: 1, conferir: 1, reservasAbertas: 1 });
      const cto3 = ita.ctos.find((c: { ctoId: string }) => c.ctoId === "CTO-TESTE-03");
      expect(cto3).toMatchObject({ estado: "com_vaga", livres: 7, totalVagas: 8, reservasAbertas: 1 });
      const div = ita.ctos.find((c: { ctoId: string }) => c.ctoId === "div");
      expect(div).toMatchObject({ estado: "conferir", livres: null });
    } finally {
      await ctx.close();
    }
  });

  it("só o administrador Speed vê; período inválido é 400", async () => {
    const ctx = await setup();
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      expect((await ctx.call(await ctx.login(a.supervisor), "GET", "/admin/painel")).status).toBe(403);
      expect((await ctx.call(await ctx.login("admin@speed.test"), "GET", "/admin/painel?days=0")).status).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});

describe("auditoria", () => {
  it("traz quem fez e de qual parceiro, com filtro por ação", async () => {
    const ctx = await setup();
    try {
      const a = await ctx.createPartner("Alfa", "11111111000111");
      const ca = await ctx.login(a.atendente);
      await ctx.call(ca, "POST", "/viability", { address: ADDRESS });
      await ctx.call(ca, "POST", "/reservations", { ctoId: "CTO-TESTE-03", address: ADDRESS });
      const admin = await ctx.login("admin@speed.test");

      const all = await (await ctx.call(admin, "GET", "/admin/audit")).json();
      const created = all.entries.find((e: { action: string }) => e.action === "reserva.criada");
      expect(created).toMatchObject({ partnerName: "Alfa", userName: "Ate Alfa", userEmail: a.atendente });

      const only = await (await ctx.call(admin, "GET", `/admin/audit?action=reserva.&partnerId=${a.partner.id}`)).json();
      expect(only.entries.length).toBeGreaterThan(0);
      expect(only.entries.every((e: { action: string }) => e.action.startsWith("reserva."))).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it("filtro inválido é 400 (antes virava erro 500) e parceiro não acessa", async () => {
    const ctx = await setup();
    try {
      const a = await ctx.createPartner("Alfa", "11111111000111");
      const admin = await ctx.login("admin@speed.test");
      expect((await ctx.call(admin, "GET", "/admin/audit?partnerId=nao-e-uuid")).status).toBe(400);
      expect((await ctx.call(admin, "GET", "/admin/audit?action=DROP%20TABLE")).status).toBe(400);
      expect((await ctx.call(await ctx.login(a.supervisor), "GET", "/admin/audit")).status).toBe(403);
    } finally {
      await ctx.close();
    }
  });
});
