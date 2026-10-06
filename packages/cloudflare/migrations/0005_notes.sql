-- Instructions sent by replying to a report's Telegram card. Only messages from
-- TELEGRAM_CHAT_ID land here, so unlike the email body they are trusted.
CREATE TABLE IF NOT EXISTS note (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS note_report_idx ON note (report_id, id);
