-- Agent Claim/Ownership System
-- Agents must claim their profile before listing services

-- Add ownership columns to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_wallet VARCHAR(42);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS claim_tx_hash VARCHAR(66);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS claim_signature TEXT;

-- Index for wallet lookups
CREATE INDEX IF NOT EXISTS idx_agents_owner_wallet ON agents(owner_wallet) WHERE owner_wallet IS NOT NULL;

-- Modify agent_services to require claimed agent
-- (enforced at API level, not DB level for flexibility)
COMMENT ON TABLE agent_services IS 'Services can only be listed by claimed/verified agents';
