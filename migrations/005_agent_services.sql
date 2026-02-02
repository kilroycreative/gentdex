-- Agent Services Marketplace
CREATE TABLE IF NOT EXISTS agent_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  price_usdc DECIMAL(12, 6) NOT NULL,
  price_model VARCHAR(20) DEFAULT 'per_call',
  payment_wallet VARCHAR(42),
  payment_network VARCHAR(20) DEFAULT 'base',
  api_endpoint VARCHAR(500),
  api_docs_url VARCHAR(500),
  is_active BOOLEAN DEFAULT true,
  is_verified BOOLEAN DEFAULT false,
  total_jobs INTEGER DEFAULT 0,
  total_revenue_usdc DECIMAL(12, 6) DEFAULT 0,
  avg_rating DECIMAL(3, 2),
  rating_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES agent_services(id) ON DELETE CASCADE,
  reviewer_wallet VARCHAR(42) NOT NULL,
  reviewer_agent_id UUID REFERENCES agents(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  payment_tx_hash VARCHAR(66),
  payment_amount DECIMAL(12, 6),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_categories (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  icon VARCHAR(10)
);

INSERT INTO service_categories (id, name, description, icon) VALUES
  ('research', 'Research & Analysis', 'Market research, data analysis, due diligence', '🔍'),
  ('trading', 'Trading & Signals', 'Trading execution, alpha signals, portfolio management', '📈'),
  ('creative', 'Creative & Content', 'Writing, art generation, video, music', '🎨'),
  ('automation', 'Automation & Bots', 'Task automation, workflows, integrations', '🤖'),
  ('dev', 'Development & Code', 'Smart contracts, APIs, debugging', '💻'),
  ('data', 'Data & Oracles', 'Data feeds, price oracles, verification', '📊'),
  ('social', 'Social & Marketing', 'Community management, engagement, growth', '📣'),
  ('security', 'Security & Audit', 'Code audits, threat detection, monitoring', '🔒'),
  ('infra', 'Infrastructure', 'Hosting, indexing, node services', '🏗️'),
  ('other', 'Other Services', 'Miscellaneous agent services', '✨')
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_services_agent ON agent_services(agent_id);
CREATE INDEX IF NOT EXISTS idx_services_category ON agent_services(category);
CREATE INDEX IF NOT EXISTS idx_services_active ON agent_services(is_active) WHERE is_active = true;
