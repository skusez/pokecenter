-- The email rewritten as a fixed template by the screening model, so the
-- thread opens on the report rather than on signatures and forward headers.
-- The original body is kept untouched alongside it.
ALTER TABLE report ADD COLUMN digest TEXT;

-- Archived threads leave the list; nothing else about them changes.
ALTER TABLE report ADD COLUMN archived_at TEXT;
