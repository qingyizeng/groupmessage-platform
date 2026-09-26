import type { FastifyInstance } from 'fastify';
import { createContext, type AppContext, type CoreDeps } from './context';
import { buildApp } from './http/app';
import { PgListener } from './infra/pgListener';
import { EventIngestor } from './events/ingest';
import { InboxProcessor } from './events/inboxProcessor';
import { createEventHandlers } from './events/handlers';
import { TaskRunner } from './domain/tasks/scheduledTasks';
import { WsPublisher } from './realtime/publisher';
import { WsHub } from './realtime/wsHub';
import { DeliveryService } from './domain/messages/delivery';

export interface WorkerSelection {
  ingest?: boolean;
  inbox?: boolean;
  tasks?: boolean;
  publisher?: boolean;
  delivery?: boolean;
}

/**
 * Wires the HTTP app, the WebSocket hub and every background worker of one server process.
 * All coordination between processes goes through PostgreSQL, so any number can run side by side.
 */
export class Runtime {
  readonly listener: PgListener;
  readonly ingestor: EventIngestor;
  readonly inbox: InboxProcessor;
  readonly tasks: TaskRunner;
  readonly publisher: WsPublisher;
  readonly hub: WsHub;
  readonly delivery: DeliveryService;
  private abort = new AbortController();
  private running: Promise<unknown>[] = [];

  private constructor(
    readonly app: FastifyInstance,
    readonly ctx: AppContext,
  ) {
    const { config, pool, log } = ctx;
    this.listener = new PgListener(config.DATABASE_URL, log.child({ component: 'pg-listener' }));
    this.inbox = new InboxProcessor({
      pool,
      listener: this.listener,
      log: log.child({ component: 'inbox' }),
      handlers: createEventHandlers(ctx),
    });
    this.ingestor = new EventIngestor({
      pool,
      connectionString: config.DATABASE_URL,
      eventsUrl: (since) => ctx.gateway.eventsUrl(since),
      log: log.child({ component: 'ingest' }),
      onPersisted: () => this.inbox.wake(),
    });
    this.tasks = new TaskRunner({
      pool,
      listener: this.listener,
      log: log.child({ component: 'tasks' }),
      instanceId: config.INSTANCE_ID,
      handlers: {
        gateway_disconnect: ctx.accounts.handleDisconnectTask,
        rate_limit_expiry: ctx.accounts.handleRateLimitExpiry,
      },
    });
    this.publisher = new WsPublisher({
      connectionString: config.DATABASE_URL,
      listener: this.listener,
      log: log.child({ component: 'ws-publisher' }),
    });
    this.delivery = new DeliveryService({
      pool,
      gateway: ctx.gateway,
      listener: this.listener,
      log: log.child({ component: 'delivery' }),
      instanceId: config.INSTANCE_ID,
      sendTimeoutMs: config.GATEWAY_SEND_TIMEOUT_MS,
    });
    this.hub = new WsHub({ pool, auth: ctx.auth, listener: this.listener, log: log.child({ component: 'ws' }) });
  }

  static async create(deps: CoreDeps): Promise<Runtime> {
    const ctx = createContext(deps);
    const app = await buildApp(ctx);
    return new Runtime(app, ctx);
  }

  async start(opts: { port: number; host?: string; workers?: WorkerSelection } = { port: 0 }): Promise<string> {
    const w = { ingest: true, inbox: true, tasks: true, publisher: true, delivery: true, ...opts.workers };
    await this.listener.start();
    await this.hub.start(this.app.server);
    const address = await this.app.listen({ port: opts.port, host: opts.host ?? '0.0.0.0' });
    const signal = this.abort.signal;
    const guard = (name: string, p: Promise<void>) =>
      p.catch((err) => this.ctx.log.error({ err, worker: name }, 'worker crashed'));
    if (w.ingest) this.running.push(guard('ingest', this.ingestor.run(signal)));
    if (w.inbox) this.running.push(guard('inbox', this.inbox.run(signal)));
    if (w.tasks) this.running.push(guard('tasks', this.tasks.run(signal)));
    if (w.publisher) this.running.push(guard('publisher', this.publisher.run(signal)));
    if (w.delivery) this.running.push(guard('delivery', this.delivery.run(signal)));
    return address;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.all(this.running);
    await this.hub.stop();
    await this.app.close();
    await this.listener.stop();
  }
}
