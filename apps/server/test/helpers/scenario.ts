import type { FaultRule } from '@gmp/mock-gateway';
import type { AuditStep, TurnStep } from '@gmp/mock-agent';
import { platformUserIdFor } from '@gmp/mock-gateway';
import { login, waitFor, type TestRuntime } from './app';

/** Convenience wrapper around a TestRuntime for scenario tests. */
export class Scenario {
  token = '';

  constructor(readonly t: TestRuntime) {}

  async init() {
    this.token = (await login(this.t.app, 'admin')).accessToken;
    return this;
  }

  api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, token = this.token) {
    return this.t.app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  }

  async gw<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.t.gwUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  fault(rule: FaultRule) {
    return this.gw('POST', '/_control/faults', rule);
  }

  clearFaults() {
    return this.gw('DELETE', '/_control/faults');
  }

  async connect(...accountIds: string[]) {
    for (const id of accountIds) {
      const res = await this.api('POST', `/api/accounts/${id}/connect`);
      if (res.statusCode !== 200 && res.json().error?.code !== 'ILLEGAL_TRANSITION') {
        throw new Error(`connect ${id} failed: ${res.body}`);
      }
    }
  }

  /**
   * Creates a group directly in the gateway and our database (bypassing the group-creation job),
   * joins the members and waits until their member_joined events were processed.
   */
  async group(creator: string, members: string[]): Promise<{ groupId: string; gatewayGroupId: string }> {
    await this.connect(creator, ...members);
    const { groupId: gatewayGroupId } = await this.gw<{ groupId: string }>('POST', '/groups', { creatorAccountId: creator });
    const { rows } = await this.t.db.pool.query<{ id: string }>(
      'INSERT INTO groups (gateway_group_id, creator_account_id) VALUES ($1, $2) RETURNING id',
      [gatewayGroupId, creator],
    );
    const groupId = rows[0]!.id;
    await this.t.db.pool.query(
      `INSERT INTO group_members (group_id, platform_user_id, account_id, role, present) VALUES ($1, $2, $3, 'creator', true)`,
      [groupId, platformUserIdFor(creator), creator],
    );
    const { inviteLink } = await this.gw<{ inviteLink: string }>('POST', `/groups/${gatewayGroupId}/invite`);
    for (const m of members) await this.gw('POST', `/groups/${gatewayGroupId}/join`, { accountId: m, inviteLink });
    await waitFor(
      async () =>
        (
          await this.t.db.pool.query(
            'SELECT 1 FROM group_members WHERE group_id = $1 AND present AND account_id = ANY($2)',
            [groupId, members],
          )
        ).rowCount === members.length,
      { message: 'members joined' },
    );
    return { groupId, gatewayGroupId };
  }

  external(gatewayGroupId: string, platformUserId: string, text: string) {
    return this.gw('POST', `/_control/groups/${gatewayGroupId}/external-message`, { platformUserId, text });
  }

  async send(groupId: string, accountId: string, text: string): Promise<string> {
    const res = await this.api('POST', `/api/groups/${groupId}/send`, { accountId, text });
    if (res.statusCode !== 202) throw new Error(`send failed: ${res.statusCode} ${res.body}`);
    return res.json().clientMsgId;
  }

  async message(clientMsgId: string) {
    const { rows } = await this.t.db.pool.query(
      'SELECT id, phase, delivery_status, fail_code, attempt, msg_id, sent_at, sort_ts FROM messages WHERE client_msg_id = $1',
      [clientMsgId],
    );
    return rows[0] as {
      id: number;
      phase: string;
      delivery_status: string;
      fail_code: string | null;
      attempt: number;
      msg_id: string | null;
      sent_at: Date | null;
      sort_ts: Date;
    };
  }

  waitStatus(clientMsgId: string, status: string | string[], timeout = 8_000) {
    const wanted = Array.isArray(status) ? status : [status];
    return waitFor(
      async () => {
        const m = await this.message(clientMsgId);
        return m && wanted.includes(m.delivery_status) ? m : null;
      },
      { timeout, message: `message ${clientMsgId} to become ${wanted.join('|')}` },
    );
  }

  /** Gateway-side view: send calls and landed messages for a clientMsgId. */
  gatewayView(clientMsgId: string) {
    const state = this.t.gw.state;
    const calls = state.calls.filter((c) => c.endpoint === 'send' && (c.body as any)?.clientMsgId === clientMsgId);
    const landed = [...state.groups.values()].flatMap((g) => g.messages.filter((m) => m.clientMsgId === clientMsgId));
    return { calls, landed };
  }

  async enableAgent(groupId: string, autoKickEnabled = false) {
    const res = await this.api('PATCH', `/api/groups/${groupId}`, { agentEnabled: true, autoKickEnabled });
    if (res.statusCode !== 200) throw new Error(`enable agent failed: ${res.body}`);
  }

  /** Queues scripted turns for the next agent run of the group. */
  script(groupId: string, turns: TurnStep[]) {
    this.t.agent.state.scripts.push({ groupId, turns, next: 0 });
  }

  audits(steps: AuditStep[], groupId = '*') {
    this.t.agent.state.audits.set(groupId, [...(this.t.agent.state.audits.get(groupId) ?? []), ...steps]);
  }

  async runs(groupId: string): Promise<any[]> {
    return (await this.api('GET', `/api/groups/${groupId}/agent-runs?limit=100`)).json();
  }

  async run(runId: string): Promise<any> {
    return (await this.api('GET', `/api/agent-runs/${runId}`)).json();
  }

  /** Waits until the group has `count` runs and none is running; returns them oldest first. */
  async settledRuns(groupId: string, count = 1, timeout = 10_000): Promise<any[]> {
    const runs = await waitFor(
      async () => {
        const rs = await this.runs(groupId);
        return rs.length >= count && rs.every((r) => r.status !== 'running') ? rs : null;
      },
      { timeout, message: `${count} settled agent run(s) in ${groupId}` },
    );
    return runs.reverse();
  }

  async accountStatus(id: string) {
    return (await this.t.db.pool.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [id])).rows[0]!
      .status;
  }
}
