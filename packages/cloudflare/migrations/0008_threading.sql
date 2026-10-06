-- The client's own Message-Id (the inner message when forwarded as an
-- attachment). A reply from the sender references this, not the id of
-- the forward, so it is what a follow-up is matched on.
ALTER TABLE report ADD COLUMN origin_id TEXT;

CREATE INDEX IF NOT EXISTS report_origin_idx ON report (origin_id);
CREATE INDEX IF NOT EXISTS report_from_idx ON report (from_addr, received_at);
