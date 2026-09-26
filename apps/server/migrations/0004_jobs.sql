-- Long-running, resumable operations (group creation, leave-all). `state` is the job's checkpoint;
-- a runner holding the lease advances it, and after a crash another runner resumes from it.
CREATE TABLE jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL CHECK (type IN ('create_group', 'leave_all')),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed')),
  group_id    uuid REFERENCES groups(id),
  input       jsonb NOT NULL,
  state       jsonb NOT NULL DEFAULT '{}',
  errors      jsonb NOT NULL DEFAULT '[]',
  next_run_at timestamptz NOT NULL DEFAULT now(),
  attempts    int NOT NULL DEFAULT 0,
  lease_owner text,
  lease_until timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_runnable_idx ON jobs (next_run_at) WHERE status = 'running';
-- At most one leave-all in progress per group.
CREATE UNIQUE INDEX jobs_one_leave_all_idx ON jobs (group_id) WHERE type = 'leave_all' AND status = 'running';
