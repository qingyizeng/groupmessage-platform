export type UserRole = 'admin' | 'viewer';

export interface LoginResponse {
  accessToken: string;
}

export interface HealthResponse {
  ok: boolean;
  schemaVersion: number;
}
