CREATE TABLE agent_runs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id                    uuid NOT NULL REFERENCES groups(id),
  status                      text NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'finished', 'failed', 'blocked', 'cancelled')),
  end_reason                  text CHECK (end_reason IN ('final', 'budget_exhausted', 'wall_clock', 'protocol_errors', 'audit_blocked', 'cancelled')),
  summary                     text,
  trigger_messages            jsonb NOT NULL,
  step_count                  int NOT NULL DEFAULT 0,
  consecutive_protocol_errors int NOT NULL DEFAULT 0,
  -- Wall-clock time consumed so far, checkpointed while running; downtime is never added.
  elapsed_ms                  int NOT NULL DEFAULT 0,
  cancel_requested            boolean NOT NULL DEFAULT false,
  lease_owner                 text,
  lease_until                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  finished_at                 timestamptz,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'running') = (end_reason IS NULL))
);
-- At most one running run per group, across all server instances.
CREATE UNIQUE INDEX agent_runs_one_running_idx ON agent_runs (group_id) WHERE status = 'running';
CREATE INDEX agent_runs_group_idx ON agent_runs (group_id, created_at DESC);

-- The conversation sent to /agent/turn, append-only.
CREATE TABLE agent_run_messages (
  run_id  uuid NOT NULL REFERENCES agent_runs(id),
  idx     int NOT NULL,
  role    text NOT NULL CHECK (role IN ('user', 'assistant')),
  content jsonb NOT NULL,
  PRIMARY KEY (run_id, idx)
);

CREATE TABLE agent_run_steps (
  run_id         uuid NOT NULL REFERENCES agent_runs(id),
  seq            int NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('tool_use', 'final', 'protocol_error')),
  tool_use_id    text,
  name           text,
  input          jsonb,
  result_summary text,
  is_error       boolean NOT NULL DEFAULT false,
  error_code     text,
  audit_verdict  text,
  raw_response   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq),
  CHECK (NOT is_error OR error_code IS NOT NULL)
);
CREATE UNIQUE INDEX agent_run_steps_tool_use_idx ON agent_run_steps (run_id, tool_use_id) WHERE tool_use_id IS NOT NULL;

-- Effect journal: one row per executed tool call; resumed after a crash from its phase.
CREATE TABLE agent_tool_calls (
  run_id              uuid NOT NULL REFERENCES agent_runs(id),
  tool_use_id         text NOT NULL,
  step_seq            int NOT NULL,
  name                text NOT NULL,
  input               jsonb NOT NULL,
  phase               text NOT NULL DEFAULT 'pending' CHECK (phase IN ('pending', 'executing', 'done')),
  audit_attempts      int NOT NULL DEFAULT 0,
  audit_verdict       text,
  outbound_message_id bigint REFERENCES messages(id),
  exec_account_id     text,
  exec_started_at     timestamptz,
  result              jsonb,
  PRIMARY KEY (run_id, tool_use_id)
);

-- Non-own messages waiting for (or consumed by) an agent run. Keyed by message, so a duplicated
-- gateway event can never trigger twice.
CREATE TABLE agent_triggers (
  message_id bigint PRIMARY KEY REFERENCES messages(id),
  group_id   uuid NOT NULL REFERENCES groups(id),
  run_id     uuid REFERENCES agent_runs(id),
  discarded  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_triggers_pending_idx ON agent_triggers (group_id) WHERE run_id IS NULL AND NOT discarded;
