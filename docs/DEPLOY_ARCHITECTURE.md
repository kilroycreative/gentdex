# GentDex Deploy — Architecture Spec

## Overview
One-click deployment of on-chain trading agents from GentDex, powered by smart contract escrow (non-custodial) and x402 compute billing.

## Fee Model
- **2.5% setup fee** on initial deposit (taken from deposit, remainder goes to trading vault)
- **Compute fee**: 0.01 SOL/day runtime (paid via x402 or deducted from vault)
- Example: User deposits 5 SOL → 0.125 SOL fee → 4.875 SOL trading balance → 0.01 SOL/day

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  gentdex.com/deploy                  │
│                                                     │
│  1. Pick strategy (copy wallet / grid / DCA)        │
│  2. Select duration (1d / 7d / 30d)                 │
│  3. See recommended balance + fees                  │
│  4. Click "Deploy"                                  │
└───────────────┬─────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────┐
│              GentDex Deploy API                      │
│                                                     │
│  POST /api/deploy                                   │
│  {                                                  │
│    strategy: "copy-trade",                          │
│    target_wallet: "AbC...xyz",                      │
│    duration_days: 7,                                │
│    user_wallet: "DeF...uvw"                         │
│  }                                                  │
│                                                     │
│  Returns:                                           │
│  {                                                  │
│    session_id: "uuid",                              │
│    escrow_address: "GhI...rst",  ← PDA vault       │
│    deposit_amount: 5.0,                             │
│    fee: 0.125,                                      │
│    trading_balance: 4.875,                          │
│    telegram_bot: "@gentdex_trader_bot",             │
│    expires_at: "2026-02-10T13:49:00Z"              │
│  }                                                  │
└───────────────┬─────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────┐
│           Solana Escrow Program                      │
│                                                     │
│  Vault PDA per session:                             │
│  seeds = [b"vault", session_id, user_wallet]        │
│                                                     │
│  State:                                             │
│  - user: Pubkey (owner, can withdraw anytime)       │
│  - bot: Pubkey (session key, limited permissions)   │
│  - balance: u64                                     │
│  - fee_taken: bool                                  │
│  - expires_at: i64                                  │
│  - status: Active | Paused | Expired | Withdrawn   │
│                                                     │
│  Instructions:                                      │
│  - initialize(session_id, duration, bot_pubkey)     │
│  - deposit() — user sends SOL, 2.5% fee taken      │
│  - execute_swap(dex, token_in, token_out, amount)   │
│    └── ONLY callable by bot_pubkey                  │
│    └── ONLY whitelisted DEX programs               │
│    └── CANNOT transfer to arbitrary addresses       │
│  - withdraw() — ONLY callable by user              │
│  - emergency_withdraw() — user can always exit      │
│  - expire() — auto-returns funds after duration     │
│                                                     │
│  Whitelisted DEX programs:                          │
│  - Jupiter Aggregator                               │
│  - Raydium AMM                                      │
│  - Orca Whirlpool                                   │
│  - PumpSwap                                         │
│                                                     │
│  Fee distribution:                                  │
│  - 2.5% of deposit → GentDex treasury wallet       │
│  - Compute fees → deducted daily from vault         │
└───────────────┬─────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────┐
│          Docker VM (per session)                     │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │  OpenSolBot Instance                        │    │
│  │                                             │    │
│  │  - Bot keypair (session key)                │    │
│  │  - Can ONLY call escrow execute_swap()      │    │
│  │  - Monitors target wallet via Geyser/WSS    │    │
│  │  - Replicates trades through escrow vault   │    │
│  │  - Telegram bot for user control            │    │
│  │                                             │    │
│  │  Services:                                  │    │
│  │  - wallet-tracker (monitors target)         │    │
│  │  - trading (executes via escrow)            │    │
│  │  - tg-bot (user interface)                  │    │
│  │  - cache-preloader (token metadata)         │    │
│  │  - MySQL + Redis (local state)              │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  Lifecycle:                                         │
│  - Created on deposit confirmation                  │
│  - Runs for duration                                │
│  - Auto-shutdown on expiry                          │
│  - User can extend by paying more compute           │
└─────────────────────────────────────────────────────┘

## Security Model

### Non-Custodial Guarantees
1. User deposits into a PDA vault, NOT a bot-controlled wallet
2. Bot has a session keypair that can ONLY call `execute_swap` on the escrow
3. `execute_swap` validates:
   - Caller is the registered bot pubkey
   - Target DEX program is whitelisted
   - Session is not expired
   - Session is not paused
4. Bot CANNOT:
   - Transfer SOL/tokens to arbitrary addresses
   - Withdraw from the vault
   - Change the user's withdrawal address
5. User CAN always:
   - Withdraw all funds (emergency_withdraw)
   - Pause trading
   - Close the session early

