import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ErrorCode } from '@gmp/shared';
import type { AppContext } from '../../context';
import { findGroup } from '../../domain/groups/groupRepo';
import { toRunDto, type RunRow, type StepRow } from '../../domain/agent/runRepo';
import { notFound } from '../errors';

const UUID = /^[0-9a-f-]{36}$/i;
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

export const agentRunRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/agent-runs/:id', async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      if (!UUID.test(id)) throw notFound(ErrorCode.AGENT_RUN_NOT_FOUND, `Agent run ${id} not found`);
      const { rows } = await ctx.pool.query<RunRow>('SELECT * FROM agent_runs WHERE id = $1', [id]);
      if (!rows[0]) throw notFound(ErrorCode.AGENT_RUN_NOT_FOUND, `Agent run ${id} not found`);
      const { rows: steps } = await ctx.pool.query<StepRow>(
        'SELECT * FROM agent_run_steps WHERE run_id = $1 ORDER BY seq',
        [id],
      );
      return toRunDto(rows[0], steps);
    });

    app.get('/groups/:id/agent-runs', async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { limit } = listQuery.parse(req.query);
      const group = await findGroup(ctx.pool, id);
      if (!group) throw notFound(ErrorCode.GROUP_NOT_FOUND, `Group ${id} not found`);
      const { rows } = await ctx.pool.query<RunRow>(
        'SELECT * FROM agent_runs WHERE group_id = $1 ORDER BY created_at DESC, id LIMIT $2',
        [group.id, limit],
      );
      return rows.map((r) => toRunDto(r));
    });
  };
