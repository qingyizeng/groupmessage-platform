import type { WsControlFrame, WsEventFrame } from '@gmp/shared';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface RealtimeOptions {
  url: string;
  getToken: () => string | null;
  /** Called when the server rejects the token; should return a fresh one (or null if logged out). */
  refreshToken: () => Promise<string | null>;
  onEvent: (frame: WsEventFrame) => void;
  /** The server cannot replay what we missed: reload everything. */
  onResync: () => void;
  onState?: (state: ConnectionState) => void;
  createSocket?: (url: string) => WebSocket;
}

/**
 * WebSocket client for /ws. Remembers the last seq it delivered; after any disconnect it
 * reconnects with sinceSeq, so events that happened meanwhile are replayed by the server.
 * Frames are delivered in seq order at most once, even if replay and live traffic overlap.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private lastSeq: number | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authFailures = 0;

  constructor(private readonly opts: RealtimeOptions) {}

  get seq(): number | null {
    return this.lastSeq;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  /** Re-authenticates the open connection with a new token (after a refresh). */
  updateToken(token: string | null): void {
    if (!token) return this.stop();
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type: 'auth', accessToken: token }));
  }

  /** Visible for tests: handles one raw frame. */
  handle(raw: string): void {
    let frame: WsEventFrame | WsControlFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if ('seq' in frame && typeof frame.seq === 'number') {
      if (this.lastSeq !== null && frame.seq <= this.lastSeq) return;
      this.lastSeq = frame.seq;
      this.opts.onEvent(frame);
      return;
    }
    if (frame.type === 'auth') {
      if (frame.success) {
        this.attempt = 0;
        this.authFailures = 0;
        this.opts.onState?.('open');
      } else {
        void this.recoverAuth();
      }
    } else if (frame.type === 'resync_required') {
      this.lastSeq = frame.latestSeq;
      this.opts.onResync();
    }
  }

  private connect() {
    if (this.stopped) return;
    const token = this.opts.getToken();
    if (!token) return;
    this.opts.onState?.('connecting');
    const ws = (this.opts.createSocket ?? ((u) => new WebSocket(u)))(this.opts.url);
    this.socket = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'auth',
          accessToken: this.opts.getToken(),
          ...(this.lastSeq !== null ? { sinceSeq: this.lastSeq } : {}),
        }),
      );
    };
    ws.onmessage = (e) => this.handle(String(e.data));
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.opts.onState?.('closed');
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(250 * 2 ** this.attempt++, 3_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async recoverAuth() {
    if (++this.authFailures > 3) return this.stop();
    const token = await this.opts.refreshToken();
    if (!token) this.stop();
  }
}
