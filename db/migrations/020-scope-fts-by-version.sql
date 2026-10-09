-- Full-text search filters by version inside the index.
--
-- A search runs in one version, but the full-text index holds every library.
-- Filtering by version through a join meant reading the documents row of every
-- match in every library, so a search in one library slowed down with the size
-- of all others. The `scope` column holds one token per version (`v<id>`), so
-- the index intersects a query with its version before anything is joined.

-- @migration-step replace fts schema
DROP TRIGGER IF EXISTS documents_fts_after_delete;
DROP TRIGGER IF EXISTS documents_fts_after_update;
DROP TRIGGER IF EXISTS documents_fts_after_insert;
DROP TABLE IF EXISTS documents_fts;

CREATE VIRTUAL TABLE documents_fts USING fts5(
  content,
  title,
  url,
  path,
  scope,
  tokenize='porter unicode61'
);

-- @migration-step recreate fts triggers
CREATE TRIGGER documents_fts_after_delete AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = old.id;
END;

CREATE TRIGGER documents_fts_after_update AFTER UPDATE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = old.id;
  INSERT INTO documents_fts(rowid, content, title, url, path, scope)
  SELECT new.id, new.content, p.title, p.url, json_extract(new.metadata, '$.path'), 'v' || p.version_id
  FROM pages p WHERE p.id = new.page_id;
END;

CREATE TRIGGER documents_fts_after_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, content, title, url, path, scope)
  SELECT new.id, new.content, p.title, p.url, json_extract(new.metadata, '$.path'), 'v' || p.version_id
  FROM pages p WHERE p.id = new.page_id;
END;

-- @migration-step rebuild fts index
INSERT INTO documents_fts(rowid, content, title, url, path, scope)
SELECT d.id, d.content, p.title, p.url, json_extract(d.metadata, '$.path'), 'v' || p.version_id
FROM documents d
JOIN pages p ON d.page_id = p.id;
