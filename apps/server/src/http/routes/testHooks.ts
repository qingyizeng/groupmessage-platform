import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { failpoints } from '../../lib/failpoints';

const armBody = z.object({ name: z.string().min(1), times: z.number().int().min(-1).default(1) });

/** Failure injection for demos and black-box tests. Only mounted when ENABLE_TEST_HOOKS=true. */
export const testHookRoutes = (): FastifyPluginAsync => async (app) => {
  app.post('/failpoints', async (req) => {
    const { name, times } = armBody.parse(req.body ?? {});
    failpoints.arm(name, times);
    return { ok: true };
  });

  app.delete('/failpoints', async () => {
    failpoints.clear();
    return { ok: true };
  });
};
