import { createHash, randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

/**
 * In-memory simulation of the message gateway described in section 2.1, including its timing
 * behaviour, plus a /_control API for fault injection and state inspection in tests and demos.
 */

type Range = [number, number];

export interface Timings {
  /** Latency of the synchronous 202 for send. */
  sendAckMs: Range;
  /** Delay from accepting a send to the message landing (message_sent / message). */
  sentEventMs: Range;
  /** Delay from join 202 to the account actually being in the group. */
  joinMs: Range;
  /** Latency of the kick response. */
  kickMs: Range;
  /** Lag between a membership change and its member_joined / member_left event. */
  memberEventLagMs: Range;
  /** Candidates for readyAfterMs of a new invite link. */
  inviteReadyAfterMs: number[];
}

export const REALISTIC_TIMINGS: Timings = {
  sendAckMs: [1000, 2000],
  sentEventMs: [50, 2000],
  joinMs: [100, 1500],
  kickMs: [1000, 5000],
  memberEventLagMs: [10, 100],
  inviteReadyAfterMs: [0, 0, 2000],
};

export const FAST_TIMINGS: Timings = {
  sendAckMs: [5, 20],
  sentEventMs: [5, 30],
  joinMs: [10, 40],
  kickMs: [10, 40],
  memberEventLagMs: [1, 10],
  inviteReadyAfterMs: [0],
};

export type Endpoint =
  | 'connect'
  | 'disconnect'
  | 'createGroup'
  | 'invite'
  | 'join'
  | 'promote'
  | 'kick'
  | 'leave'
  | 'send'
  | 'members'
  | 'byClientId'
  | 'media';

export type FaultAction =
  /** Respond with this error and do nothing else. */
  | { type: 'error'; status: number; code: string; body?: Record<string, unknown> }
  /** Respond 504 NETWORK_TIMEOUT. With effect=true the operation still happens (send lands after landAfterMs). */
  | { type: 'timeout'; effect?: boolean; landAfterMs?: number }
  /** Add latency, then process normally. */
  | { type: 'delay'; ms: number }
  /** Never respond (the caller has to time out). With effect=true the operation still happens. */
  | { type: 'hang'; effect?: boolean }
  /** send: 202, then message_failed with this code. */
  | { type: 'fail_after_accept'; code: 'GROUP_WRITE_FORBIDDEN' | 'ACCOUNT_SUSPENDED' }
  /** join: 202 but the account never joins. */
  | { type: 'never_join' }
  /** join: the account is (silently, without an event) already a member, so the gateway answers 409 ALREADY_MEMBER. */
  | { type: 'already_member' }
  /** send: start a rate-limit window for the account and respond 429. */
  | { type: 'rate_limit'; retryAfterSeconds: number };

export interface FaultRule {
  endpoint: Endpoint;
  accountId?: string;
  groupId?: string;
  /** How many matching calls this rule applies to; -1 = unlimited. */
  times?: number;
  action: FaultAction;
}

interface Account {
  id: string;
  platformUserId: string;
  online: boolean;
  terminal: null | 'suspended' | 'session_expired';
  rateLimitedUntil: number;
  rateLimitSeconds: number;
}

interface StoredMessage {
  groupId: string;
  msgId: string;
  clientMsgId: string | null;
  senderPlatformUserId: string;
  text: string;
  sentAt: string;
  mediaUrl?: string;
}

interface Group {
  id: string;
  ownerAccountId: string;
  ownerPlatformUserId: string;
  ownerLeft: boolean;
  members: Set<string>;
  promoted: Set<string>;
  writable: boolean;
  invites: Map<string, { readyAt: number; expired: boolean }>;
  pendingJoins: Set<string>;
  messages: StoredMessage[];
}

interface GatewayEvent {
  eventId: number;
  type: string;
  data: Record<string, unknown>;
}

export interface CallRecord {
  endpoint: Endpoint;
  at: number;
  groupId?: string;
  accountId?: string;
  body?: unknown;
  status?: number;
}

export interface MockGatewayOptions {
  timings?: Timings;
  publicUrl?: string;
  logger?: boolean;
  /**
   * First event id is eventIdBase + 1. A real gateway never reuses ids; a standalone mock starts from a
   * time-based base so that restarting it does not replay ids a server has already stored.
   */
  eventIdBase?: number;
}

export interface MockGateway {
  app: FastifyInstance;
  state: MockGatewayState;
}

export function platformUserIdFor(accountId: string): string {
  return `pu_${createHash('sha1').update(accountId).digest('hex').slice(0, 12)}`;
}

const rand = ([a, b]: Range) => Math.round(a + Math.random() * (b - a));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

class HttpFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export class MockGatewayState {
  timings: Timings;
  duplicateEvents = false;
  reorderWindowMs = 0;
  accounts = new Map<string, Account>();
  groups = new Map<string, Group>();
  events: GatewayEvent[] = [];
  calls: CallRecord[] = [];
  faults: (FaultRule & { id: number; remaining: number })[] = [];
  media = new Map<string, { bytes: Buffer; contentType: string; expiresAt: number }>();
  subscribers = new Set<ServerResponse>();
  private timers = new Set<NodeJS.Timeout>();
  private counter = 0;

  constructor(
    timings: Timings,
    /** Base URL for invite links and media URLs; set after listen when the port is dynamic. */
    public publicUrl: string,
    readonly eventIdBase = 0,
  ) {
    this.timings = timings;
  }

  reset() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.accounts.clear();
    this.groups.clear();
    this.events = [];
    this.calls = [];
    this.faults = [];
    this.media.clear();
    this.duplicateEvents = false;
    this.reorderWindowMs = 0;
    this.dropSubscribers();
  }

  nextId(prefix: string) {
    return `${prefix}_${++this.counter}_${randomBytes(3).toString('hex')}`;
  }

  later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  account(accountId: string): Account {
    let acc = this.accounts.get(accountId);
    if (!acc) {
      acc = {
        id: accountId,
        platformUserId: platformUserIdFor(accountId),
        online: false,
        terminal: null,
        rateLimitedUntil: 0,
        rateLimitSeconds: 0,
      };
      this.accounts.set(accountId, acc);
    }
    return acc;
  }

  group(groupId: string): Group {
    const g = this.groups.get(groupId);
    if (!g) throw new HttpFail(404, 'GROUP_NOT_FOUND');
    return g;
  }

  /** Terminal accounts fail every request; offline accounts fail group operations. */
  gate(accountId: string, requireOnline = true): Account {
    const acc = this.account(accountId);
    if (acc.terminal === 'suspended') throw new HttpFail(403, 'ACCOUNT_SUSPENDED');
    if (acc.terminal === 'session_expired') throw new HttpFail(401, 'SESSION_EXPIRED');
    if (requireOnline && !acc.online) throw new HttpFail(409, 'ACCOUNT_OFFLINE');
    return acc;
  }

  takeFault(endpoint: Endpoint, ctx: { accountId?: string; groupId?: string }): FaultAction | undefined {
    const rule = this.faults.find(
      (f) =>
        f.endpoint === endpoint &&
        f.remaining !== 0 &&
        (f.accountId === undefined || f.accountId === ctx.accountId) &&
        (f.groupId === undefined || f.groupId === ctx.groupId),
    );
    if (!rule) return undefined;
    if (rule.remaining > 0) rule.remaining--;
    return rule.action;
  }

  emit(type: string, data: Record<string, unknown>) {
    const eventId = this.eventIdBase + this.events.length + 1;
    const evt: GatewayEvent = { eventId, type, data: { ...data, eventId, type } };
    this.events.push(evt);
    for (const sub of this.subscribers) {
      const delay = this.reorderWindowMs > 0 ? Math.random() * this.reorderWindowMs : 0;
      const write = () => writeFrame(sub, evt);
      if (delay > 0) this.later(delay, write);
      else write();
      if (this.duplicateEvents) this.later(delay + 5 + Math.random() * 20, write);
    }
  }

  emitMemberEvent(type: 'member_joined' | 'member_left', groupId: string, platformUserId: string) {
    this.later(rand(this.timings.memberEventLagMs), () => this.emit(type, { groupId, platformUserId }));
  }

  removeMember(group: Group, platformUserId: string) {
    if (!group.members.delete(platformUserId)) return false;
    group.promoted.delete(platformUserId);
    if (platformUserId === group.ownerPlatformUserId) group.ownerLeft = true;
    this.emitMemberEvent('member_left', group.id, platformUserId);
    return true;
  }

  land(group: Group, acc: Account, clientMsgId: string | null, text: string, sentAt = new Date().toISOString()) {
    if (!group.writable) {
      if (clientMsgId) this.emit('message_failed', { clientMsgId, code: 'GROUP_WRITE_FORBIDDEN' });
      return;
    }
    if (acc.terminal) {
      if (clientMsgId) this.emit('message_failed', { clientMsgId, code: 'ACCOUNT_SUSPENDED' });
      return;
    }
    const msg: StoredMessage = {
      groupId: group.id,
      msgId: this.nextId('m'),
      clientMsgId,
      senderPlatformUserId: acc.platformUserId,
      text,
      sentAt,
    };
    group.messages.push(msg);
    if (clientMsgId) this.emit('message_sent', { clientMsgId, msgId: msg.msgId, sentAt });
    this.emit('message', {
      groupId: group.id,
      msgId: msg.msgId,
      senderPlatformUserId: msg.senderPlatformUserId,
      text,
      sentAt,
    });
  }

  makeTerminal(accountId: string, status: 'suspended' | 'session_expired', emitEvent: boolean) {
    const acc = this.account(accountId);
    acc.terminal = status;
    acc.online = false;
    for (const g of this.groups.values()) this.removeMember(g, acc.platformUserId);
    if (emitEvent) this.emit('account_status', { accountId, status });
  }

  dropSubscribers() {
    for (const sub of this.subscribers) sub.end();
    this.subscribers.clear();
  }

  snapshot() {
    return {
      accounts: [...this.accounts.values()],
      groups: [...this.groups.values()].map((g) => ({
        id: g.id,
        ownerAccountId: g.ownerAccountId,
        ownerLeft: g.ownerLeft,
        writable: g.writable,
        members: [...g.members],
        promoted: [...g.promoted],
        messages: g.messages,
      })),
      eventCount: this.events.length,
      calls: this.calls,
    };
  }
}

