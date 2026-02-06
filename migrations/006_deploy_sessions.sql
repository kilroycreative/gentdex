-- Deploy sessions and transactions for GentDex Agent Launchpad

CREATE TABLE IF NOT EXISTS deploy_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_wallet TEXT NOT NULL,
  strategy_type TEXT NOT NULL,
  strategy_config JSONB NOT NULL DEFAULT '{}',
  escrow_address TEXT,
  bot_pubkey TEXT,
  vm_id TEXT,
  telegram_bot_token TEXT,
  deposit_amount DECIMAL(20, 9),
  fee_amount DECIMAL(20, 9),
  trading_balance DECIMAL(20, 9),
  duration_days INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  funded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ
);

CREATE INDEX idx_deploy_sessions_user ON deploy_sessions(user_wallet);
CREATE INDEX idx_deploy_sessions_status ON deploy_sessions(status);

CREATE TABLE IF NOT EXISTS deploy_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES deploy_sessions(id) ON DELETE CASCADE,
  tx_signature TEXT NOT NULL,
  tx_type TEXT NOT NULL,
  token_in TEXT,
  token_out TEXT,
  amount_in DECIMAL(20, 9),
  amount_out DECIMAL(20, 9),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deploy_tx_session ON deploy_transactions(session_id);

-- RLS policies
ALTER TABLE deploy_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deploy_transactions ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "Service role full access" ON deploy_sessions FOR ALL USING (true);
CREATE POLICY "Service role full access" ON deploy_transactions FOR ALL USING (true);
