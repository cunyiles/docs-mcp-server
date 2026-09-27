-- Records how the last collection and the last refresh of a version ended,
-- separately, so a refresh that failed after a good collection is visible as
-- such instead of overwriting it.
--
-- collection_stats holds what the last run observed about the site as JSON
-- (pages per witness, hosts that refused us, browser use). It is replaced by
-- every run and read only for display.

-- @migration-step add run history to versions
ALTER TABLE versions ADD COLUMN last_collection_at DATETIME DEFAULT NULL;
ALTER TABLE versions ADD COLUMN last_collection_status TEXT DEFAULT NULL;
ALTER TABLE versions ADD COLUMN last_collection_error TEXT DEFAULT NULL;
ALTER TABLE versions ADD COLUMN last_refresh_at DATETIME DEFAULT NULL;
ALTER TABLE versions ADD COLUMN last_refresh_status TEXT DEFAULT NULL;
ALTER TABLE versions ADD COLUMN last_refresh_error TEXT DEFAULT NULL;
ALTER TABLE versions ADD COLUMN collection_stats TEXT DEFAULT NULL;
