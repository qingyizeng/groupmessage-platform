-- C1: local copies of message media. local_file_path is relative to MEDIA_DIR and is only set
-- while the file exists (it is cleared before the file is deleted).
ALTER TABLE messages
  ADD COLUMN media_status text CHECK (media_status IN ('pending', 'downloaded', 'expired', 'failed', 'deleted')),
  ADD COLUMN media_downloaded_at timestamptz,
  ADD COLUMN media_attempts int NOT NULL DEFAULT 0;

CREATE INDEX messages_media_cleanup_idx ON messages (media_downloaded_at) WHERE media_status = 'downloaded';
CREATE INDEX messages_local_file_idx ON messages (local_file_path) WHERE local_file_path IS NOT NULL;
