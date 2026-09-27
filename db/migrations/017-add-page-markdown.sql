-- Keeps each page's clean Markdown whole, beside its chunks.
--
-- Chunks are a derived form: a new chunking rule or embedding model re-runs
-- from the stored Markdown without fetching the page again. Rows written before
-- this column existed stay NULL until their page is next collected.
--
-- Chunks without a vector form the embedding backlog. The partial index keeps
-- finding the next batch cheap however large the embedded part grows.

-- @migration-step add markdown to pages
ALTER TABLE pages ADD COLUMN markdown TEXT DEFAULT NULL;

-- @migration-step index the embedding backlog
CREATE INDEX IF NOT EXISTS idx_documents_embedding_pending ON documents(id) WHERE embedding IS NULL;
