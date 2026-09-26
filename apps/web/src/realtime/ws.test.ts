import { describe, expect, it } from 'vitest';
import { RealtimeClient } from './ws';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('RealtimeClient', () => {
  it('delivers each seq once, in order, and resumes from the last seq after reconnecting', async () => {
    FakeSocket.all = [];
    const seen: number[] = [];
    const client = new RealtimeClient({
      url: 'ws://x/ws',
      getToken: () => 'tok',
      refreshToken: async () => 'tok',
      onEvent: (f) => seen.push(f.seq),
      onResync: () => undefined,
      createSocket: (u) => new FakeSocket(u) as unknown as WebSocket,
    });
    client.start();
    const first = FakeSocket.all[0]!;
    first.open();
    expect(first.sent[0]).toEqual({ type: 'auth', accessToken: 'tok' });
    first.receive({ type: 'auth', success: true });
    for (const seq of [1, 2, 2, 3]) first.receive({ seq, type: 'inconsistency', payload: {} });
    first.close();

    await new Promise((r) => setTimeout(r, 300));
    const second = FakeSocket.all[1]!;
    second.open();
    expect(second.sent[0]).toEqual({ type: 'auth', accessToken: 'tok', sinceSeq: 3 });
    for (const seq of [3, 4, 5]) second.receive({ seq, type: 'inconsistency', payload: {} });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    client.stop();
  });

  it('asks for a full reload on resync_required', () => {
    FakeSocket.all = [];
    let resynced = false;
    const client = new RealtimeClient({
      url: 'ws://x/ws',
      getToken: () => 'tok',
      refreshToken: async () => 'tok',
      onEvent: () => undefined,
      onResync: () => (resynced = true),
      createSocket: (u) => new FakeSocket(u) as unknown as WebSocket,
    });
    client.start();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ type: 'resync_required', latestSeq: 42 });
    expect(resynced).toBe(true);
    expect(client.seq).toBe(42);
    client.stop();
  });
});
