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
import { JobRunner } from './domain/jobs/jobRunner';
import { createGroupJob } from './domain/jobs/createGroupJob';
import { leaveAllJob } from './domain/jobs/leaveAllJob';
import { AgentRunner } from './domain/agent/agentRunner';
import { runDueStep } from './domain/sequences/sequenceEngine';

export interface WorkerSelection {
  ingest?: boolean;
  inbox?: boolean;
  tasks?: boolean;
  publisher?: boolean;
  delivery?: boolean;
  jobs?: boolean;
  agent?: boolean;
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
  readonly jobs: JobRunner;
  readonly agentRunner: AgentRunner;
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
        sequence_step: (task) => runDueStep(pool, task),
        media_download: ctx.media.handleDownloadTask,
        media_cleanup: ctx.media.handleCleanupTask,
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
    const jobDeps = { pool, gateway: ctx.gateway, log: log.child({ component: 'jobs' }) };
    this.jobs = new JobRunner({
      pool,
      listener: this.listener,
      log: log.child({ component: 'jobs' }),
      instanceId: config.INSTANCE_ID,
      impls: {
        create_group: createGroupJob({ ...jobDeps, joinTimeoutMs: config.JOIN_TIMEOUT_MS }),
        leave_all: leaveAllJob({ ...jobDeps, leaveEventTimeoutMs: config.JOIN_TIMEOUT_MS }),
      },
    });
    this.agentRunner = new AgentRunner({
      pool,
      agent: ctx.agent,
      gateway: ctx.gateway,
      listener: this.listener,
      log: log.child({ component: 'agent' }),
      instanceId: config.INSTANCE_ID,
      limits: {
        maxSteps: config.AGENT_MAX_STEPS,
        wallMs: config.AGENT_RUN_WALL_MS,
        turnTimeoutMs: config.AGENT_TURN_TIMEOUT_MS,
        auditTimeoutMs: config.AGENT_AUDIT_TIMEOUT_MS,
        auditAttempts: 3,
        sendWaitMs: config.AGENT_SEND_WAIT_MS,
        kickConvergeMs: 2_000,
      },
    });
    this.hub = new WsHub({ pool, auth: ctx.auth, listener: this.listener, log: log.child({ component: 'ws' }) });
  }

  static async create(deps: CoreDeps): Promise<Runtime> {
    const ctx = createContext(deps);
    const app = await buildApp(ctx);
    return new Runtime(app, ctx);
  }

  async start(opts: { port: number; host?: string; workers?: WorkerSelection } = { port: 0 }): Promise<string> {
    const w = { ingest: true, inbox: true, tasks: true, publisher: true, delivery: true, jobs: true, agent: true, ...opts.workers };
    await this.listener.start();
    await this.ctx.media.ensureCleanupScheduled();
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
    if (w.jobs) this.running.push(guard('jobs', this.jobs.run(signal)));
    if (w.agent) this.running.push(guard('agent', this.agentRunner.run(signal)));
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