### Key Management
- Bot keypair generated per session
- Stored encrypted in the VM
- Key is useless without the escrow program — it can only call execute_swap
- If VM is compromised, attacker can only make trades (not steal funds)
- If VM dies, user withdraws from escrow directly

### Worst Case Scenarios
| Scenario | Impact | Recovery |
|----------|--------|----------|
| VM compromised | Attacker can make trades | User withdraws from escrow |
| VM crashes | Trading stops | User withdraws, we restart VM |
| Strategy loses money | Trading loss | User's risk, disclosed upfront |
| GentDex goes down | No new deploys | Existing escrows still accessible |
| Escrow bug | Potential fund loss | Audit + bug bounty program |

## Compute Infrastructure

### Option A: Fly.io (recommended for MVP)
- Machines API for on-demand VMs
- Auto-stop when idle
- $0.0000573/s for shared-cpu-1x (≈ $5/mo)
- Deploy via API: `flyctl machines run`

### Option B: Railway
- Docker deploy via API
- $5/mo base for pro plan
- Simple but less control

### Option C: Self-hosted (Mac Mini cluster)
- Most margin, most ops burden
- Good for demo, bad for scale

## API Endpoints

```
POST   /api/deploy          — Create session, return escrow address
GET    /api/session/:id     — Session status, balance, P&L
POST   /api/session/:id/pause    — Pause trading
POST   /api/session/:id/resume   — Resume trading  
POST   /api/session/:id/extend   — Extend duration (pay more compute)
DELETE /api/session/:id     — Trigger withdrawal + shutdown
GET    /api/strategies      — List available strategies
GET    /api/strategies/:id  — Strategy details + backtest results
```

## Database Schema (GentDex side)

```sql
CREATE TABLE deploy_sessions (
  id UUID PRIMARY KEY,
  user_wallet TEXT NOT NULL,
  strategy_type TEXT NOT NULL,        -- 'copy-trade', 'grid', 'dca'
  strategy_config JSONB NOT NULL,     -- target wallet, params, etc.
  escrow_address TEXT,                -- Solana PDA
  bot_pubkey TEXT,                    -- Session keypair public key
  vm_id TEXT,                         -- Fly.io machine ID
  telegram_bot_token TEXT,            -- Per-session TG bot (or shared)
  deposit_amount DECIMAL,
  fee_amount DECIMAL,
  trading_balance DECIMAL,
  duration_days INTEGER,
  status TEXT DEFAULT 'pending',      -- pending, funded, active, paused, expired, withdrawn
  created_at TIMESTAMP DEFAULT NOW(),
  funded_at TIMESTAMP,
  expires_at TIMESTAMP,
  withdrawn_at TIMESTAMP
);

CREATE TABLE deploy_transactions (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES deploy_sessions(id),
  tx_signature TEXT NOT NULL,
  tx_type TEXT NOT NULL,              -- 'deposit', 'swap', 'withdraw', 'fee'
  token_in TEXT,
  token_out TEXT,
  amount_in DECIMAL,
  amount_out DECIMAL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Revenue Projections

| Metric | Conservative | Moderate | Aggressive |
|--------|-------------|----------|------------|
| Active sessions | 10 | 50 | 200 |
| Avg deposit | 5 SOL | 10 SOL | 20 SOL |
| Setup fee (2.5%) | 1.25 SOL | 12.5 SOL | 100 SOL |
| Compute/day | 0.1 SOL | 0.5 SOL | 2 SOL |
| Monthly revenue | ~5 SOL | ~28 SOL | ~160 SOL |
| At $150/SOL | $750 | $4,200 | $24,000 |

## Implementation Phases

### Phase 1: VC Demo (2-3 weeks)
- [ ] Escrow program (Anchor/Solana)
- [ ] Deploy API (Node.js, on Render)
- [ ] Frontend: gentdex.com/deploy page
- [ ] OpenSolBot integration (modify to use escrow)
- [ ] Single strategy: copy-trade
- [ ] Fly.io compute provisioning
- [ ] Demo video

### Phase 2: Testnet Launch (2-3 weeks)
- [ ] Deploy escrow to Solana devnet
- [ ] End-to-end testing with test SOL
- [ ] Strategy backtesting display
- [ ] User dashboard (active sessions, P&L)
- [ ] Telegram bot improvements

### Phase 3: Audit + Mainnet (4-6 weeks)
- [ ] Security audit of escrow program
- [ ] Bug bounty program
- [ ] Mainnet deployment
- [ ] Multi-strategy support (grid, DCA)
- [ ] Hummingbot integration (EVM chains)

## Tech Stack
- **Escrow**: Anchor (Solana program framework)
- **API**: Node.js + Express (or add to existing GentDex API)
- **Compute**: Fly.io Machines API
- **Bot**: OpenSolBot (modified fork)
- **Frontend**: GentDex Vercel app
- **Database**: Supabase (existing GentDex DB)
- **Payments**: x402 for compute, on-chain for deposits
```
