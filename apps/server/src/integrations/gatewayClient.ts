/**
 * Typed client for the message gateway (section 2.1).
 *
 * Every failure is a GatewayError whose `outcome` says whether the operation may have taken effect:
 * - 'not_applied': the gateway definitely did not perform it (explicit error, 503, connection refused);
 * - 'unknown':     it may or may not have happened (504 NETWORK_TIMEOUT, our own timeout, connection
 *                  dropped after the request was sent). Callers must reconcile before retrying.
 */

export type GatewayOutcome = 'not_applied' | 'unknown';

export class GatewayError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number | null,
    readonly code: string,
    readonly outcome: GatewayOutcome,
    readonly body: Record<string, unknown> = {},
  ) {
    super(`gateway ${endpoint} failed: ${status ?? 'no response'} ${code}`);
  }

  get unavailable(): boolean {
    return this.code === 'UNAVAILABLE' || this.status === 503;
  }
}

export const isGatewayError = (err: unknown): err is GatewayError => err instanceof GatewayError;

export interface GatewayTimeouts {
  default: number;
  send: number;
  kick: number;
}

const DEFAULT_TIMEOUTS: GatewayTimeouts = { default: 5_000, send: 8_000, kick: 8_000 };

/** Errors from fetch that prove the request never reached the server. */
const NOT_SENT_CAUSES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

export class GatewayClient {
  private readonly timeouts: GatewayTimeouts;

  constructor(
    readonly baseUrl: string,
    timeouts: Partial<GatewayTimeouts> = {},
  ) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  connect(accountId: string) {
    return this.call<{ platformUserId: string }>('connect', 'POST', `/accounts/${enc(accountId)}/connect`);
  }

  disconnect(accountId: string) {
    return this.call<Record<string, never>>('disconnect', 'POST', `/accounts/${enc(accountId)}/disconnect`);
  }

  createGroup(creatorAccountId: string) {
    return this.call<{ groupId: string }>('createGroup', 'POST', '/groups', { creatorAccountId });
  }

  invite(groupId: string) {
    return this.call<{ inviteLink: string; readyAfterMs: number }>('invite', 'POST', `/groups/${enc(groupId)}/invite`);
  }

  join(groupId: string, accountId: string, inviteLink: string) {
    return this.call<{ accepted: true }>('join', 'POST', `/groups/${enc(groupId)}/join`, { accountId, inviteLink });
  }

  promote(groupId: string, byAccountId: string, accountId: string) {
    return this.call<Record<string, never>>('promote', 'POST', `/groups/${enc(groupId)}/promote`, {
      byAccountId,
      accountId,
    });
  }

  kick(groupId: string, byAccountId: string, targetPlatformUserId: string) {
    return this.call<{ kicked: true }>(
      'kick',
      'POST',
      `/groups/${enc(groupId)}/kick`,
      { byAccountId, targetPlatformUserId },
      this.timeouts.kick,
    );
  }

  leave(groupId: string, accountId: string) {
    return this.call<Record<string, never>>('leave', 'POST', `/groups/${enc(groupId)}/leave`, { accountId });
  }

  members(groupId: string) {
    return this.call<{ platformUserId: string }[]>('members', 'GET', `/groups/${enc(groupId)}/members`);
  }

  send(groupId: string, accountId: string, clientMsgId: string, text: string) {
    return this.call<{ accepted: true }>(
      'send',
      'POST',
      `/groups/${enc(groupId)}/send`,
      { accountId, clientMsgId, text },
      this.timeouts.send,
    );
  }

  /** Returns null when the gateway answers 404 (not landed). */
  async byClientId(groupId: string, clientMsgId: string): Promise<{ msgId: string; sentAt: string } | null> {
    try {
      return await this.call<{ msgId: string; sentAt: string }>(
        'byClientId',
        'GET',
        `/groups/${enc(groupId)}/messages/by-client-id/${enc(clientMsgId)}`,
      );
    } catch (err) {
      if (isGatewayError(err) && err.status === 404) return null;
      throw err;
    }
  }

  eventsUrl(since: number): string {
    return `${this.baseUrl}/events?since=${since}`;
  }

  private async call<T>(
    endpoint: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = this.timeouts.default,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new GatewayError(endpoint, null, 'NETWORK_TIMEOUT', 'unknown');
      }
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      if (cause && NOT_SENT_CAUSES.has(cause)) throw new GatewayError(endpoint, null, 'UNAVAILABLE', 'not_applied');
      throw new GatewayError(endpoint, null, 'NETWORK_TIMEOUT', 'unknown');
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      // Headers arrived but the body was cut off: for a 2xx the operation happened.
      if (res.ok) return {} as T;
      throw new GatewayError(endpoint, res.status, 'NETWORK_TIMEOUT', 'unknown');
    }
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    if (res.ok) return parsed as T;

    const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const code =
      typeof obj.code === 'string'
        ? obj.code
        : res.status === 503
          ? 'UNAVAILABLE'
          : res.status === 504
            ? 'NETWORK_TIMEOUT'
            : `HTTP_${res.status}`;
    const outcome: GatewayOutcome = res.status === 504 || code === 'NETWORK_TIMEOUT' ? 'unknown' : 'not_applied';
    throw new GatewayError(endpoint, res.status, code, outcome, obj);
  }
}

const enc = encodeURIComponent;
