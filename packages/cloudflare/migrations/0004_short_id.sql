ALTER TABLE report ADD COLUMN short_id TEXT;

UPDATE report SET short_id = lower(hex(randomblob(4))) WHERE short_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS report_short_id_idx ON report (short_id);
