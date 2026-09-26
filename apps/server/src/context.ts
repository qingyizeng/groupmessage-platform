import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config';
import type { Pool } from './db/pool';
import type { Clock } from './lib/clock';
import type { Logger } from './lib/logger';
import { AuthService } from './domain/auth/authService';
import { AccountService } from './domain/accounts/accountService';
import { MessageService } from './domain/messages/messageService';
import { GroupService } from './domain/groups/groupService';
import { GatewayClient } from './integrations/gatewayClient';
import { MediaService } from './domain/media/mediaService';
import { AgentClient } from './domain/agent/agentClient';
import { activeAgentRuns, agentSettingsHook, agentTriggerHook, stopAgentForGroup } from './domain/agent/runRepo';
import { registerInboundMessageHook } from './domain/messages/inbound';
import { registerGroupUnreachableHook } from './domain/groups/groupRepo';
import { registerOutboundHook } from './domain/messages/outbound';
import { activeSequenceRuns, sequenceOutboundHook, stopSequencesForGroup } from './domain/sequences/sequenceEngine';

export interface CoreDeps {
  config: Config;
  pool: Pool;
  clock: Clock;
  log: Logger;
  schemaVersion: number;
}

export interface AppContext extends CoreDeps {
  auth: AuthService;
  gateway: GatewayClient;
  accounts: AccountService;
  messages: MessageService;
  groups: GroupService;
  agent: AgentClient;
  media: MediaService;
}

const DEFAULT_MEDIA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../media');

export function createContext(deps: CoreDeps): AppContext {
  const gateway = new GatewayClient(deps.config.GATEWAY_URL, { send: deps.config.GATEWAY_SEND_TIMEOUT_MS });
  // Module-level functions, so registering again (another runtime in the same process) is a no-op.
  registerInboundMessageHook(agentTriggerHook);
  registerGroupUnreachableHook(stopAgentForGroup);
  registerGroupUnreachableHook(stopSequencesForGroup);
  registerOutboundHook(sequenceOutboundHook);
  const groups = new GroupService({ pool: deps.pool });
  groups.onSettingsChanged(agentSettingsHook);
  groups.setActiveRunResolvers({ agent: activeAgentRuns, sequence: activeSequenceRuns });
  return {
    ...deps,
    gateway,
    auth: new AuthService(deps.pool, deps.clock, {
      jwtSecret: deps.config.JWT_SECRET,
      accessTtlSeconds: deps.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlSeconds: deps.config.REFRESH_TOKEN_TTL_SECONDS,
    }),
    accounts: new AccountService({ pool: deps.pool, gateway, log: deps.log }),
    messages: new MessageService({ pool: deps.pool }),
    groups,
    agent: new AgentClient(deps.config.AGENT_URL),
    media: new MediaService({
      pool: deps.pool,
      log: deps.log.child({ component: 'media' }),
      mediaDir: deps.config.MEDIA_DIR ?? DEFAULT_MEDIA_DIR,
      retentionDays: deps.config.MEDIA_RETENTION_DAYS,
      cleanupIntervalMs: deps.config.MEDIA_CLEANUP_INTERVAL_MS,
    }),
  };
}
