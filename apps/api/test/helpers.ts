import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { partners, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import type { NetworkMap } from "../src/integrations/types.js";
import { seed } from "../src/scripts/seed.js";

export const PASSWORD = "senha12345a";

export async function setup(network: NetworkMap = new MockNetworkMap()) {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  await seed(db, { adminEmail: "admin@speed.test", adminPassword: PASSWORD, demo: false });

  const config = loadConfig({ NODE_ENV: "test" });
  const app = createApp({ db, config, integrations: { network } });

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

  async function createPartner(name: string, cnpj: string, extra: Partial<typeof partners.$inferInsert> = {}) {
    const [p] = await db.insert(partners).values({ name, cnpj, ...extra }).returning();
    const hash = await hashPassword(PASSWORD);
    const slug = cnpj.slice(0, 4);
    await db.insert(users).values([
      { partnerId: p!.id, email: `sup${slug}@parceiro.test`, name: `Sup ${name}`, role: "supervisor", passwordHash: hash },
      { partnerId: p!.id, email: `ate${slug}@parceiro.test`, name: `Ate ${name}`, role: "atendente", passwordHash: hash },
    ]);
    return { partner: p!, supervisor: `sup${slug}@parceiro.test`, atendente: `ate${slug}@parceiro.test` };
  }

  return { db, app, login, call, createPartner, close: () => client.close() };
}
