export interface SseFrame {
  id: string | undefined;
  event: string;
  data: string;
}

/**
 * Incremental parser for the text/event-stream format. Feed it decoded chunks; it emits one frame
 * per blank-line-terminated block. Comment lines (": ping") are ignored.
 */
export class SseParser {
  private buffer = '';
  private id: string | undefined;
  private event = 'message';
  private data: string[] = [];

  constructor(private readonly onFrame: (frame: SseFrame) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, idx);
      const sepLen = this.buffer.startsWith('\r\n', idx) ? 2 : 1;
      this.buffer = this.buffer.slice(idx + sepLen);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) {
        this.onFrame({ id: this.id, event: this.event, data: this.data.join('\n') });
      }
      this.id = undefined;
      this.event = 'message';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') this.id = value;
    else if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}

/**
 * Opens the stream and feeds frames to `onFrame` until the server closes it, the signal aborts,
 * or a network error occurs (thrown).
 */
export async function consumeSse(url: string, signal: AbortSignal, onFrame: (frame: SseFrame) => void): Promise<void> {
  const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal });
  if (!res.ok || !res.body) throw new Error(`event stream responded ${res.status}`);
  const parser = new SseParser(onFrame);
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    parser.push(decoder.decode(chunk as Uint8Array, { stream: true }));
  }
}
