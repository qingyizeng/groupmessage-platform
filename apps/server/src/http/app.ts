import { randomUUID } from 'node:crypto';
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
import { testHookRoutes } from './routes/testHooks';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

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
  registerErrorHandling(app);
  registerAuthGuard(app, ctx.auth);

  await app.register(healthRoutes(ctx), { prefix: '/api' });
  await app.register(authRoutes(ctx), { prefix: '/api/auth' });
  await app.register(accountRoutes(ctx), { prefix: '/api/accounts' });
  await app.register(groupRoutes(ctx), { prefix: '/api/groups' });
  if (ctx.config.ENABLE_TEST_HOOKS) await app.register(testHookRoutes(), { prefix: '/api/_test' });

  return app;
}
