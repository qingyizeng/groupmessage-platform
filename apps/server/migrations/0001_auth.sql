CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One session per login. Revoking it invalidates every access and refresh token issued under it.
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id)
);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);

CREATE TABLE revoked_access_tokens (
  jti        uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

INSERT INTO users (username, password_hash, role) VALUES
  ('admin',  crypt('admin',  gen_salt('bf', 10)), 'admin'),
  ('viewer', crypt('viewer', gen_salt('bf', 10)), 'viewer')
ON CONFLICT (username) DO NOTHING;
