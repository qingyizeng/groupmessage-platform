import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import type { Config } from '../config';
import type { Pool } from '../db/pool';
import type { Clock } from '../lib/clock';
import { AuthService, type AuthContext } from '../domain/auth/authService';
import { registerErrorHandling } from './errors';
import { registerAuthGuard } from './authGuard';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface AppDeps {
  config: Config;
  pool: Pool;
  clock: Clock;
  schemaVersion: number;
  logger?: FastifyServerOptions['logger'];
}

export interface AppContext extends AppDeps {
  auth: AuthService;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: deps.logger ?? false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    },
  });

  const ctx: AppContext = {
    ...deps,
    auth: new AuthService(deps.pool, deps.clock, {
      jwtSecret: deps.config.JWT_SECRET,
      accessTtlSeconds: deps.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlSeconds: deps.config.REFRESH_TOKEN_TTL_SECONDS,
    }),
  };

  app.decorateRequest('auth', undefined);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(cookie);
  registerErrorHandling(app);
  registerAuthGuard(app, ctx.auth);

  await app.register(healthRoutes(ctx), { prefix: '/api' });
  await app.register(authRoutes(ctx), { prefix: '/api/auth' });

  return { app, ctx };
}
