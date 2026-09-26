import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { UserRole } from '@gmp/shared';
import type { Pool, Queryable } from '../../db/pool';
import { withTx } from '../../db/tx';
import type { Clock } from '../../lib/clock';
import { unauthorized } from '../../http/errors';

export interface AuthContext {
  userId: string;
  username: string;
  role: UserRole;
  sessionId: string;
  jti: string;
  expiresAt: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface AuthServiceOptions {
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export class AuthService {
  private readonly key: Uint8Array;

  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly opts: AuthServiceOptions,
  ) {
    this.key = new TextEncoder().encode(opts.jwtSecret);
  }

  async login(username: string, password: string): Promise<IssuedTokens> {
    const { rows } = await this.pool.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE username = $1',
      [username],
    );
    const user = rows[0];
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw unauthorized('Invalid username or password');

    return withTx(this.pool, async (tx) => {
      const session = await tx.query<{ id: string }>('INSERT INTO sessions (user_id) VALUES ($1) RETURNING id', [
        user.id,
      ]);
      const sessionId = session.rows[0]!.id;
      const refresh = await this.insertRefreshToken(tx, sessionId);
      const accessToken = await this.signAccessToken(user.id, sessionId);
      return { accessToken, ...refresh };
    });
  }

  /**
   * Rotates a refresh token. Presenting a token that was already used is treated as theft:
   * the whole session is revoked, which invalidates every token issued under it.
   */
  async refresh(rawToken: string | undefined): Promise<IssuedTokens> {
    if (!rawToken) throw unauthorized('Missing refresh token');
    const outcome = await withTx(this.pool, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        session_id: string;
        user_id: string;
        used_at: Date | null;
        expires_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT rt.id, rt.session_id, s.user_id, rt.used_at, rt.expires_at, s.revoked_at
           FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id
          WHERE rt.token_hash = $1
          FOR UPDATE OF rt, s`,
        [hashToken(rawToken)],
      );
      const row = rows[0];
      if (!row) return { kind: 'invalid' as const };
      if (row.revoked_at) return { kind: 'invalid' as const };
      if (row.used_at) {
        await tx.query(
          `UPDATE sessions SET revoked_at = now(), revoke_reason = 'refresh_token_reuse' WHERE id = $1`,
          [row.session_id],
        );
        return { kind: 'reused' as const };
      }
      if (row.expires_at.getTime() <= this.clock.now()) return { kind: 'invalid' as const };

      const next = await this.insertRefreshToken(tx, row.session_id);
      await tx.query('UPDATE refresh_tokens SET used_at = now(), replaced_by = $2 WHERE id = $1', [
        row.id,
        next.id,
      ]);
      const accessToken = await this.signAccessToken(row.user_id, row.session_id);
      return { kind: 'ok' as const, tokens: { accessToken, refreshToken: next.refreshToken, refreshExpiresAt: next.refreshExpiresAt } };
    });
    if (outcome.kind === 'reused') throw unauthorized('Refresh token reuse detected; session revoked');
    if (outcome.kind === 'invalid') throw unauthorized('Invalid or expired refresh token');
    return outcome.tokens;
  }

  async logout(auth: AuthContext | undefined, rawRefresh: string | undefined): Promise<void> {
    await withTx(this.pool, async (tx) => {
      if (auth) {
        await tx.query(
          'INSERT INTO revoked_access_tokens (jti, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT DO NOTHING',
          [auth.jti, auth.expiresAt],
        );
        await tx.query(
          `UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`,
          [auth.sessionId],
        );
      }
      if (rawRefresh) {
        await tx.query(
          `UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout'
            WHERE revoked_at IS NULL
              AND id = (SELECT session_id FROM refresh_tokens WHERE token_hash = $1)`,
          [hashToken(rawRefresh)],
        );
      }
    });
  }

  /** Verifies signature and expiry, then checks revocation in the database so logout takes effect immediately. */
  async authenticate(token: string): Promise<AuthContext> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        currentDate: new Date(this.clock.now()),
      }));
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw unauthorized('Access token expired');
      throw unauthorized('Invalid access token');
    }
    const { sub, sid, jti, exp } = payload as { sub?: string; sid?: string; jti?: string; exp?: number };
    if (!sub || !sid || !jti || !exp) throw unauthorized('Invalid access token');

    const { rows } = await this.pool.query<{ username: string; role: UserRole; revoked: boolean }>(
      `SELECT u.username, u.role,
              (s.revoked_at IS NOT NULL OR EXISTS (SELECT 1 FROM revoked_access_tokens r WHERE r.jti = $3)) AS revoked
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $2 AND u.id = $1`,
      [sub, sid, jti],
    );
    const row = rows[0];
    if (!row || row.revoked) throw unauthorized('Session is no longer valid');
    return { userId: sub, username: row.username, role: row.role, sessionId: sid, jti, expiresAt: exp };
  }

  async purgeExpiredRevocations(): Promise<void> {
    await this.pool.query('DELETE FROM revoked_access_tokens WHERE expires_at < now()');
  }

  private async signAccessToken(userId: string, sessionId: string): Promise<string> {
    const nowSec = Math.floor(this.clock.now() / 1000);
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + this.opts.accessTtlSeconds)
      .sign(this.key);
  }

  private async insertRefreshToken(
    tx: Queryable,
    sessionId: string,
  ): Promise<{ id: string; refreshToken: string; refreshExpiresAt: Date }> {
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(this.clock.now() + this.opts.refreshTtlSeconds * 1000);
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id',
      [sessionId, hashToken(refreshToken), refreshExpiresAt],
    );
    return { id: rows[0]!.id, refreshToken, refreshExpiresAt };
  }
}
