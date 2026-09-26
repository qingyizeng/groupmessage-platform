import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { AppContext } from '../context';
import type { AuthContext } from '../domain/auth/authService';
import { registerErrorHandling } from './errors';
import { registerAuthGuard } from './authGuard';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { accountRoutes } from './routes/accounts';
import { groupRoutes } from './routes/groups';
import { jobRoutes } from './routes/jobs';
import { agentRunRoutes } from './routes/agentRuns';
import { sequenceRoutes } from './routes/sequences';
import { testHookRoutes } from './routes/testHooks';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    },
  });

  app.decorateRequest('auth', undefined);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(cookie);
  const webDist = ctx.config.WEB_DIST ?? DEFAULT_WEB_DIST;
  const serveWeb = existsSync(path.join(webDist, 'index.html'));
  if (serveWeb) await app.register(fastifyStatic, { root: webDist, wildcard: false });
  registerErrorHandling(app, { spaFallback: serveWeb });
  registerAuthGuard(app, ctx.auth);

  await app.register(healthRoutes(ctx), { prefix: '/api' });
  await app.register(authRoutes(ctx), { prefix: '/api/auth' });
  await app.register(accountRoutes(ctx), { prefix: '/api/accounts' });
  await app.register(groupRoutes(ctx), { prefix: '/api/groups' });
  await app.register(jobRoutes(ctx), { prefix: '/api/jobs' });
  await app.register(agentRunRoutes(ctx), { prefix: '/api' });
  await app.register(sequenceRoutes(ctx), { prefix: '/api' });
  if (ctx.config.ENABLE_TEST_HOOKS) await app.register(testHookRoutes(), { prefix: '/api/_test' });

  return app;
}
