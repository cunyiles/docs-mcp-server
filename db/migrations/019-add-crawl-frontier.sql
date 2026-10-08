-- The crawl frontier of a version's running collection: every URL the run has
-- admitted, and whether it has been processed. A collection interrupted by a
-- restart or deploy resumes from the pending rows instead of starting over.
--
-- A run writes its frontier in the same database as its pages, so what is
-- marked processed is exactly what was stored. Rows are removed when the run
-- ends successfully and replaced when a new run starts.

-- @migration-step create crawl frontier
CREATE TABLE IF NOT EXISTS crawl_frontier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  item TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  UNIQUE(version_id, key)
);
