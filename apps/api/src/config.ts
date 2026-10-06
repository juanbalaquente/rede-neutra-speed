import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().default("postgres://rede:rede@localhost:5433/rede_neutra"),
  /** Segredo das sessões (JWT). Obrigatório em produção. */
  SESSION_SECRET: z.string().min(32).default("dev-only-secret-troque-em-producao-0000"),
  SESSION_HOURS: z.coerce.number().default(8),
  /** mock = dados de exemplo; real = Codemaps/OLTCloud/Voalle de verdade. */
  INTEGRATIONS_MODE: z.enum(["mock", "real"]).default("mock"),
  RESERVATION_HOURS: z.coerce.number().default(48),
  CODEMAPS_TOKEN: z.string().optional(),
  CODEMAPS_SECRET: z.string().optional(),
  OLTCLOUD_BASE: z.string().default("https://speedfibra.oltcloud.co"),
  OLTCLOUD_USER: z.string().optional(),
  OLTCLOUD_PASS: z.string().optional(),
  VOALLE_ERP_URL: z.string().optional(),
  VOALLE_CLIENT_ID: z.string().optional(),
  VOALLE_CLIENT_SECRET: z.string().optional(),
  VOALLE_SYNDATA: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Variável vazia no .env (ex.: "SESSION_SECRET=") vale como não definida.
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const config = envSchema.parse(defined);
  if (config.NODE_ENV === "production" && config.SESSION_SECRET.startsWith("dev-only")) {
    throw new Error("SESSION_SECRET precisa ser definido em produção");
  }
  return config;
}
