-- Add quality_score column to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS quality_score INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_agents_quality_score ON agents(quality_score DESC);

-- Update default ordering to use quality_score
COMMENT ON COLUMN agents.quality_score IS 'Computed quality score 0-100: description quality + stars + karma + platform signal + penalties';
