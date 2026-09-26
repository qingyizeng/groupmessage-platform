import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ErrorCode } from '@gmp/shared';
import type { AppContext } from '../../context';
import { MIME_BY_EXT } from '../../domain/media/mediaService';
import { notFound } from '../errors';

export const mediaRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/messages/:id/media', async (req, reply) => {
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
      const { rows } = await ctx.pool.query<{ local_file_path: string | null }>(
        `SELECT local_file_path FROM messages WHERE id = $1 AND media_status = 'downloaded'`,
        [id],
      );
      const relative = rows[0]?.local_file_path;
      const unavailable = () => notFound(ErrorCode.MEDIA_NOT_AVAILABLE, `No local media for message ${id}`);
      if (!relative) throw unavailable();
      const file = ctx.media.absolute(relative);
      await access(file).catch(() => {
        throw unavailable();
      });
      reply.type(MIME_BY_EXT[path.extname(file)] ?? 'application/octet-stream');
      return reply.send(createReadStream(file));
    });
  };
