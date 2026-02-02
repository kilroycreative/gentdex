-- Agent Search Database Schema
-- Run this in Supabase SQL Editor

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- For fuzzy text search

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  karma INTEGER DEFAULT 0,
  title TEXT,
  description TEXT,
  platform TEXT DEFAULT 'unknown',
  languages TEXT[] DEFAULT ARRAY['english'],
  moltbook_url TEXT,
  introduced_at DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Skills table (normalized)
CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  agent_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent-Skills junction table
CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  skill_id UUID REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);

-- Index refresh tracking
CREATE TABLE IF NOT EXISTS index_refreshes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  agents_processed INTEGER DEFAULT 0,
  agents_added INTEGER DEFAULT 0,
  agents_updated INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  error TEXT
);

-- Indexes for fast search
CREATE INDEX IF NOT EXISTS idx_agents_name_trgm ON agents USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_agents_description_trgm ON agents USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_agents_karma ON agents(karma DESC);
CREATE INDEX IF NOT EXISTS idx_agents_platform ON agents(platform);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_skills_skill ON agent_skills(skill_id);

-- Full-text search index
ALTER TABLE agents ADD COLUMN IF NOT EXISTS fts tsvector 
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_agents_fts ON agents USING gin(fts);

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_updated_at ON agents;
CREATE TRIGGER agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Search function with ranking
CREATE OR REPLACE FUNCTION search_agents(
  search_query TEXT DEFAULT NULL,
  skill_filter TEXT DEFAULT NULL,
  platform_filter TEXT DEFAULT NULL,
  result_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  karma INTEGER,
  title TEXT,
  description TEXT,
  platform TEXT,
  languages TEXT[],
  moltbook_url TEXT,
  skills TEXT[],
  search_rank REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.id,
    a.name,
    a.karma,
    a.title,
    a.description,
    a.platform,
    a.languages,
    a.moltbook_url,
    ARRAY_AGG(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL) as skills,
    CASE 
      WHEN search_query IS NOT NULL THEN 
        ts_rank(a.fts, plainto_tsquery('english', search_query)) + 
        (a.karma::REAL / 1000)
      ELSE a.karma::REAL
    END as search_rank
  FROM agents a
  LEFT JOIN agent_skills ags ON a.id = ags.agent_id
  LEFT JOIN skills s ON ags.skill_id = s.id
  WHERE 
    (search_query IS NULL OR a.fts @@ plainto_tsquery('english', search_query))
    AND (platform_filter IS NULL OR a.platform = platform_filter)
    AND (skill_filter IS NULL OR EXISTS (
      SELECT 1 FROM agent_skills ags2 
      JOIN skills s2 ON ags2.skill_id = s2.id 
      WHERE ags2.agent_id = a.id AND s2.name = skill_filter
    ))
  GROUP BY a.id
  ORDER BY search_rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;

-- Get skill statistics
CREATE OR REPLACE FUNCTION get_skill_stats()
RETURNS TABLE (
  skill_name TEXT,
  agent_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT s.name, COUNT(ags.agent_id)::BIGINT
  FROM skills s
  LEFT JOIN agent_skills ags ON s.id = ags.skill_id
  GROUP BY s.id
  ORDER BY COUNT(ags.agent_id) DESC;
END;
$$ LANGUAGE plpgsql;

-- RLS Policies (enable for production)
-- ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Public read access" ON agents FOR SELECT USING (true);
