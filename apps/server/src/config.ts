import os from 'node:os';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().nonnegative().default(3000),
  DATABASE_URL: z.string().min(1),
  GATEWAY_URL: z.string().url().default('http://localhost:4001'),
  AGENT_URL: z.string().url().default('http://localhost:4002'),
  JWT_SECRET: z.string().min(16).default('dev-secret-change-me-at-least-32-bytes'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  INSTANCE_ID: z.string().optional(),
  /** Where downloaded media is stored (defaults to <repo>/media). */
  MEDIA_DIR: z.string().optional(),
  MEDIA_RETENTION_DAYS: z.coerce.number().positive().default(30),
  MEDIA_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  /** Built console to serve (defaults to apps/web/dist when it exists). */
  WEB_DIST: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  LOG_LEVEL: z.string().default('info'),
  GATEWAY_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  JOIN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  AGENT_TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  AGENT_RUN_WALL_MS: z.coerce.number().int().positive().default(60_000),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(12),
  AGENT_AUDIT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  AGENT_SEND_WAIT_MS: z.coerce.number().int().positive().default(5_000),
  ENABLE_TEST_HOOKS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema> & { INSTANCE_ID: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const cfg = parsed.data;
  return { ...cfg, INSTANCE_ID: cfg.INSTANCE_ID ?? `${os.hostname()}:${cfg.PORT}` };
}
