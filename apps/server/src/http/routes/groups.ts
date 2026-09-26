import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';

const params = z.object({ id: z.string().min(1) });
const sendBody = z.object({
  accountId: z.string().min(1),
  text: z.string().trim().min(1).max(4000),
});
const timelineQuery = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const groupRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.post('/:id/send', async (req, reply) => {
      const { id } = params.parse(req.params);
      const { accountId, text } = sendBody.parse(req.body ?? {});
      const result = await ctx.messages.operatorSend(id, accountId, text);
      return reply.status(202).send(result);
    });

    app.get('/:id/messages', async (req) => {
      const { id } = params.parse(req.params);
      const { before, limit } = timelineQuery.parse(req.query);
      return ctx.messages.timeline(id, before, limit);
    });
  };
