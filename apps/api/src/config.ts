import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().default("postgres://rede:rede@localhost:5433/rede_neutra"),
  /** Segredo das sessões (JWT). Obrigatório em produção. */
  SESSION_SECRET: z.string().min(32).default("dev-only-secret-troque-em-producao-0000"),
  SESSION_HOURS: z.coerce.number().default(8),
  /**
   * mock = dados de exemplo; wiki = API versionada da SpeedWiki (caminho
   * previsto para produção); real = Codemaps/OLTCloud/Voalle direto (só de
   * servidor liberado por IP, usado para validação).
   */
  INTEGRATIONS_MODE: z.enum(["mock", "wiki", "real"]).default("mock"),
  /** Base da SpeedWiki, sem o /proxy/redeneutra/v1. */
  WIKI_BASE_URL: z.string().url().optional(),
  /** Chave da integração, enviada em X-RedeNeutra-Key. Só no ambiente do servidor. */
  WIKI_API_KEY: z.string().optional(),
  /**
   * Liberação de ONU (ESCRITA em produção). off = desligada (padrão); mock = Wiki de mentira;
   * wiki = rotas /proxy/redeneutra/v2 da SpeedWiki, só com validação do Juan.
   */
  ACTIVATION_MODE: z.enum(["off", "mock", "wiki"]).default("off"),
  /**
   * Automações do cliente final: bloquear, desbloquear, reiniciar e cancelar (ESCRITA em produção).
   * off = desligadas (padrão); mock = Wiki de mentira; wiki = rotas /proxy/redeneutra/v3, só com validação do Juan.
   */
  AUTOMATION_MODE: z.enum(["off", "mock", "wiki"]).default("off"),
  /** Chave de escrita da Wiki (X-RedeNeutra-Write-Key), separada da de leitura. */
  WIKI_WRITE_KEY: z.string().optional(),
  /** Pasta das fotos de campo. Em produção é um volume do Docker (entra no backup). */
  PHOTO_DIR: z.string().default("./data/photos"),
  PHOTO_MAX_MB: z.coerce.number().default(8),
  /** Base pública do portal (https://...), para montar o link assinado completo das fotos. Sem ela, o link sai só com o caminho. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /**
   * Segundo fator (TOTP) obrigatório para supervisor e administrador Speed. Padrão: ligado em
   * produção, desligado em desenvolvimento e testes. "true"/"false" força o valor.
   */
  MFA_REQUIRED: z.enum(["true", "false"]).optional(),
  /** Chave que cifra os segredos TOTP no banco. Sem ela, deriva do SESSION_SECRET (trocá-lo invalidaria todos os segundos fatores). */
  TOTP_KEY: z.string().min(16).optional(),
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
