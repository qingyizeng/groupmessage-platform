import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { LoginResponse } from '@gmp/shared';
import type { AppContext } from '../app';
import type { IssuedTokens } from '../../domain/auth/authService';

export const REFRESH_COOKIE = 'rt';
const COOKIE_PATH = '/api/auth';

const loginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const authRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const setRefreshCookie = (reply: FastifyReply, tokens: IssuedTokens) =>
      reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
        httpOnly: true,
        sameSite: 'strict',
        secure: ctx.config.COOKIE_SECURE,
        path: COOKIE_PATH,
        expires: tokens.refreshExpiresAt,
      });

    app.post('/login', async (req, reply): Promise<LoginResponse> => {
      const { username, password } = loginBody.parse(req.body);
      const tokens = await ctx.auth.login(username, password);
      setRefreshCookie(reply, tokens);
      return { accessToken: tokens.accessToken };
    });

    app.post('/refresh', async (req, reply): Promise<LoginResponse> => {
      try {
        const tokens = await ctx.auth.refresh(req.cookies[REFRESH_COOKIE]);
        setRefreshCookie(reply, tokens);
        return { accessToken: tokens.accessToken };
      } catch (err) {
        reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
        throw err;
      }
    });

    app.post('/logout', async (req, reply) => {
      await ctx.auth.logout(req.auth, req.cookies[REFRESH_COOKIE]);
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      return { ok: true };
    });

    app.get('/me', async (req) => {
      const auth = req.auth!;
      return { username: auth.username, role: auth.role };
    });
  };
