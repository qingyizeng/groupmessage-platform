CREATE TABLE sequences (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  steps      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id           uuid NOT NULL REFERENCES groups(id),
  sequence_id        uuid NOT NULL REFERENCES sequences(id),
  status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed', 'stopped')),
  current_step_index int,
  vars               jsonb NOT NULL,
  step_vars          jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- At most one running sequence per group; concurrent starts race on this index.
CREATE UNIQUE INDEX sequence_runs_one_running_idx ON sequence_runs (group_id) WHERE status = 'running';
CREATE INDEX sequence_runs_group_idx ON sequence_runs (group_id, created_at DESC);

CREATE TABLE sequence_run_steps (
  id             bigserial PRIMARY KEY,
  run_id         uuid NOT NULL REFERENCES sequence_runs(id),
  index          int NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'sent', 'skipped', 'failed')),
  account_role   text NOT NULL,
  text_template  text NOT NULL,
  text           text NOT NULL,
  delay_seconds  numeric NOT NULL,
  resolved_vars  jsonb NOT NULL,
  var_sources    jsonb NOT NULL,
  -- Only the current step of a running sequence has a schedule.
  scheduled_at   timestamptz,
  sent_at        timestamptz,
  skipped_at     timestamptz,
  account_id     text,
  client_msg_id  text,
  message_id     bigint REFERENCES messages(id),
  fail_code      text,
  UNIQUE (run_id, index)
);
