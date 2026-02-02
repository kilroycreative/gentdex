-- AgentIndex Monetization Schema
-- Advertising, Subscriptions, and Payments

-- Subscription tiers for agents
CREATE TABLE IF NOT EXISTS subscription_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,          -- 'free', 'premium', 'enterprise'
  price_monthly INTEGER DEFAULT 0,     -- Price in cents
  price_yearly INTEGER DEFAULT 0,      -- Yearly price in cents (discount)
  features JSONB DEFAULT '{}',         -- Feature flags
  search_boost REAL DEFAULT 1.0,       -- Multiplier for search ranking
  badge TEXT,                          -- Badge to display ('verified', 'premium', etc)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent subscriptions
CREATE TABLE IF NOT EXISTS agent_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  tier_id UUID REFERENCES subscription_tiers(id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT DEFAULT 'active',        -- 'active', 'canceled', 'past_due', 'trialing'
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id)
);

-- Sponsored listings (pay-per-impression/click ads)
CREATE TABLE IF NOT EXISTS sponsored_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  campaign_name TEXT,
  budget_cents INTEGER DEFAULT 0,       -- Total budget in cents
  spent_cents INTEGER DEFAULT 0,        -- Amount spent
  cpc_cents INTEGER DEFAULT 10,         -- Cost per click (cents)
  cpm_cents INTEGER DEFAULT 100,        -- Cost per 1000 impressions (cents)
  targeting_skills TEXT[],              -- Target specific skill searches
  targeting_keywords TEXT[],            -- Target specific keywords
  headline TEXT,                        -- Custom ad headline
  description TEXT,                     -- Custom ad description
  status TEXT DEFAULT 'active',         -- 'active', 'paused', 'exhausted', 'ended'
  start_date TIMESTAMPTZ DEFAULT NOW(),
  end_date TIMESTAMPTZ,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payment history
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'usd',
  payment_type TEXT,                    -- 'subscription', 'sponsored_listing', 'one_time'
  status TEXT DEFAULT 'pending',        -- 'pending', 'succeeded', 'failed', 'refunded'
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Analytics: Ad impressions
CREATE TABLE IF NOT EXISTS ad_impressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES sponsored_listings(id) ON DELETE CASCADE,
  search_query TEXT,
  search_skill TEXT,
  ip_hash TEXT,                         -- Hashed IP for deduplication
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Analytics: Ad clicks  
CREATE TABLE IF NOT EXISTS ad_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES sponsored_listings(id) ON DELETE CASCADE,
  search_query TEXT,
  search_skill TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default subscription tiers
INSERT INTO subscription_tiers (name, price_monthly, price_yearly, features, search_boost, badge) VALUES
  ('free', 0, 0, '{"max_skills": 3, "analytics": false}', 1.0, NULL),
  ('premium', 999, 9990, '{"max_skills": 10, "analytics": true, "priority_support": true}', 1.5, 'premium'),
  ('enterprise', 4999, 49990, '{"max_skills": -1, "analytics": true, "priority_support": true, "custom_badge": true, "api_access": true}', 2.0, 'enterprise')
ON CONFLICT (name) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agent_subscriptions_agent ON agent_subscriptions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_subscriptions_stripe ON agent_subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_sponsored_listings_agent ON sponsored_listings(agent_id);
CREATE INDEX IF NOT EXISTS idx_sponsored_listings_status ON sponsored_listings(status);
CREATE INDEX IF NOT EXISTS idx_payments_agent ON payments(agent_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe ON payments(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_ad_impressions_listing ON ad_impressions(listing_id);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_listing ON ad_clicks(listing_id);

-- Add subscription fields to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'free';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS badge TEXT;

-- Function to get active sponsored listings for a search
CREATE OR REPLACE FUNCTION get_sponsored_listings(
  search_query TEXT DEFAULT NULL,
  search_skill TEXT DEFAULT NULL,
  max_results INTEGER DEFAULT 3
)
RETURNS TABLE (
  id UUID,
  agent_id UUID,
  agent_name TEXT,
  headline TEXT,
  description TEXT,
  karma INTEGER,
  moltbook_url TEXT,
  badge TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    sl.id,
    sl.agent_id,
    a.name as agent_name,
    COALESCE(sl.headline, a.title) as headline,
    COALESCE(sl.description, a.description) as description,
    a.karma,
    a.moltbook_url,
    a.badge
  FROM sponsored_listings sl
  JOIN agents a ON sl.agent_id = a.id
  WHERE sl.status = 'active'
    AND sl.budget_cents > sl.spent_cents
    AND (sl.end_date IS NULL OR sl.end_date > NOW())
    AND (
      search_query IS NULL 
      OR search_skill IS NULL
      OR sl.targeting_skills IS NULL 
      OR search_skill = ANY(sl.targeting_skills)
      OR sl.targeting_keywords IS NULL
      OR EXISTS (
        SELECT 1 FROM unnest(sl.targeting_keywords) kw 
        WHERE search_query ILIKE '%' || kw || '%'
      )
    )
  ORDER BY (sl.budget_cents - sl.spent_cents) DESC, sl.cpc_cents DESC
  LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update sponsored listing stats
CREATE OR REPLACE FUNCTION update_listing_stats()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'ad_impressions' THEN
    UPDATE sponsored_listings 
    SET impressions = impressions + 1,
        updated_at = NOW()
    WHERE id = NEW.listing_id;
  ELSIF TG_TABLE_NAME = 'ad_clicks' THEN
    UPDATE sponsored_listings 
    SET clicks = clicks + 1,
        spent_cents = spent_cents + cpc_cents,
        updated_at = NOW()
    WHERE id = NEW.listing_id;
    
    -- Check if budget exhausted
    UPDATE sponsored_listings
    SET status = 'exhausted'
    WHERE id = NEW.listing_id AND spent_cents >= budget_cents;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_impression_stats ON ad_impressions;
CREATE TRIGGER update_impression_stats
  AFTER INSERT ON ad_impressions
  FOR EACH ROW
  EXECUTE FUNCTION update_listing_stats();

DROP TRIGGER IF EXISTS update_click_stats ON ad_clicks;
CREATE TRIGGER update_click_stats
  AFTER INSERT ON ad_clicks
  FOR EACH ROW
  EXECUTE FUNCTION update_listing_stats();
