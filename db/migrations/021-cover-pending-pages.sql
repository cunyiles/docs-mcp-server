-- The embedding backlog index answers "which pages still wait" by itself.
--
-- Library status counts the pages that still wait for embeddings. With only
-- the chunk id in the index, that count read every waiting chunk's row, content
-- included, and every search pays it for its health note. The index now holds
-- the page id, and the embedding column too: it is NULL in every entry, so it
-- costs nothing, and it lets SQLite check the index condition without the row.
-- The backlog still walks the index by id.

-- @migration-step cover the page in the embedding backlog index
DROP INDEX IF EXISTS idx_documents_embedding_pending;
CREATE INDEX idx_documents_embedding_pending ON documents(id, page_id, embedding) WHERE embedding IS NULL;