function writeFrame(res: ServerResponse, evt: GatewayEvent) {
  if (res.writableEnded) return;
  res.write(`id: ${evt.eventId}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
}

export function buildMockGateway(opts: MockGatewayOptions = {}): MockGateway {
  const state = new MockGatewayState(
    opts.timings ?? REALISTIC_TIMINGS,
    opts.publicUrl ?? 'http://localhost:4001',
    opts.eventIdBase ?? 0,
  );
  // forceCloseConnections: hung requests and open event streams must not keep close() waiting.
  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof HttpFail) return reply.status(err.status).send({ code: err.code, message: err.code, ...err.extra });
    return reply.status(500).send({ code: 'INTERNAL', message: err.message });
  });

  app.addHook('onClose', async () => {
    state.reset();
  });

  const record = (req: object, endpoint: Endpoint, ctx: Omit<CallRecord, 'endpoint' | 'at'>) => {
    const rec: CallRecord = { endpoint, at: Date.now(), ...ctx };
    state.calls.push(rec);
    (req as { gmpCall?: CallRecord }).gmpCall = rec;
    return rec;
  };

  app.addHook('onResponse', async (req, reply) => {
    const rec = (req as { gmpCall?: CallRecord }).gmpCall;
    if (rec) rec.status = reply.statusCode;
  });

  /**
   * Applies faults that behave the same on every endpoint. Returns the remaining action for
   * endpoint-specific handling, or 'handled' when a response has already been produced.
   */
  async function generic(
    action: FaultAction | undefined,
    reply: FastifyReply,
    rec: CallRecord,
    effect: () => Promise<void> | void,
  ): Promise<FaultAction | undefined | 'handled'> {
    if (!action) return undefined;
    switch (action.type) {
      case 'error':
        rec.status = action.status;
        reply.status(action.status).send({ code: action.code, message: action.code, ...action.body });
        return 'handled';
      case 'delay':
        await sleep(action.ms);
        return undefined;
      case 'hang':
        if (action.effect) await effect();
        rec.status = 0;
        await new Promise(() => undefined);
        return 'handled';
      default:
        return action;
    }
  }

  const timeout = (reply: FastifyReply, rec: CallRecord) => {
    rec.status = 504;
    return reply.status(504).send({ code: 'NETWORK_TIMEOUT', message: 'NETWORK_TIMEOUT' });
  };

  // ---------------------------------------------------------------- accounts

  app.post<{ Params: { accountId: string } }>('/accounts/:accountId/connect', async (req, reply) => {
    const { accountId } = req.params;
    const rec = record(req, 'connect', { accountId });
    const f = await generic(state.takeFault('connect', { accountId }), reply, rec, () => undefined);
    if (f === 'handled') return reply;
    const acc = state.gate(accountId, false);
    acc.online = true;
    rec.status = 200;
    return { platformUserId: acc.platformUserId };
  });

  app.post<{ Params: { accountId: string } }>('/accounts/:accountId/disconnect', async (req, reply) => {
    const { accountId } = req.params;
    const rec = record(req, 'disconnect', { accountId });
    const f = await generic(state.takeFault('disconnect', { accountId }), reply, rec, () => undefined);
    if (f === 'handled') return reply;
    const acc = state.gate(accountId, false);
    acc.online = false;
    rec.status = 200;
    return {};
  });

  // ---------------------------------------------------------------- groups

  app.post<{ Body: { creatorAccountId: string } }>('/groups', async (req, reply) => {
    const { creatorAccountId } = req.body;
    const rec = record(req, 'createGroup', { accountId: creatorAccountId });
    const f = await generic(state.takeFault('createGroup', { accountId: creatorAccountId }), reply, rec, () => undefined);
    if (f === 'handled') return reply;
    const acc = state.gate(creatorAccountId);
    const group: Group = {
      id: state.nextId('g'),
      ownerAccountId: acc.id,
      ownerPlatformUserId: acc.platformUserId,
      ownerLeft: false,
      members: new Set([acc.platformUserId]),
      promoted: new Set(),
      writable: true,
      invites: new Map(),
      pendingJoins: new Set(),
      messages: [],
    };
    state.groups.set(group.id, group);
    rec.groupId = group.id;
    rec.status = 200;
    return { groupId: group.id };
  });

  app.post<{ Params: { groupId: string } }>('/groups/:groupId/invite', async (req, reply) => {
    const { groupId } = req.params;
    const rec = record(req, 'invite', { groupId });
    const f = await generic(state.takeFault('invite', { groupId }), reply, rec, () => undefined);
    if (f === 'handled') return reply;
    const group = state.group(groupId);
    const readyAfterMs = pick(state.timings.inviteReadyAfterMs);
    const inviteLink = `${state.publicUrl}/invite/${state.nextId('inv')}`;
    group.invites.set(inviteLink, { readyAt: Date.now() + readyAfterMs, expired: false });
    rec.status = 200;
    return { inviteLink, readyAfterMs };
  });

  app.post<{ Params: { groupId: string }; Body: { accountId: string; inviteLink: string } }>(
    '/groups/:groupId/join',
    async (req, reply) => {
      const { groupId } = req.params;
      const { accountId, inviteLink } = req.body;
      const rec = record(req, 'join', { groupId, accountId, body: req.body });
      const group = state.group(groupId);
      const acc = state.account(accountId);
      const doJoin = () => {
        group.pendingJoins.add(acc.platformUserId);
        state.later(rand(state.timings.joinMs), () => {
          group.pendingJoins.delete(acc.platformUserId);
          if (acc.terminal || group.members.has(acc.platformUserId)) return;
          group.members.add(acc.platformUserId);
          state.emitMemberEvent('member_joined', group.id, acc.platformUserId);
        });
      };
      const f = await generic(state.takeFault('join', { groupId, accountId }), reply, rec, doJoin);
      if (f === 'handled') return reply;
      state.gate(accountId);
      if (f?.type === 'already_member') group.members.add(acc.platformUserId);
      const invite = group.invites.get(inviteLink);
      if (!invite || invite.expired) throw new HttpFail(410, 'INVITE_EXPIRED');
      if (Date.now() < invite.readyAt) throw new HttpFail(409, 'INVITE_NOT_READY');
      if (group.members.has(acc.platformUserId)) throw new HttpFail(409, 'ALREADY_MEMBER');
      if (f?.type === 'timeout') {
        if (f.effect) doJoin();
        return timeout(reply, rec);
      }
      if (f?.type !== 'never_join' && !group.pendingJoins.has(acc.platformUserId)) doJoin();
      rec.status = 202;
      return reply.status(202).send({ accepted: true });
    },
  );

  app.post<{ Params: { groupId: string }; Body: { byAccountId: string; accountId: string } }>(
    '/groups/:groupId/promote',
    async (req, reply) => {
      const { groupId } = req.params;
      const { byAccountId, accountId } = req.body;
      const rec = record(req, 'promote', { groupId, accountId: byAccountId, body: req.body });
      const f = await generic(state.takeFault('promote', { groupId, accountId: byAccountId }), reply, rec, () => undefined);
      if (f === 'handled') return reply;
      const group = state.group(groupId);
      const by = state.gate(byAccountId);
      if (group.ownerLeft || by.platformUserId !== group.ownerPlatformUserId) throw new HttpFail(403, 'NO_PERMISSION');
      const target = state.account(accountId);
      if (!group.members.has(target.platformUserId)) throw new HttpFail(409, 'NOT_MEMBER_YET');
      group.promoted.add(target.platformUserId);
      rec.status = 200;
      return {};
    },
  );

  app.post<{ Params: { groupId: string }; Body: { byAccountId: string; targetPlatformUserId: string } }>(
    '/groups/:groupId/kick',
    async (req, reply) => {
      const { groupId } = req.params;
      const { byAccountId, targetPlatformUserId } = req.body;
      const rec = record(req, 'kick', { groupId, accountId: byAccountId, body: req.body });
      const group = state.group(groupId);
      const doKick = () => {
        state.removeMember(group, targetPlatformUserId);
      };
      const f = await generic(state.takeFault('kick', { groupId, accountId: byAccountId }), reply, rec, doKick);
      if (f === 'handled') return reply;
      const by = state.gate(byAccountId);
      if (group.ownerLeft) throw new HttpFail(409, 'OWNER_LEFT');
      if (by.platformUserId !== group.ownerPlatformUserId && !group.promoted.has(by.platformUserId)) {
        throw new HttpFail(403, 'NO_PERMISSION');
      }
      if (!group.members.has(targetPlatformUserId)) throw new HttpFail(409, 'NOT_MEMBER');
      await sleep(rand(state.timings.kickMs));
      if (f?.type === 'timeout') {
        if (f.effect) doKick();
        return timeout(reply, rec);
      }
      doKick();
      rec.status = 200;
      return { kicked: true };
    },
  );

  app.post<{ Params: { groupId: string }; Body: { accountId: string } }>('/groups/:groupId/leave', async (req, reply) => {
    const { groupId } = req.params;
    const { accountId } = req.body;
    const rec = record(req, 'leave', { groupId, accountId });
    const group = state.group(groupId);
    const acc = state.account(accountId);
    const f = await generic(state.takeFault('leave', { groupId, accountId }), reply, rec, () => {
      state.removeMember(group, acc.platformUserId);
    });
    if (f === 'handled') return reply;
    state.gate(accountId);
    if (!group.members.has(acc.platformUserId)) throw new HttpFail(409, 'NOT_MEMBER');
    state.removeMember(group, acc.platformUserId);
    rec.status = 200;
    return {};
  });

  app.get<{ Params: { groupId: string } }>('/groups/:groupId/members', async (req, reply) => {
    const { groupId } = req.params;
    const rec = record(req, 'members', { groupId });
    const f = await generic(state.takeFault('members', { groupId }), reply, rec, () => undefined);
    if (f === 'handled') return reply;
    const group = state.group(groupId);
    rec.status = 200;
    return [...group.members].map((platformUserId) => ({ platformUserId }));
  });

  // ---------------------------------------------------------------- messages

  app.post<{ Params: { groupId: string }; Body: { accountId: string; clientMsgId: string; text: string } }>(
    '/groups/:groupId/send',
    async (req, reply) => {
      const { groupId } = req.params;
      const { accountId, clientMsgId, text } = req.body;
      const rec = record(req, 'send', { groupId, accountId, body: req.body });
      const group = state.group(groupId);
      const acc = state.account(accountId);
      const land = () => state.land(group, acc, clientMsgId, text);
      const f = await generic(state.takeFault('send', { groupId, accountId }), reply, rec, () =>
        state.later(rand(state.timings.sentEventMs), land),
      );
      if (f === 'handled') return reply;

      state.gate(accountId);
      if (f?.type === 'rate_limit') {
        acc.rateLimitSeconds = f.retryAfterSeconds;
        acc.rateLimitedUntil = Date.now() + f.retryAfterSeconds * 1000;
        throw new HttpFail(429, 'RATE_LIMITED', { retryAfterSeconds: f.retryAfterSeconds });
      }
      if (Date.now() < acc.rateLimitedUntil) {
        acc.rateLimitedUntil = Date.now() + acc.rateLimitSeconds * 1000;
        throw new HttpFail(429, 'RATE_LIMITED', { retryAfterSeconds: acc.rateLimitSeconds });
      }
      if (!group.writable) throw new HttpFail(403, 'GROUP_WRITE_FORBIDDEN');
      if (!group.members.has(acc.platformUserId)) throw new HttpFail(403, 'SENDER_NOT_IN_GROUP');

      if (f?.type === 'timeout') {
        if (f.effect) state.later(f.landAfterMs ?? 1500, land);
        await sleep(rand(state.timings.sendAckMs));
        return timeout(reply, rec);
      }
      if (f?.type === 'fail_after_accept') {
        state.later(rand(state.timings.sentEventMs), () =>
          state.emit('message_failed', { clientMsgId, code: f.code }),
        );
      } else {
        state.later(rand(state.timings.sentEventMs), land);
      }
      await sleep(rand(state.timings.sendAckMs));
      rec.status = 202;
      return reply.status(202).send({ accepted: true });
    },
  );

  app.get<{ Params: { groupId: string; clientMsgId: string } }>(
    '/groups/:groupId/messages/by-client-id/:clientMsgId',
    async (req, reply) => {
      const { groupId, clientMsgId } = req.params;
      const rec = record(req, 'byClientId', { groupId, body: { clientMsgId } });
      const f = await generic(state.takeFault('byClientId', { groupId }), reply, rec, () => undefined);
      if (f === 'handled') return reply;
      const msg = state.group(groupId).messages.find((m) => m.clientMsgId === clientMsgId);
      if (!msg) throw new HttpFail(404, 'NOT_FOUND');
      rec.status = 200;
      return { msgId: msg.msgId, sentAt: msg.sentAt };
    },
  );

  app.get<{ Params: { id: string } }>('/media/:id', async (req, reply) => {
    const rec = record(req, 'media', { body: { id: req.params.id } });
    const f = await generic(state.takeFault('media', {}), reply, rec, () => undefined);
    if (f === 'handled') return reply;
    const media = state.media.get(req.params.id);
    if (!media || media.expiresAt < Date.now()) throw new HttpFail(404, 'NOT_FOUND');
    return reply.type(media.contentType).send(media.bytes);
  });

  // ---------------------------------------------------------------- event stream

  app.get<{ Querystring: { since?: string } }>('/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    if (req.query.since !== undefined) {
      const since = Number(req.query.since);
      for (const evt of state.events) if (evt.eventId > since) writeFrame(res, evt);
    }
    state.subscribers.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    res.on('close', () => {
      clearInterval(ping);
      state.subscribers.delete(res);
    });
  });

  // ---------------------------------------------------------------- control API

  app.post('/_control/reset', async () => {
    state.reset();
    return { ok: true };
  });

  app.get('/_control/state', async () => state.snapshot());

  app.post<{ Body: { timings?: Partial<Timings>; duplicateEvents?: boolean; reorderWindowMs?: number } }>(
    '/_control/config',
    async (req) => {
      const { timings, duplicateEvents, reorderWindowMs } = req.body ?? {};
      if (timings) state.timings = { ...state.timings, ...timings };
      if (duplicateEvents !== undefined) state.duplicateEvents = duplicateEvents;
      if (reorderWindowMs !== undefined) state.reorderWindowMs = Math.min(reorderWindowMs, 1000);
      return { timings: state.timings, duplicateEvents: state.duplicateEvents, reorderWindowMs: state.reorderWindowMs };
    },
  );

  let faultSeq = 0;
  app.post<{ Body: FaultRule }>('/_control/faults', async (req) => {
    const id = ++faultSeq;
    state.faults.push({ ...req.body, id, remaining: req.body.times ?? 1 });
    return { id };
  });

  app.delete('/_control/faults', async () => {
    state.faults = [];
    return { ok: true };
  });

  app.post<{ Params: { accountId: string }; Body: { status: 'suspended' | 'session_expired'; emitEvent?: boolean } }>(
    '/_control/accounts/:accountId/terminal',
    async (req) => {
      state.makeTerminal(req.params.accountId, req.body.status, req.body.emitEvent ?? true);
      return { ok: true };
    },
  );

  app.post<{ Params: { groupId: string }; Body: { writable: boolean } }>(
    '/_control/groups/:groupId/writable',
    async (req) => {
      state.group(req.params.groupId).writable = req.body.writable;
      return { ok: true };
    },
  );

  app.post<{ Params: { groupId: string }; Body: { platformUserId: string } }>(
    '/_control/groups/:groupId/external-join',
    async (req) => {
      const group = state.group(req.params.groupId);
      if (!group.members.has(req.body.platformUserId)) {
        group.members.add(req.body.platformUserId);
        state.emitMemberEvent('member_joined', group.id, req.body.platformUserId);
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { groupId: string }; Body: { platformUserId: string } }>(
    '/_control/groups/:groupId/external-leave',
    async (req) => {
      state.removeMember(state.group(req.params.groupId), req.body.platformUserId);
      return { ok: true };
    },
  );

  app.post<{
    Params: { groupId: string };
    Body: { platformUserId: string; text: string; media?: { contentType?: string; base64?: string; ttlMs?: number } };
  }>('/_control/groups/:groupId/external-message', async (req) => {
    const group = state.group(req.params.groupId);
    const { platformUserId, text, media } = req.body;
    const msg: StoredMessage = {
      groupId: group.id,
      msgId: state.nextId('m'),
      clientMsgId: null,
      senderPlatformUserId: platformUserId,
      text,
      sentAt: new Date().toISOString(),
    };
    if (media) {
      const id = state.nextId('media');
      state.media.set(id, {
        bytes: media.base64 ? Buffer.from(media.base64, 'base64') : randomBytes(64),
        contentType: media.contentType ?? 'application/octet-stream',
        expiresAt: Date.now() + (media.ttlMs ?? 3_600_000),
      });
      msg.mediaUrl = `${state.publicUrl}/media/${id}`;
    }
    group.messages.push(msg);
    const { clientMsgId: _omit, ...event } = msg;
    state.emit('message', event);
    return { msgId: msg.msgId, sentAt: msg.sentAt };
  });

  /** Re-delivers an old message from a service account, as happens after it was offline. */
  app.post<{ Params: { groupId: string }; Body: { accountId: string; text: string; sentAtMsAgo: number } }>(
    '/_control/groups/:groupId/backfill',
    async (req) => {
      const group = state.group(req.params.groupId);
      const acc = state.account(req.body.accountId);
      const sentAt = new Date(Date.now() - req.body.sentAtMsAgo).toISOString();
      const msg: StoredMessage = {
        groupId: group.id,
        msgId: state.nextId('m'),
        clientMsgId: null,
        senderPlatformUserId: acc.platformUserId,
        text: req.body.text,
        sentAt,
      };
      group.messages.push(msg);
      const { clientMsgId: _omit, ...event } = msg;
      state.emit('message', event);
      return { msgId: msg.msgId, sentAt };
    },
  );

  app.post<{ Params: { groupId: string } }>('/_control/groups/:groupId/expire-invites', async (req) => {
    for (const inv of state.group(req.params.groupId).invites.values()) inv.expired = true;
    return { ok: true };
  });

  app.post('/_control/events/disconnect-all', async () => {
    state.dropSubscribers();
    return { ok: true };
  });

  /** Emits an arbitrary raw event (e.g. to test handling of malformed payloads). */
  app.post<{ Body: { type: string; data: Record<string, unknown> } }>('/_control/events/emit', async (req) => {
    state.emit(req.body.type, req.body.data);
    return { eventId: state.eventIdBase + state.events.length };
  });

  return { app, state };
}
