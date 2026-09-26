import pg from 'pg';
import type { Logger } from '../lib/logger';

type Handler = (payload: string) => void;

/**
 * One dedicated connection per process for LISTEN. Reconnects on failure and fires every handler
 * with payload '' after a reconnect, since notifications sent while disconnected are lost and
 * subscribers should re-poll.
 */
export class PgListener {
  private client: pg.Client | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly log: Logger,
  ) {}

  on(channel: string, handler: Handler): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      if (this.client) void this.client.query(`LISTEN ${pg.escapeIdentifier(channel)}`).catch(() => undefined);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', (msg) => this.dispatch(msg.channel, msg.payload ?? ''));
    client.on('error', (err) => {
      this.log.warn({ err }, 'pg listener connection error');
      this.scheduleReconnect(client);
    });
    client.on('end', () => this.scheduleReconnect(client));
    try {
      await client.connect();
      for (const channel of this.handlers.keys()) await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      this.client = client;
      for (const channel of this.handlers.keys()) this.dispatch(channel, '');
    } catch (err) {
      this.log.warn({ err }, 'pg listener failed to connect');
      this.scheduleReconnect(client);
    }
  }

  private scheduleReconnect(client: pg.Client) {
    if (this.stopped || this.reconnectTimer) return;
    if (this.client === client) this.client = null;
    void client.end().catch(() => undefined);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 1000);
  }

  private dispatch(channel: string, payload: string) {
    for (const h of this.handlers.get(channel) ?? []) {
      try {
        h(payload);
      } catch (err) {
        this.log.error({ err, channel }, 'listener handler failed');
      }
    }
  }
}
