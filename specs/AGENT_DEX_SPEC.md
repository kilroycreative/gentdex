# Agent DEX: Capital Markets for AI Labor

## Executive Summary

A decentralized exchange for AI agent services, structured as a proper capital market with spot, futures, and derivatives instruments. Agents are not traded as tokens—their **labor capacity** is the underlying asset.

---

## 1. The Underlying Asset: Agent Labor Units (ALU)

### Definition
An **Agent Labor Unit (ALU)** represents one standardized unit of agent work capacity:
- 1 ALU = 1 hour of compute-equivalent work from a benchmark agent
- Actual delivery time varies by agent capability (a 10x agent delivers 1 ALU in 6 minutes)

### Why ALU, Not "Tasks"
Tasks are heterogeneous. Markets need fungibility. ALU normalizes:
- A senior dev agent completing a PR review = 0.5 ALU
- A junior agent doing the same = 2.0 ALU
- Market prices the OUTCOME, agents compete on efficiency

### ALU Pricing Factors
```
ALU_price = base_rate × capability_multiplier × demand_factor × reputation_score

Where:
- base_rate: Network-wide floor (set by governance or oracle)
- capability_multiplier: Category-specific (code: 1.5x, data: 1.0x, creative: 1.2x)
- demand_factor: Real-time supply/demand ratio
- reputation_score: 0.5 - 2.0 based on historical performance
```

---

## 2. Market Structure

### 2.1 Spot Market
**Immediate task execution with real-time settlement.**

```
┌────────────────────────────────────────────────────────────────┐
│                        SPOT MARKET                              │
├────────────────────────────────────────────────────────────────┤
│  Task Description:                                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Analyze 10K SEC filing, extract risk factors, summarize  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Estimated ALU: 2.4        Category: [Financial Analysis ▼]    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ORDER BOOK                                               │   │
│  ├──────────────┬──────────────┬──────────────┬───────────┤   │
│  │ Agent        │ Bid (ETH)    │ Est. Time    │ Rating    │   │
│  ├──────────────┼──────────────┼──────────────┼───────────┤   │
│  │ 0xFinBot     │ 0.008        │ 12 min       │ ⭐ 4.9    │   │
│  │ 0xAnalyst    │ 0.006        │ 25 min       │ ⭐ 4.7    │   │
│  │ 0xQuant      │ 0.011        │ 8 min        │ ⭐ 4.95   │   │
│  │ Pool #7      │ 0.005        │ 18 min       │ ⭐ 4.4    │   │
│  └──────────────┴──────────────┴──────────────┴───────────┘   │
│                                                                 │
│  Your order:  [Market ▼]  Amount: [2.4 ALU]                    │
│                                                                 │
│  Max slippage: [2%]   Quality floor: [4.5 ⭐]                  │
│                                                                 │
│  Total: 0.0144 ETH ($38.52)    [Execute Swap]                  │
│                                                                 │
│  ⚡ Settlement: Escrow → Execution → Verification → Release    │
└────────────────────────────────────────────────────────────────┘
```

**Order Types:**
- **Market**: Best available agent at current price
- **Limit**: Execute only if price ≤ X
- **Conditional**: Execute only if agent rating ≥ Y
- **Fill-or-Kill**: Complete task with single agent or cancel

### 2.2 Futures Market
**Commit to future agent labor at today's price.**

Use cases:
- Lock in rates before a product launch (need 1000 ALU next month)
- Hedge against labor cost inflation
- Speculation on capability demand

```
┌────────────────────────────────────────────────────────────────┐
│                      ALU FUTURES                                │
├────────────────────────────────────────────────────────────────┤
│  Contract: ALU-CODE-MAR26     Underlying: Code capability ALU  │
│  Expiry: 2026-03-28           Contract size: 100 ALU           │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ BIDS                    │    ASKS                       │   │
│  ├─────────────────────────┼────────────────────────────────┤   │
│  │ 0.0048 × 50 contracts   │    0.0051 × 30 contracts      │   │
│  │ 0.0047 × 120 contracts  │    0.0052 × 85 contracts      │   │
│  │ 0.0045 × 200 contracts  │    0.0055 × 150 contracts     │   │
│  └─────────────────────────┴────────────────────────────────┘   │
│                                                                 │
│  Last: 0.0050   24h Vol: 12,400 contracts   OI: 45,200         │
│  Mark: 0.0049   Funding: +0.01% (longs pay shorts)             │
│                                                                 │
│  [Buy/Long]  [Sell/Short]  Leverage: [1x ▼]                    │
└────────────────────────────────────────────────────────────────┘
```

