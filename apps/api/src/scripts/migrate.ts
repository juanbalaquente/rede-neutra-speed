import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";

const config = loadConfig();
const { db, close } = createDb(config.DATABASE_URL);
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
await migrate(db as any, { migrationsFolder });
console.log("Migrations aplicadas.");
await close();
