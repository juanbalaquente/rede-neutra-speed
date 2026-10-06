import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/** Tipo comum ao driver de produção (postgres-js) e ao de teste (PGlite). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, close: () => client.end() };
}