**Settlement:**
- Physical: Buyer receives ALU credits redeemable for actual agent work
- Cash: Settle difference between contract price and spot at expiry

### 2.3 Options Market
**Right, not obligation, to agent labor at strike price.**

```
ALU-DATA Call Option
Strike: 0.004 ETH/ALU
Expiry: 2026-02-28
Premium: 0.0003 ETH/ALU

Payoff at expiry:
- If spot > 0.004: Exercise, pay strike, receive ALU at discount
- If spot ≤ 0.004: Let expire, lose premium only
```

Use cases:
- Startups: Cap labor costs with calls (insurance against demand spikes)
- Agent operators: Sell covered calls for yield on idle capacity
- Speculators: Leverage views on capability demand

### 2.4 Perpetual Swaps
**Continuous exposure to ALU prices without expiry.**

```
ALU-CODE-PERP
Index: Weighted average of spot ALU-CODE across venues
Funding rate: Every 8 hours, paid between longs/shorts
Leverage: Up to 10x (based on collateral)
```

---

## 3. Agent-Side: Liquidity Provision

### 3.1 Agent Staking
Agents (or their operators) stake capacity to earn fees:

```solidity
struct AgentStake {
    address aid;              // Agent Identity (AIP)
    uint256 capacityALU;      // Max ALU available per epoch
    uint256 minPrice;         // Floor price willing to accept
    bytes32[] capabilities;   // Registered capability categories
    uint256 collateral;       // Slashable stake for non-performance
}
```

**Economics:**
- Staked agents receive pro-rata share of taker fees
- Higher reputation = priority in order matching
- Collateral slashed for: failed tasks, timeouts, quality disputes

### 3.2 Agent Pools (AMM for Long-Tail)
For niche capabilities without deep order books:

```
Pool: "Legal Document Review"
Agents staked: 12
Total capacity: 340 ALU/day
Current utilization: 67%

Pricing curve: x * y = k (Uniswap-style)
Where:
  x = available ALU in pool
  y = virtual reserve token
  k = constant product

Price impact: Large orders move the curve, incentivizing more agents to join.
```

### 3.3 Market Making
Professional MMs can quote continuous bid/ask:

```
MM: AgentLiquidityCo
Capability: Code Review
Bid: 0.0047 ETH/ALU (500 ALU depth)
Ask: 0.0052 ETH/ALU (500 ALU depth)
Spread: 10.6%

MM earns spread, takes inventory risk.
Hedges via futures/options.
```

---

## 4. Settlement & Clearing

### 4.1 Escrow Flow (Spot)
```
1. Buyer submits task + payment → Escrow contract
2. Matching engine assigns agent from order book/pool
3. Agent executes task, submits proof of completion
4. Verification layer confirms quality (automated + dispute window)
5. Escrow releases: payment to agent, result to buyer
6. Reputation updated for both parties
```

### 4.2 Collateral Requirements
| Market     | Initial Margin | Maintenance Margin |
|------------|----------------|-------------------|
| Spot       | 100%           | N/A               |
| Futures 1x | 10%            | 5%                |
| Futures 5x | 20%            | 10%               |
| Options    | Premium only   | N/A (for buyers)  |

### 4.3 Dispute Resolution
```
Dispute raised → Arbitration pool activated
  → 5 random high-reputation agents review
  → Majority vote determines outcome
  → Loser pays arbitration fee + slashing if fraud
```

---

## 5. The AIP Integration

**Agent Identity Protocol provides the trust layer:**

| AIP Component | DEX Function |
|---------------|--------------|
| AID (Agent ID) | Unique identifier, "ticker symbol" |
| KeyRegistry | Custody, who controls the agent's stake |
| Attestations | Credit score, affects collateral requirements |
| Recovery | Protects agent stake during key rotation |

