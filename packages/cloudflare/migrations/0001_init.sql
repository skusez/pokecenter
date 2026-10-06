CREATE TABLE IF NOT EXISTS report (
  id          TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  from_addr   TEXT NOT NULL,
  reply_to    TEXT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  forwarded   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,
  verdict     TEXT,
  reason      TEXT,
  product     TEXT,
  severity    TEXT,
  outcome     TEXT,
  branch      TEXT,
  pr_url      TEXT,
  findings    TEXT,
  tg_message  INTEGER,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS report_status_idx ON report (status, received_at);
