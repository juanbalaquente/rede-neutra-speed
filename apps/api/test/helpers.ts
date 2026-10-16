import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { partners, plans, users } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { hashPassword } from "../src/auth/password.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { MemoryPhotoStorage } from "../src/storage/photos.js";
import type { ActivationService, CustomerActions, NetworkMap, TicketService, ClientStatusService, ContractService } from "../src/integrations/types.js";
import { seed } from "../src/scripts/seed.js";

export const PASSWORD = "senha12345a";

export async function setup(network: NetworkMap = new MockNetworkMap(), activation?: ActivationService, env: Record<string, string> = {}, actions?: CustomerActions, tickets?: TicketService, clientStatus?: ClientStatusService, contracts?: ContractService) {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  await seed(db, { adminEmail: "admin@speed.test", adminPassword: PASSWORD, demo: false });

  const config = loadConfig({ NODE_ENV: "test", ...env });
  const photoStorage = new MemoryPhotoStorage();
  const app = createApp({ db, config, integrations: { network, activation, actions, tickets, clientStatus, contracts }, photoStorage });

  async function login(email: string): Promise<string> {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
    const cookie = res.headers.get("set-cookie") ?? "";
    return cookie.split(";")[0]!;
  }

  function call(cookie: string | null, method: string, path: string, body?: unknown) {
    return app.request(`/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Menor JPEG válido para o servidor (só os bytes de abertura importam para a checagem de formato). */
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

  function upload(cookie: string | null, reservationId: string, fields: Record<string, string> = {}, bytes: Uint8Array = JPEG, name = "foto.jpg") {
    const form = new FormData();
    form.set("kind", "medicao");
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set("file", new File([new Uint8Array(bytes)], name, { type: "image/jpeg" }));
    return app.request(`/api/reservations/${reservationId}/photos`, { method: "POST", headers: cookie ? { Cookie: cookie } : {}, body: form });
  }

  /** Plano, visita e técnico da reserva: exigidos antes de liberar a ONU. */
  async function setCliente(cookie: string, reservationId: string, overrides: Record<string, unknown> = {}) {
    const [plan] = await db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.speedMbps);
    return call(cookie, "PATCH", `/reservations/${reservationId}/cliente`, {
      planId: plan!.id,
      visitAt: "2026-10-20T10:00:00-03:00",
      technician: "Carlos Técnico",
      nickname: "Casa do Zé",
      ...overrides,
    });
  }

  async function createPartner(name: string, cnpj: string, extra: Partial<typeof partners.$inferInsert> = {}) {
    const [p] = await db.insert(partners).values({ name, cnpj, allowedRegions: ["ITA"], ...extra }).returning();
    const hash = await hashPassword(PASSWORD);
    const slug = cnpj.slice(0, 4);
    await db.insert(users).values([
      { partnerId: p!.id, email: `sup${slug}@parceiro.test`, name: `Sup ${name}`, role: "supervisor", passwordHash: hash },
      { partnerId: p!.id, email: `ate${slug}@parceiro.test`, name: `Ate ${name}`, role: "atendente", passwordHash: hash },
    ]);
    return { partner: p!, supervisor: `sup${slug}@parceiro.test`, atendente: `ate${slug}@parceiro.test` };
  }

  return { db, app, login, call, upload, setCliente, JPEG, photoStorage, createPartner, close: () => client.close() };
}
