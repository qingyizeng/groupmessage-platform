import type { FastifyPluginAsync } from 'fastify';
import type { HealthResponse } from '@gmp/shared';
import type { AppContext } from '../app';

export const healthRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/health', async (_req, reply): Promise<HealthResponse> => {
      const ok = await ctx.pool.query('SELECT 1').then(
        () => true,
        () => false,
      );
      if (!ok) reply.status(503);
      return { ok, schemaVersion: ctx.schemaVersion };
    });
  };
