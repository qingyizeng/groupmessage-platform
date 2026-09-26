import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, Queryable } from '../../db/pool';
import { withTx } from '../../db/tx';
import type { Logger } from '../../lib/logger';
import { emitMessageEvent, type MessageRow } from '../messages/outbound';
import { scheduleTask, type Task } from '../tasks/scheduledTasks';

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

export const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXTENSIONS).map(([m, e]) => [e, m]));

const MAX_ATTEMPTS = 5;
/** Files not referenced by any row and older than this are leftovers of interrupted downloads/deletes. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

export interface MediaOptions {
  pool: Pool;
  log: Logger;
  mediaDir: string;
  retentionDays: number;
  cleanupIntervalMs: number;
}

/** Called in the message event transaction when a stored message carries a mediaUrl. */
export async function queueMediaDownload(tx: Queryable, messageId: number): Promise<void> {
  await tx.query(`UPDATE messages SET media_status = 'pending' WHERE id = $1 AND media_status IS NULL`, [messageId]);
  await scheduleTask(tx, 'media_download', String(messageId), null);
}

/**
 * C1. Downloads write the file first and then record it, so a crash leaves at most an
 * unreferenced file. Deletion clears the record first and then removes the file, so no row ever
 * points at a missing file. Periodic cleanup also removes such unreferenced leftovers.
 */
export class MediaService {
  constructor(private readonly opts: MediaOptions) {}

  absolute(relative: string): string {
    const abs = path.resolve(this.opts.mediaDir, relative);
    if (!abs.startsWith(path.resolve(this.opts.mediaDir) + path.sep)) throw new Error('path escapes media dir');
    return abs;
  }

  /** Makes sure the recurring cleanup task exists (without postponing an already scheduled run). */
  async ensureCleanupScheduled(): Promise<void> {
    await this.opts.pool.query(
      `INSERT INTO scheduled_tasks (kind, ref, run_at) VALUES ('media_cleanup', 'global', now() + make_interval(secs => $1))
       ON CONFLICT (kind, ref) DO NOTHING`,
      [this.opts.cleanupIntervalMs / 1000],
    );
  }

  handleDownloadTask = async (task: Task): Promise<void> => {
    const { pool, log, mediaDir } = this.opts;
    const { rows } = await pool.query<MessageRow & { media_status: string | null; media_attempts: number }>(
      'SELECT * FROM messages WHERE id = $1',
      [Number(task.ref)],
    );
    const msg = rows[0];
    if (!msg || msg.media_status !== 'pending' || !msg.media_url) return;

    let res: Response;
    try {
      res = await fetch(msg.media_url, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      return this.retryOrGiveUp(msg.id, msg.media_attempts, `fetch failed: ${String(err)}`);
    }
    if (res.status === 404) {
      await this.setStatus(msg.id, 'expired');
      return;
    }
    if (!res.ok) return this.retryOrGiveUp(msg.id, msg.media_attempts, `HTTP ${res.status}`);

    const bytes = Buffer.from(await res.arrayBuffer());
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    const relative = path.join(msg.group_id, `${msg.id}-${randomBytes(4).toString('hex')}${EXTENSIONS[type] ?? '.bin'}`);
    const target = this.absolute(relative);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
    try {
      const recorded = await withTx(pool, async (tx) => {
        const { rows: updated } = await tx.query<MessageRow>(
          `UPDATE messages SET local_file_path = $2, media_status = 'downloaded', media_downloaded_at = now(), updated_at = now()
            WHERE id = $1 AND media_status = 'pending' RETURNING *`,
          [msg.id, relative],
        );
        if (updated[0] && !updated[0].echo_pending) await emitMessageEvent(tx, updated[0]);
        return updated.length > 0;
      });
      if (!recorded) await unlink(target).catch(() => undefined);
    } catch (err) {
      await unlink(target).catch(() => undefined);
      throw err;
    }
    log.debug({ messageId: msg.id, relative, bytes: bytes.length, mediaDir }, 'media downloaded');
  };

  handleCleanupTask = async (): Promise<void> => {
    try {
      await this.cleanup();
    } finally {
      await withTx(this.opts.pool, (tx) =>
        scheduleTask(tx, 'media_cleanup', 'global', new Date(Date.now() + this.opts.cleanupIntervalMs)),
      );
    }
  };

  /** Deletes expired files (except those of groups with a running agent run) and orphaned files. */
  async cleanup(): Promise<{ deleted: number; orphans: number }> {
    const { pool, retentionDays } = this.opts;
    let deleted = 0;
    for (;;) {
      const paths = await withTx(pool, async (tx) => {
        const { rows } = await tx.query<MessageRow & { old_path: string | null }>(
          `WITH victims AS (
             SELECT m.id, m.local_file_path AS old_path FROM messages m
              WHERE m.media_status = 'downloaded'
                AND m.media_downloaded_at < now() - make_interval(days => $1)
                AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.group_id = m.group_id AND r.status = 'running')
              ORDER BY m.media_downloaded_at LIMIT 200
              FOR UPDATE OF m SKIP LOCKED)
           UPDATE messages SET local_file_path = NULL, media_status = 'deleted', updated_at = now()
             FROM victims WHERE messages.id = victims.id
           RETURNING messages.*, victims.old_path`,
          [retentionDays],
        );
        return rows;
      });
      if (paths.length === 0) break;
      deleted += paths.length;
      for (const r of paths) {
        if (r.old_path) await unlink(this.absolute(r.old_path)).catch(() => undefined);
      }
      await withTx(pool, async (tx) => {
        for (const r of paths) if (!r.echo_pending) await emitMessageEvent(tx, r);
      });
    }
    const orphans = await this.removeOrphans();
    if (deleted || orphans) this.opts.log.info({ deleted, orphans }, 'media cleanup');
    return { deleted, orphans };
  }

  private async removeOrphans(): Promise<number> {
    const files = await listFiles(this.opts.mediaDir);
    let removed = 0;
    for (const abs of files) {
      const info = await stat(abs).catch(() => null);
      if (!info || Date.now() - info.mtimeMs < ORPHAN_AGE_MS) continue;
      const relative = path.relative(this.opts.mediaDir, abs);
      const { rowCount } = await this.opts.pool.query('SELECT 1 FROM messages WHERE local_file_path = $1', [relative]);
      if (rowCount) continue;
      await unlink(abs).catch(() => undefined);
      removed++;
    }
    return removed;
  }

  private async retryOrGiveUp(messageId: number, attempts: number, reason: string): Promise<void> {
    if (attempts + 1 >= MAX_ATTEMPTS) {
      await this.setStatus(messageId, 'failed', attempts + 1);
      this.opts.log.warn({ messageId, reason }, 'giving up media download');
      return;
    }
    await this.opts.pool.query('UPDATE messages SET media_attempts = $2 WHERE id = $1', [messageId, attempts + 1]);
    throw new Error(`media download failed (${reason}); will retry`);
  }

  private async setStatus(messageId: number, status: 'expired' | 'failed', attempts?: number): Promise<void> {
    await withTx(this.opts.pool, async (tx) => {
      const { rows } = await tx.query<MessageRow>(
        `UPDATE messages SET media_status = $2, media_attempts = COALESCE($3, media_attempts), updated_at = now()
          WHERE id = $1 AND media_status = 'pending' RETURNING *`,
        [messageId, status, attempts ?? null],
      );
      if (rows[0] && !rows[0].echo_pending) await emitMessageEvent(tx, rows[0]);
    });
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}
