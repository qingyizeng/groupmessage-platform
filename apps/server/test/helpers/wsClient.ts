import WebSocket from 'ws';

export interface Frame {
  seq?: number;
  type: string;
  payload?: Record<string, unknown>;
  success?: boolean;
  error?: string;
}

export interface TestWs {
  ws: WebSocket;
  /** Sequenced event frames, in arrival order. */
  events: Frame[];
  /** Control frames (auth replies, resync). */
  control: Frame[];
  closed: Promise<number>;
  waitFor(pred: (f: Frame) => boolean, timeout?: number): Promise<Frame>;
  close(): void;
}

export async function openWs(baseUrl: string, accessToken: string | null, sinceSeq?: number): Promise<TestWs> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`);
  const events: Frame[] = [];
  const control: Frame[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (data) => {
    const f = JSON.parse(data.toString()) as Frame;
    (typeof f.seq === 'number' ? events : control).push(f);
    for (const l of listeners) l();
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  if (accessToken !== null) {
    ws.send(JSON.stringify({ type: 'auth', accessToken, ...(sinceSeq !== undefined ? { sinceSeq } : {}) }));
  }

  const waitFor = (pred: (f: Frame) => boolean, timeout = 5_000) =>
    new Promise<Frame>((resolve, reject) => {
      const check = () => {
        const hit = [...events, ...control].find(pred);
        if (hit) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(hit);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`ws waitFor timed out; got ${JSON.stringify([...control, ...events]).slice(0, 500)}`));
      }, timeout);
      listeners.add(check);
      check();
    });

  if (accessToken !== null) await waitFor((f) => f.type === 'auth');
  return { ws, events, control, closed, waitFor, close: () => ws.close() };
}