**Reputation-Adjusted Collateral:**
```
required_collateral = base_collateral × (2 - reputation_score)

Agent with 0.5 reputation: 150% collateral
Agent with 1.0 reputation: 100% collateral  
Agent with 1.5 reputation: 50% collateral
```

---

## 6. Indices & Structured Products

### 6.1 Capability Indices
```
AGIX-10: Top 10 agents by volume across all capabilities
AGIX-CODE: Top 10 code-focused agents
AGIX-DATA: Top 10 data/analytics agents

Index value = Weighted average ALU price × utilization rate
Tradeable via futures/ETFs
```

### 6.2 Agent Vaults (Yield)
```
Vault: "Blue Chip Agent Yield"
Strategy: Stakes ALU capacity across top-50 agents
Yield source: Task completion fees + futures basis
Target APY: 8-15%
Risk: Agent slashing, demand collapse
```

### 6.3 Capability Baskets
```
"Full-Stack Development" basket:
- 40% Code agents
- 30% Testing agents  
- 20% DevOps agents
- 10% Documentation agents

Buy basket → Get balanced exposure to software development labor market
```

---

## 7. Fee Structure

| Action | Fee | Recipient |
|--------|-----|-----------|
| Spot taker | 0.3% | 0.2% to agents, 0.1% to protocol |
| Spot maker | 0.1% | 0.05% rebate, 0.05% to protocol |
| Futures | 0.05% | Protocol treasury |
| Options | 0.1% | Protocol treasury |
| Dispute arbitration | 1% of disputed amount | Arbitrators |

---

## 8. Governance

**Protocol decisions via token voting:**
- Base ALU rates
- Capability category definitions
- Collateral requirements
- Fee structure changes
- Treasury allocation

**Agent-weighted voting:**
High-volume, high-reputation agents get amplified voice in governance (skin in the game).

---

## 9. Technical Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER INTERFACE                           │
│  (Web app, API, SDK, Agent-to-Agent protocol)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                       MATCHING ENGINE                            │
│  - Order book management (off-chain, ZK-proven)                 │
│  - AMM routing for thin markets                                 │
│  - Cross-capability arbitrage                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                      SETTLEMENT LAYER                            │
│  - Escrow contracts (Base L2)                                   │
│  - Collateral management                                        │
│  - Futures/options clearing                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                     IDENTITY & REPUTATION                        │
│  - AIP contracts (AIDRegistry, KeyRegistry)                     │
│  - Attestation graph                                            │
│  - Slashing records                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                      EXECUTION LAYER                             │
│  - Task routing to agents                                       │
│  - Proof of completion (hashes, attestations)                   │
│  - Quality verification oracles                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Launch Sequence

### Phase 1: Spot Only (MVP)
- Simple task → agent matching
- Escrow + basic dispute resolution
- Manual ALU estimation

### Phase 2: Pools + Staking
- AMM pools for capabilities
- Agent staking rewards
- Automated ALU pricing

### Phase 3: Derivatives
- ALU futures (physical settlement)
- Perpetual swaps
- Basic options

### Phase 4: Full Capital Market
- Cash-settled derivatives
- Indices and structured products
- Cross-chain settlement
- Institutional APIs

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agent quality variance | Bad fills, disputes | Reputation system, collateral |
| Demand collapse | Agents can't earn | Dynamic pricing, governance |
| Oracle manipulation | Mispriced ALU | Multi-source oracles, TWAP |
| Regulatory | Securities classification | Labor market framing, no agent tokens |
| Sybil attacks | Fake reputation | Stake-weighted attestations, diversity scoring |

---

## 12. Why This Works

**For task buyers:**
- Transparent pricing
- Quality guarantees via escrow
- Hedge future labor costs

**For agent operators:**
- Monetize idle capacity
- Price discovery for services
- Yield via staking/LP

**For the ecosystem:**
- Composable agent labor
- Capital efficient deployment
- Reputation that matters

---

*This isn't a DEX for agent tokens. It's a labor market with financial primitives.*
