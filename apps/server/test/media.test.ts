import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestRuntime, login, waitFor, type TestRuntime } from './helpers/app';
import { Scenario } from './helpers/scenario';

describe('media files (C1)', () => {
  let t: TestRuntime;
  let s: Scenario;
  const mediaDir = mkdtempSync(path.join(os.tmpdir(), 'gmp-media-'));

  beforeAll(async () => {
    t = await createTestRuntime({ env: { MEDIA_DIR: mediaDir, MEDIA_RETENTION_DAYS: '30' } });
    s = await new Scenario(t).init();
  });
  afterAll(async () => {
    await t.close();
  });

  const withMedia = (gg: string, text: string, content: string, ttlMs = 3_600_000) =>
    s.gw('POST', `/_control/groups/${gg}/external-message`, {
      platformUserId: 'pu_sender',
      text,
      media: { contentType: 'text/plain', base64: Buffer.from(content).toString('base64'), ttlMs },
    });
  const row = async (text: string) =>
    (
      await t.db.pool.query<{ id: number; media_status: string | null; local_file_path: string | null }>(
        'SELECT id, media_status, local_file_path FROM messages WHERE text = $1',
        [text],
      )
    ).rows[0];
  const waitStatus = (text: string, status: string) =>
    waitFor(async () => {
      const r = await row(text);
      return r?.media_status === status ? r : null;
    }, { timeout: 8000, message: `${text} media ${status}` });

  it('downloads media to the media dir and records the path; the API serves it', async () => {
    const g = await s.group('acc_01', ['acc_02']);
    await withMedia(g.gatewayGroupId, 'with file', 'hello media');
    const r = await waitStatus('with file', 'downloaded');
    const file = path.join(mediaDir, r.local_file_path!);
    expect(file.endsWith('.txt')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('hello media');

    const viewer = (await login(t.app, 'viewer')).accessToken;
    const res = await s.api('GET', `/api/messages/${r.id}/media`, undefined, viewer);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('hello media');
    const { items } = (await s.api('GET', `/api/groups/${g.groupId}/messages`)).json();
    expect(items.find((m: any) => m.id === r.id)).toMatchObject({ mediaStatus: 'downloaded' });
  });

  it('expired media (404) is marked expired without retries', async () => {
    const g = await s.group('acc_03', ['acc_04']);
    await withMedia(g.gatewayGroupId, 'too late', 'x', -1);
    const r = await waitStatus('too late', 'expired');
    expect(r.local_file_path).toBeNull();
    expect((await s.api('GET', `/api/messages/${r.id}/media`)).json().error.code).toBe('MEDIA_NOT_AVAILABLE');
  });

  it('retries while the media endpoint is unavailable', async () => {
    const g = await s.group('acc_05', ['acc_06']);
    await s.fault({ endpoint: 'media', times: 2, action: { type: 'error', status: 503, code: 'UNAVAILABLE' } });
    await withMedia(g.gatewayGroupId, 'flaky', 'eventually');
    const r = await waitStatus('flaky', 'downloaded');
    expect(readFileSync(path.join(mediaDir, r.local_file_path!), 'utf8')).toBe('eventually');
    await s.clearFaults();
  });

  it('cleanup deletes files older than the retention; the record is cleared first', async () => {
    const g = await s.group('acc_07', ['acc_08']);
    await withMedia(g.gatewayGroupId, 'old file', 'bye');
    const r = await waitStatus('old file', 'downloaded');
    const file = path.join(mediaDir, r.local_file_path!);
    await t.db.pool.query(`UPDATE messages SET media_downloaded_at = now() - interval '31 days' WHERE id = $1`, [r.id]);
    const result = await t.ctx.media.cleanup();
    expect(result.deleted).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(await row('old file')).toMatchObject({ media_status: 'deleted', local_file_path: null });
    expect((await s.api('GET', `/api/messages/${r.id}/media`)).statusCode).toBe(404);
  });

  it('files of a group with a running agent run are kept until the run ends', async () => {
    const g = await s.group('acc_01', ['acc_03']);
    await withMedia(g.gatewayGroupId, 'in use', 'keep me');
    const r = await waitStatus('in use', 'downloaded');
    await t.db.pool.query(`UPDATE messages SET media_downloaded_at = now() - interval '40 days' WHERE id = $1`, [r.id]);
    await s.enableAgent(g.groupId);
    s.script(g.groupId, [{ delayMs: 1500, toolUse: { name: 'finish', input: { summary: 'slow' } } }]);
    await s.external(g.gatewayGroupId, 'pu_x', 'start a run');
    await waitFor(async () => (await s.runs(g.groupId)).some((run) => run.status === 'running'));
    await t.ctx.media.cleanup();
    expect(existsSync(path.join(mediaDir, r.local_file_path!))).toBe(true);
    await s.settledRuns(g.groupId);
    await t.ctx.media.cleanup();
    expect(existsSync(path.join(mediaDir, r.local_file_path!))).toBe(false);
  });

  it('removes old files that no record points to, keeps referenced ones', async () => {
    const g = await s.group('acc_02', ['acc_04']);
    await withMedia(g.gatewayGroupId, 'referenced', 'mine');
    const r = await waitStatus('referenced', 'downloaded');
    const kept = path.join(mediaDir, r.local_file_path!);
    mkdirSync(path.join(mediaDir, 'stray'), { recursive: true });
    const orphan = path.join(mediaDir, 'stray', 'leftover.bin');
    writeFileSync(orphan, 'x');
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(orphan, old, old);
    utimesSync(kept, old, old);
    const result = await t.ctx.media.cleanup();
    expect(result.orphans).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });
});
