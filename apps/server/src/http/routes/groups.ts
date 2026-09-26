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
const createBody = z
  .object({
    creatorAccountId: z.string().min(1),
    memberAccountIds: z.array(z.string().min(1)).min(1, 'memberAccountIds needs at least one account'),
  })
  .refine((b) => !b.memberAccountIds.includes(b.creatorAccountId), {
    message: 'memberAccountIds must not contain the creator',
    path: ['memberAccountIds'],
  })
  .refine((b) => new Set(b.memberAccountIds).size === b.memberAccountIds.length, {
    message: 'memberAccountIds must not contain duplicates',
    path: ['memberAccountIds'],
  });
const patchBody = z
  .object({ agentEnabled: z.boolean().optional(), autoKickEnabled: z.boolean().optional() })
  .strict()
  .refine((b) => b.agentEnabled !== undefined || b.autoKickEnabled !== undefined, {
    message: 'Provide agentEnabled and/or autoKickEnabled',
  });

export const groupRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/', async () => ctx.groups.list());

    app.post('/', async (req, reply) => {
      const { creatorAccountId, memberAccountIds } = createBody.parse(req.body ?? {});
      const jobId = await ctx.groups.requestCreate(creatorAccountId, memberAccountIds);
      return reply.status(202).send({ jobId });
    });

    app.get('/:id', async (req) => {
      const { id } = params.parse(req.params);
      return ctx.groups.get(id);
    });

    app.patch('/:id', async (req) => {
      const { id } = params.parse(req.params);
      return ctx.groups.patch(id, patchBody.parse(req.body ?? {}));
    });

    app.post('/:id/leave-all', async (req, reply) => {
      const { id } = params.parse(req.params);
      const jobId = await ctx.groups.requestLeaveAll(id);
      return reply.status(202).send({ jobId });
    });

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
