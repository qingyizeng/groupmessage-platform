CREATE TABLE accounts (
  id                 text PRIMARY KEY,
  status             text NOT NULL DEFAULT 'idle'
                     CHECK (status IN ('idle', 'online', 'rate_limited', 'disconnected', 'suspended', 'session_expired')),
  platform_user_id   text UNIQUE,
  rate_limited_until timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO accounts (id)
SELECT 'acc_' || lpad(n::text, 2, '0') FROM generate_series(1, 8) AS n
ON CONFLICT (id) DO NOTHING;

-- Inbox of raw gateway events. event_id is the gateway's global id, so duplicates are absorbed here.
-- The frame is stored as raw bytes so that no payload content can make this insert fail.
CREATE TABLE gateway_events (
  event_id        bigint PRIMARY KEY,
  type            text NOT NULL,
  raw             bytea NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX gateway_events_pending_idx ON gateway_events (next_attempt_at, event_id) WHERE status = 'pending';

CREATE TABLE kv (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Durable timers. (kind, ref) is unique so re-scheduling replaces the pending run; version detects
-- a reschedule that happened while a worker was executing the previous one.
CREATE TABLE scheduled_tasks (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  ref         text NOT NULL,
  run_at      timestamptz NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  version     int NOT NULL DEFAULT 1,
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  lease_owner text,
  lease_until timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref)
);
CREATE INDEX scheduled_tasks_due_idx ON scheduled_tasks (run_at);

-- Transactional outbox for WebSocket events. seq is assigned after commit by a single publisher,
-- so the delivered sequence is gap-free and never skips an event that commits late.
CREATE TABLE ws_outbox (
  id           bigserial PRIMARY KEY,
  seq          bigint UNIQUE,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX ws_outbox_unpublished_idx ON ws_outbox (id) WHERE seq IS NULL;

CREATE TABLE ws_seq_state (
  id       int PRIMARY KEY CHECK (id = 1),
  last_seq bigint NOT NULL
);
INSERT INTO ws_seq_state (id, last_seq) VALUES (1, 0);
