import type { ToolDefinition } from './tools';

export type TurnOutcome =
  | { kind: 'response'; status: number; raw: string }
  | { kind: 'timeout' }
  | { kind: 'unreachable'; message: string };

export type AuditOutcome = 'pass' | 'fail' | 'unclear';

export class AgentClient {
  constructor(readonly baseUrl: string) {}

  async turn(body: { runId: string; tools: ToolDefinition[]; messages: unknown[] }, timeoutMs: number): Promise<TurnOutcome> {
    try {
      const res = await fetch(`${this.baseUrl}/agent/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
      return { kind: 'response', status: res.status, raw: await res.text() };
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout' };
      return { kind: 'unreachable', message: String((err as Error).message ?? err) };
    }
  }

  /** Only a 200 with a JSON body whose verdict is exactly "pass" or "fail" is a clear answer. */
  async audit(text: string, groupId: string, timeoutMs: number): Promise<{ outcome: AuditOutcome; detail: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/agent/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, groupId }),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
      const raw = await res.text();
      if (res.status !== 200) return { outcome: 'unclear', detail: `HTTP ${res.status}` };
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return { outcome: 'unclear', detail: 'body is not JSON' };
      }
      const verdict = (body as { verdict?: unknown } | null)?.verdict;
      const reason = String((body as { reason?: unknown }).reason ?? '');
      if (verdict === 'pass') return { outcome: 'pass', detail: reason };
      if (verdict === 'fail') return { outcome: 'fail', detail: reason };
      return { outcome: 'unclear', detail: `unexpected verdict ${JSON.stringify(verdict)}` };
    } catch (err) {
      const name = (err as Error).name;
      return { outcome: 'unclear', detail: name === 'TimeoutError' ? 'timeout' : String((err as Error).message ?? err) };
    }
  }
}
