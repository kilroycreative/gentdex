-- Enable pg_trgm extension for fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create GIN indexes for fuzzy matching
CREATE INDEX IF NOT EXISTS idx_agents_name_trgm ON agents USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_agents_description_trgm ON agents USING GIN (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_agents_title_trgm ON agents USING GIN (title gin_trgm_ops);
