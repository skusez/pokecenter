-- Everything that happens to a report, oldest first: arrival, each triage
-- verdict, the owner's notes, every step the investigator takes, the result.
-- Telegram cards and the web thread are both views over this table.
CREATE TABLE IF NOT EXISTS event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS event_report_idx ON event (report_id, id);

INSERT INTO event (report_id, kind, body, created_at)
  SELECT report_id, 'note', json_object('text', text, 'via', 'telegram'), created_at FROM note ORDER BY id;

DROP TABLE note;

-- Reports that predate the log get an arrival event so their threads open.
INSERT INTO event (report_id, kind, body, created_at)
  SELECT id, 'received', '{}', received_at FROM report;
