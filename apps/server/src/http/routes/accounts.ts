import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ACCOUNT_STATUSES } from '@gmp/shared';
import type { AppContext } from '../../context';

const params = z.object({ id: z.string().min(1) });
const status = z.enum(ACCOUNT_STATUSES);
const transitionBody = z.object({ to: status, expectedFrom: status });

export const accountRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/', async () => ctx.accounts.list());

    app.post('/:id/connect', async (req) => {
      const { id } = params.parse(req.params);
      return ctx.accounts.connect(id);
    });

    app.post('/:id/transition', async (req) => {
      const { id } = params.parse(req.params);
      const { to, expectedFrom } = transitionBody.parse(req.body ?? {});
      const result = await ctx.accounts.operatorTransition(id, to, expectedFrom);
      return { status: result.status };
    });
  };
