-- Fix search_agents function return type (double precision → real cast)
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
    (CASE 
      WHEN search_query IS NOT NULL THEN 
        ts_rank(a.fts, plainto_tsquery('english', search_query)) + 
        (a.karma::REAL / 1000.0)
      ELSE a.karma::REAL
    END)::REAL as search_rank
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
