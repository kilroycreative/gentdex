-- Crypto Payment Support for AgentIndex
-- Supports: ETH, USDC (Base/Ethereum), BTC (on-chain + Lightning)

-- Supported cryptocurrencies and networks
CREATE TABLE IF NOT EXISTS crypto_networks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,                    -- 'ETH', 'USDC', 'BTC'
  network TEXT NOT NULL,                   -- 'base', 'ethereum', 'bitcoin', 'lightning'
  name TEXT NOT NULL,                      -- 'Ethereum on Base', 'USDC on Base', etc
  wallet_address TEXT,                     -- Receiving wallet address
  is_active BOOLEAN DEFAULT true,
  min_amount_usd REAL DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, network)
);

-- Crypto payment invoices
CREATE TABLE IF NOT EXISTS crypto_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  
  -- Payment details
  payment_type TEXT NOT NULL,              -- 'subscription', 'sponsored_listing', 'credits'
  amount_usd REAL NOT NULL,                -- Amount in USD
  amount_crypto REAL,                      -- Amount in crypto (calculated at creation)
  crypto_symbol TEXT NOT NULL,             -- 'ETH', 'USDC', 'BTC'
  crypto_network TEXT NOT NULL,            -- 'base', 'ethereum', 'bitcoin', 'lightning'
  
  -- Wallet info
  wallet_address TEXT NOT NULL,            -- Address to pay to
  lightning_invoice TEXT,                  -- For Lightning Network payments
  
  -- Status tracking
  status TEXT DEFAULT 'pending',           -- 'pending', 'confirming', 'completed', 'expired', 'failed'
  tx_hash TEXT,                            -- Transaction hash when paid
  confirmations INTEGER DEFAULT 0,
  
  -- Metadata
  metadata JSONB DEFAULT '{}',             -- listing_id, tier, etc
  expires_at TIMESTAMPTZ,                  -- Invoice expiration
  created_at TIMESTAMPTZ DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  
  -- Reference for easier lookup
  invoice_code TEXT UNIQUE DEFAULT encode(gen_random_bytes(8), 'hex')
);

-- Price quotes (cached exchange rates)
CREATE TABLE IF NOT EXISTS crypto_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  price_usd REAL NOT NULL,
  source TEXT DEFAULT 'coingecko',
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert supported networks (you'll update wallet addresses)
INSERT INTO crypto_networks (symbol, network, name, wallet_address, is_active) VALUES
  ('ETH', 'base', 'ETH on Base', NULL, false),
  ('USDC', 'base', 'USDC on Base', NULL, false),
  ('ETH', 'ethereum', 'ETH on Ethereum', NULL, false),
  ('USDC', 'ethereum', 'USDC on Ethereum', NULL, false),
  ('BTC', 'bitcoin', 'Bitcoin', NULL, false),
  ('BTC', 'lightning', 'Bitcoin Lightning', NULL, false)
ON CONFLICT (symbol, network) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_crypto_invoices_agent ON crypto_invoices(agent_id);
CREATE INDEX IF NOT EXISTS idx_crypto_invoices_status ON crypto_invoices(status);
CREATE INDEX IF NOT EXISTS idx_crypto_invoices_code ON crypto_invoices(invoice_code);
CREATE INDEX IF NOT EXISTS idx_crypto_prices_symbol ON crypto_prices(symbol);

-- Function to get active payment methods
CREATE OR REPLACE FUNCTION get_crypto_payment_methods()
RETURNS TABLE (
  symbol TEXT,
  network TEXT,
  name TEXT,
  wallet_address TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT cn.symbol, cn.network, cn.name, cn.wallet_address
  FROM crypto_networks cn
  WHERE cn.is_active = true AND cn.wallet_address IS NOT NULL
  ORDER BY cn.symbol, cn.network;
END;
$$ LANGUAGE plpgsql;
