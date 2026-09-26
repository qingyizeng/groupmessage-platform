import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ErrorCode, validateSequence, type SequenceDef } from '@gmp/shared';
import type { AppContext } from '../../context';
import { findGroup } from '../../domain/groups/groupRepo';
import { listSequenceRuns, loadSequenceRun, startSequenceRun } from '../../domain/sequences/sequenceEngine';
import { toIso } from '../../lib/time';
import { AppError, conflict, notFound } from '../errors';

const UUID = /^[0-9a-f-]{36}$/i;
const idParam = z.object({ id: z.string() });
const startBody = z.object({
  sequenceId: z.string().min(1),
  vars: z.record(z.string()).default({}),
  stepVars: z.record(z.string().regex(/^\d+$/, 'stepVars keys are step indexes'), z.record(z.string())).default({}),
});
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

interface SequenceRow {
  id: string;
  name: string;
  steps: SequenceDef['steps'];
  created_at: Date;
}

const toSequenceDto = (r: SequenceRow) => ({ id: r.id, name: r.name, steps: r.steps, createdAt: toIso(r.created_at) });

export const sequenceRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const findSequence = async (id: string) => {
      if (!UUID.test(id)) return undefined;
      const { rows } = await ctx.pool.query<SequenceRow>('SELECT * FROM sequences WHERE id = $1', [id]);
      return rows[0];
    };

    app.post('/sequences', async (req, reply) => {
      const errors = validateSequence(req.body);
      if (errors.length) throw new AppError(400, ErrorCode.VALIDATION_ERROR, errors.join('; '), { errors });
      const def = req.body as SequenceDef;
      const steps = def.steps.map(({ index, accountRole, text, delaySeconds }) => ({ index, accountRole, text, delaySeconds }));
      const { rows } = await ctx.pool.query<{ id: string }>(
        'INSERT INTO sequences (name, steps) VALUES ($1, $2) RETURNING id',
        [def.name.trim(), JSON.stringify(steps)],
      );
      return reply.status(201).send({ id: rows[0]!.id });
    });

    app.get('/sequences', async () => {
      const { rows } = await ctx.pool.query<SequenceRow>('SELECT * FROM sequences ORDER BY created_at DESC, id');
      return rows.map(toSequenceDto);
    });

    app.get('/sequences/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const seq = await findSequence(id);
      if (!seq) throw notFound(ErrorCode.SEQUENCE_NOT_FOUND, `Sequence ${id} not found`);
      return toSequenceDto(seq);
    });

    app.post('/groups/:id/sequence-runs', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const body = startBody.parse(req.body ?? {});
      const group = await findGroup(ctx.pool, id);
      if (!group) throw notFound(ErrorCode.GROUP_NOT_FOUND, `Group ${id} not found`);
      const seq = await findSequence(body.sequenceId);
      if (!seq) throw notFound(ErrorCode.SEQUENCE_NOT_FOUND, `Sequence ${body.sequenceId} not found`);
      if (group.status === 'unreachable') throw conflict(ErrorCode.GROUP_UNREACHABLE, 'Group is not writable');
      if (group.status === 'left') throw conflict(ErrorCode.GROUP_LEFT, 'All service accounts left this group');

      const result = await startSequenceRun(ctx.pool, {
        groupId: group.id,
        sequenceId: seq.id,
        steps: seq.steps,
        vars: body.vars,
        stepVars: body.stepVars,
      });
      if (result.ok) return reply.status(201).send({ runId: result.runId });
      if (result.reason === 'already_running') {
        throw conflict(ErrorCode.SEQUENCE_ALREADY_RUNNING, 'A sequence is already running in this group');
      }
      throw new AppError(
        422,
        ErrorCode.UNRESOLVED_PLACEHOLDER,
        `Step ${result.stepIndex}: placeholder {${result.key}} has no value`,
        { stepIndex: result.stepIndex, key: result.key },
      );
    });

    app.get('/sequence-runs/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const run = UUID.test(id) ? await loadSequenceRun(ctx.pool, id, true) : null;
      if (!run) throw notFound(ErrorCode.SEQUENCE_RUN_NOT_FOUND, `Sequence run ${id} not found`);
      return run;
    });

    app.get('/groups/:id/sequence-runs', async (req) => {
      const { id } = idParam.parse(req.params);
      const { limit } = listQuery.parse(req.query);
      const group = await findGroup(ctx.pool, id);
      if (!group) throw notFound(ErrorCode.GROUP_NOT_FOUND, `Group ${id} not found`);
      return listSequenceRuns(ctx.pool, group.id, limit);
    });
  };
