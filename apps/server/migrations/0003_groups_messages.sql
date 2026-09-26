CREATE TABLE groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_group_id   text UNIQUE,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unreachable', 'left')),
  creator_account_id text REFERENCES accounts(id),
  agent_enabled      boolean NOT NULL DEFAULT false,
  auto_kick_enabled  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Membership as seen through gateway events. Rows are never deleted: `present` flips, and
-- state_event_id makes join/leave events order-independent (the later event id wins).
CREATE TABLE group_members (
  group_id         uuid NOT NULL REFERENCES groups(id),
  platform_user_id text NOT NULL,
  account_id       text REFERENCES accounts(id),
  role             text NOT NULL DEFAULT 'member' CHECK (role IN ('creator', 'admin', 'member')),
  present          boolean NOT NULL,
  state_event_id   bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, platform_user_id)
);
CREATE INDEX group_members_account_idx ON group_members (account_id) WHERE present;

-- Inbound and outbound messages share one table, so each message is exactly one row.
CREATE TABLE messages (
  id                      bigserial PRIMARY KEY,
  group_id                uuid NOT NULL REFERENCES groups(id),
  msg_id                  text,
  client_msg_id           text UNIQUE,
  is_own                  boolean NOT NULL,
  -- Own message echoed back by the gateway before its message_sent was processed; hidden until merged.
  echo_pending            boolean NOT NULL DEFAULT false,
  sender_platform_user_id text,
  account_id              text REFERENCES accounts(id),
  text                    text NOT NULL,
  media_url               text,
  local_file_path         text,
  created_at              timestamptz NOT NULL,
  sent_at                 timestamptz,
  -- Timeline order: gateway sentAt once known, otherwise the time we accepted it. Millisecond precision.
  sort_ts                 timestamptz NOT NULL,
  -- Internal outbound phase (NULL for inbound); delivery_status is its externally visible projection.
  phase                   text CHECK (phase IN ('queued', 'dispatching', 'accepted', 'unknown', 'resending', 'sent', 'failed', 'cancelled')),
  delivery_status         text GENERATED ALWAYS AS (
                            CASE phase
                              WHEN 'dispatching' THEN 'queued'
                              WHEN 'resending' THEN 'unknown'
                              ELSE phase
                            END) STORED,
  fail_code               text,
  attempt                 smallint NOT NULL DEFAULT 0,
  dispatch_started_at     timestamptz,
  unknown_since           timestamptz,
  -- Earliest time a by-client-id 404 proves the message was not sent.
  confirm_after           timestamptz,
  next_attempt_at         timestamptz,
  lease_owner             text,
  lease_until             timestamptz,
  source                  text CHECK (source IN ('operator', 'agent', 'sequence')),
  agent_run_id            uuid,
  idempotency_key         text,
  sequence_run_step_id    bigint,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((phase IN ('failed', 'cancelled')) = (fail_code IS NOT NULL) OR phase IS NULL)
);
CREATE UNIQUE INDEX messages_group_msg_uidx ON messages (group_id, msg_id) WHERE msg_id IS NOT NULL;
CREATE UNIQUE INDEX messages_agent_key_uidx ON messages (agent_run_id, idempotency_key) WHERE agent_run_id IS NOT NULL;
CREATE INDEX messages_timeline_idx ON messages (group_id, sort_ts DESC, id DESC) WHERE NOT echo_pending;
CREATE INDEX messages_outbound_active_idx ON messages (account_id, id)
  WHERE phase IN ('queued', 'dispatching', 'unknown', 'resending');
CREATE INDEX messages_echo_idx ON messages (created_at) WHERE echo_pending;
