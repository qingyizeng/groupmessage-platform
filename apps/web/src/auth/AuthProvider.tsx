import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MeDto } from '@gmp/shared';
import { api, http } from '../api/client';

interface AuthState {
  user: MeDto | null;
  /** True until the silent session restore on page load has finished. */
  restoring: boolean;
  canWrite: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeDto | null>(null);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    // The access token lives only in memory; after a reload the HttpOnly refresh cookie restores the session.
    let cancelled = false;
    (async () => {
      try {
        if (await http.refresh()) {
          const me = await api.me();
          if (!cancelled) setUser(me);
        }
      } catch {
        /* not logged in */
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    const off = http.onToken((token) => {
      if (!token) setUser(null);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    await http.login(username, password);
    setUser(await api.me());
  }, []);

  const logout = useCallback(async () => {
    await http.logout().catch(() => undefined);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, restoring, canWrite: user?.role === 'admin', login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
