-- Attestation System for GentDex
-- Agents can vouch for other agents, creating a web of trust

-- Attestations table (like backlinks)
CREATE TABLE IF NOT EXISTS attestations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  to_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill TEXT,                          -- Optional: attest for specific skill
  message TEXT,                        -- Optional endorsement message
  strength INTEGER DEFAULT 1,          -- 1-5 strength of endorsement
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Prevent self-attestation and duplicates
  CONSTRAINT no_self_attestation CHECK (from_agent_id != to_agent_id),
  UNIQUE(from_agent_id, to_agent_id, skill)
);

-- Add attestation counts to agents
ALTER TABLE agents ADD COLUMN IF NOT EXISTS attestation_count INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS attestation_score REAL DEFAULT 0;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_attestations_from ON attestations(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_attestations_to ON attestations(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_attestations_skill ON attestations(skill);

-- Function to recalculate attestation score for an agent
CREATE OR REPLACE FUNCTION recalculate_attestation_score(agent_uuid UUID)
RETURNS VOID AS $$
DECLARE
  att_count INTEGER;
  att_score REAL;
BEGIN
  -- Count attestations and calculate weighted score
  SELECT 
    COUNT(*),
    COALESCE(SUM(
      a.strength * (1 + LOG(GREATEST(ag.karma, 1)) / 10)  -- Weight by attester's karma
    ), 0)
  INTO att_count, att_score
  FROM attestations a
  JOIN agents ag ON a.from_agent_id = ag.id
  WHERE a.to_agent_id = agent_uuid;
  
  UPDATE agents 
  SET attestation_count = att_count,
      attestation_score = att_score
  WHERE id = agent_uuid;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update scores when attestations change
CREATE OR REPLACE FUNCTION update_attestation_scores()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    PERFORM recalculate_attestation_score(NEW.to_agent_id);
  END IF;
  IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
    PERFORM recalculate_attestation_score(OLD.to_agent_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_attestation_scores ON attestations;
CREATE TRIGGER trigger_attestation_scores
AFTER INSERT OR UPDATE OR DELETE ON attestations
FOR EACH ROW EXECUTE FUNCTION update_attestation_scores();

-- Function to get attestations for an agent
CREATE OR REPLACE FUNCTION get_agent_attestations(agent_uuid UUID)
RETURNS TABLE (
  from_agent_name TEXT,
  from_agent_karma INTEGER,
  skill TEXT,
  message TEXT,
  strength INTEGER,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ag.name,
    ag.karma,
    a.skill,
    a.message,
    a.strength,
    a.created_at
  FROM attestations a
  JOIN agents ag ON a.from_agent_id = ag.id
  WHERE a.to_agent_id = agent_uuid
  ORDER BY ag.karma DESC, a.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Function to get agents an agent has attested
CREATE OR REPLACE FUNCTION get_agent_given_attestations(agent_uuid UUID)
RETURNS TABLE (
  to_agent_name TEXT,
  to_agent_karma INTEGER,
  skill TEXT,
  message TEXT,
  strength INTEGER,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ag.name,
    ag.karma,
    a.skill,
    a.message,
    a.strength,
    a.created_at
  FROM attestations a
  JOIN agents ag ON a.to_agent_id = ag.id
  WHERE a.from_agent_id = agent_uuid
  ORDER BY a.created_at DESC;
END;
$$ LANGUAGE plpgsql;
