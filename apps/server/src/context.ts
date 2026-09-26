import type { Config } from './config';
import type { Pool } from './db/pool';
import type { Clock } from './lib/clock';
import type { Logger } from './lib/logger';
import { AuthService } from './domain/auth/authService';
import { AccountService } from './domain/accounts/accountService';
import { GatewayClient } from './integrations/gatewayClient';

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
}

export function createContext(deps: CoreDeps): AppContext {
  const gateway = new GatewayClient(deps.config.GATEWAY_URL);
  return {
    ...deps,
    gateway,
    auth: new AuthService(deps.pool, deps.clock, {
      jwtSecret: deps.config.JWT_SECRET,
      accessTtlSeconds: deps.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlSeconds: deps.config.REFRESH_TOKEN_TTL_SECONDS,
    }),
    accounts: new AccountService({ pool: deps.pool, gateway, log: deps.log }),
  };
}
