import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { WsControlFrame, WsEventFrame } from '@gmp/shared';
import type { Pool } from '../db/pool';
import type { Logger } from '../lib/logger';
import type { AuthContext, AuthService } from '../domain/auth/authService';
import type { PgListener } from '../infra/pgListener';
import { PUBLISH_CHANNEL } from './publisher';

const authMessage = z.object({
  type: z.literal('auth'),
  accessToken: z.string().min(1),
  sinceSeq: z.number().int().nonnegative().optional(),
});

const AUTH_TIMEOUT_MS = 10_000;
const REVALIDATE_MS = 30_000;
const PAGE = 1000;

interface Client {
  ws: WebSocket;
  auth: AuthContext | null;
  token: string | null;
  /** Highest seq delivered to this client. */
  lastSent: number;
  /** While replaying history, live frames are buffered here and flushed afterwards. */
  buffer: WsEventFrame[] | null;
}

/**
 * Per-instance WebSocket endpoint. Learns about newly sequenced outbox rows via NOTIFY (plus a
 * fallback poll), reads them in seq order and fans them out to authenticated clients.
 */
export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<Client>();
  private lastBroadcast = 0;
  private fetching: Promise<void> | null = null;
  private refetch = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly deps: { pool: Pool; auth: AuthService; listener: PgListener; log: Logger; pollMs?: number },
  ) {}

  async start(server: Server): Promise<void> {
    const { rows } = await this.deps.pool.query<{ seq: number }>('SELECT last_seq AS seq FROM ws_seq_state WHERE id = 1');
    this.lastBroadcast = rows[0]?.seq ?? 0;
    this.deps.listener.on(PUBLISH_CHANNEL, () => this.pull());
    this.timers.push(setInterval(() => this.pull(), this.deps.pollMs ?? 1000));
    this.timers.push(setInterval(() => void this.revalidateAll(), REVALIDATE_MS));
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  private accept(ws: WebSocket) {
    const client: Client = { ws, auth: null, token: null, lastSent: 0, buffer: null };
    this.clients.add(client);
    const authTimer = setTimeout(() => {
      if (!client.auth) this.reject(client, 'auth timeout');
    }, AUTH_TIMEOUT_MS);
    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(client);
    });
    ws.on('error', () => ws.terminate());
    ws.on('message', (data) => {
      void this.onMessage(client, data.toString()).catch((err) => {
        this.deps.log.warn({ err }, 'ws message handling failed');
      });
    });
  }

  private async onMessage(client: Client, raw: string) {
    let msg;
    try {
      msg = authMessage.parse(JSON.parse(raw));
    } catch {
      if (!client.auth) this.reject(client, 'first message must be {type:"auth", accessToken}');
      return;
    }
    let auth: AuthContext;
    try {
      auth = await this.deps.auth.authenticate(msg.accessToken);
    } catch {
      this.reject(client, 'invalid or expired access token');
      return;
    }
    const firstAuth = client.auth === null;
    client.auth = auth;
    client.token = msg.accessToken;
    this.send(client, { type: 'auth', success: true });
    if (firstAuth) await this.subscribe(client, msg.sinceSeq);
  }

  /** Starts delivery: replays (sinceSeq, now] from the table, buffering live frames meanwhile. */
  private async subscribe(client: Client, sinceSeq: number | undefined) {
    client.buffer = [];
    const { rows } = await this.deps.pool.query<{ last: number; min: number | null }>(
      'SELECT (SELECT last_seq FROM ws_seq_state WHERE id = 1) AS last, (SELECT min(seq) FROM ws_outbox) AS min',
    );
    const upTo = rows[0]!.last;
    const oldest = rows[0]!.min ?? upTo + 1;
    client.lastSent = sinceSeq ?? upTo;
    if (sinceSeq === undefined || sinceSeq === upTo) {
      // live only
    } else if (sinceSeq > upTo || sinceSeq < oldest - 1) {
      // Unknown position (e.g. database was reset) or history already pruned.
      this.send(client, { type: 'resync_required', latestSeq: upTo });
      client.lastSent = upTo;
    } else {
      let cursor = sinceSeq;
      while (cursor < upTo && client.ws.readyState === WebSocket.OPEN) {
        const frames = await this.readFrames(cursor, upTo);
        if (frames.length === 0) break;
        for (const f of frames) this.deliver(client, f, true);
        cursor = frames[frames.length - 1]!.seq;
      }
    }
    const buffered = client.buffer;
    client.buffer = null;
    for (const f of buffered) this.deliver(client, f, true);
  }

  private pull() {
    if (this.fetching) {
      this.refetch = true;
      return;
    }
    this.fetching = (async () => {
      do {
        this.refetch = false;
        try {
          let frames: WsEventFrame[];
          do {
            frames = await this.readFrames(this.lastBroadcast, undefined);
            for (const f of frames) {
              this.lastBroadcast = f.seq;
              for (const c of this.clients) if (c.auth) this.deliver(c, f, false);
            }
          } while (frames.length === PAGE);
        } catch (err) {
          this.deps.log.warn({ err }, 'ws hub failed to read outbox');
        }
      } while (this.refetch);
      this.fetching = null;
    })();
  }

  private async readFrames(afterSeq: number, upTo: number | undefined): Promise<WsEventFrame[]> {
    const { rows } = await this.deps.pool.query<WsEventFrame>(
      `SELECT seq, type, payload FROM ws_outbox
        WHERE seq > $1 AND ($2::bigint IS NULL OR seq <= $2)
        ORDER BY seq LIMIT ${PAGE}`,
      [afterSeq, upTo ?? null],
    );
    return rows;
  }

  private deliver(client: Client, frame: WsEventFrame, fromReplay: boolean) {
    if (client.buffer && !fromReplay) {
      client.buffer.push(frame);
      return;
    }
    if (frame.seq <= client.lastSent) return;
    client.lastSent = frame.seq;
    this.send(client, frame);
  }

  private send(client: Client, frame: WsEventFrame | WsControlFrame) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(frame));
  }

  private reject(client: Client, error: string) {
    this.send(client, { type: 'auth', success: false, error });
    client.ws.close(4401, 'unauthorized');
  }

  /** Closes connections whose token expired or whose session was revoked (logout, token reuse). */
  private async revalidateAll() {
    for (const c of this.clients) {
      if (!c.token) continue;
      try {
        await this.deps.auth.authenticate(c.token);
      } catch {
        this.reject(c, 'session expired; send a new auth message with a fresh token');
      }
    }
  }
}
