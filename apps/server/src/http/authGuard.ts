import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthService } from '../domain/auth/authService';
import { forbidden, unauthorized } from './errors';

/** Endpoints reachable without an access token. */
const PUBLIC_ROUTES = new Set(['GET /api/health', 'POST /api/auth/login', 'POST /api/auth/refresh']);

/** Authenticated if a token is present, but usable without one (e.g. logging out with an expired token). */
const OPTIONAL_AUTH_ROUTES = new Set(['POST /api/auth/logout']);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

export function registerAuthGuard(app: FastifyInstance, auth: AuthService): void {
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    const key = `${req.method} ${path.replace(/\/+$/, '')}`;
    if (PUBLIC_ROUTES.has(key)) return;

    const token = bearerToken(req);
    if (OPTIONAL_AUTH_ROUTES.has(key)) {
      if (token) req.auth = await auth.authenticate(token).catch(() => undefined);
      return;
    }
    if (!token) throw unauthorized();
    req.auth = await auth.authenticate(token);
    if (!READ_METHODS.has(req.method) && req.auth.role !== 'admin') {
      throw forbidden('Read-only users cannot perform write operations');
    }
  });
}
