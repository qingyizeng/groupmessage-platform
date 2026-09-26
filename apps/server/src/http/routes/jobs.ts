import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ErrorCode } from '@gmp/shared';
import type { AppContext } from '../../context';
import { toIso } from '../../lib/time';
import { notFound } from '../errors';

const params = z.object({ jobId: z.string().min(1) });

export const jobRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/:jobId', async (req) => {
      const { jobId } = params.parse(req.params);
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw notFound(ErrorCode.JOB_NOT_FOUND, `Job ${jobId} not found`);
      const { rows } = await ctx.pool.query<{
        id: string;
        type: string;
        status: string;
        group_id: string | null;
        errors: { step: string; code: string }[];
        created_at: Date;
        updated_at: Date;
      }>('SELECT id, type, status, group_id, errors, created_at, updated_at FROM jobs WHERE id = $1', [jobId]);
      const job = rows[0];
      if (!job) throw notFound(ErrorCode.JOB_NOT_FOUND, `Job ${jobId} not found`);
      return {
        id: job.id,
        type: job.type,
        status: job.status,
        groupId: job.group_id,
        errors: job.errors,
        createdAt: toIso(job.created_at),
        updatedAt: toIso(job.updated_at),
      };
    });
  };
