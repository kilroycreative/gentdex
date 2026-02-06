/**
 * GentDex Deploy API Routes
 * 
 * POST /api/deploy          — Create session + provision VM
 * GET  /api/deploy/:id      — Session status
 * POST /api/deploy/:id/pause   — Pause trading
 * POST /api/deploy/:id/resume  — Resume trading
 * DELETE /api/deploy/:id       — Withdraw + teardown
 * GET  /api/deploy/strategies  — List available strategies
 */

import { Router } from 'express';
import { FlyProvisioner } from './fly-provisioner.js';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const router = Router();

// Init clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const fly = new FlyProvisioner(process.env.FLY_API_TOKEN);

// =========================================================
// Strategies
// =========================================================
const STRATEGIES = [
  {
    id: 'copy-trade',
    name: 'Copy Trading',
    description: 'Follow a top trader\'s wallet and automatically replicate their trades.',
    status: 'live',
    min_deposit: 0.1,
    recommended_deposit: 5,
    supported_dexs: ['Jupiter', 'Raydium', 'Orca', 'PumpSwap'],
  },
  {
    id: 'grid',
    name: 'Grid Trading',
    description: 'Place buy/sell orders at preset intervals above and below a set price.',
    status: 'coming-soon',
  },
  {
    id: 'dca',
    name: 'DCA Bot',
    description: 'Dollar-cost average into any token on a custom schedule.',
    status: 'coming-soon',
  },
];

// =========================================================
// GET /api/deploy/strategies
// =========================================================
router.get('/strategies', (req, res) => {
  res.json({ strategies: STRATEGIES });
});

// =========================================================
// POST /api/deploy
// =========================================================
router.post('/', async (req, res) => {
  try {
    const {
      strategy,
      target_wallet,
      duration_days,
      deposit_amount,
      user_wallet,
    } = req.body;

    // Validation
    if (!strategy || !target_wallet || !duration_days || !deposit_amount || !user_wallet) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!STRATEGIES.find(s => s.id === strategy && s.status === 'live')) {
      return res.status(400).json({ error: 'Invalid or unavailable strategy' });
    }

    if (deposit_amount < 0.1) {
      return res.status(400).json({ error: 'Minimum deposit is 0.1 SOL' });
    }

    if (duration_days < 1 || duration_days > 30) {
      return res.status(400).json({ error: 'Duration must be 1-30 days' });
    }

    // Generate session
    const sessionId = randomUUID();
    const setupFee = deposit_amount * 0.025; // 2.5%
    const computeFee = duration_days * 0.01;
    const tradingBalance = deposit_amount - setupFee;

    // Generate bot keypair (in production, use proper key derivation)
    // For now, placeholder — the escrow program validates this
    const botKeypairPlaceholder = 'GENERATED_ON_PROVISION';

    // Store session in Supabase
    const { data: session, error: dbError } = await supabase
      .from('deploy_sessions')
      .insert({
        id: sessionId,
        user_wallet,
        strategy_type: strategy,
        strategy_config: {
          target_wallet,
        },
        deposit_amount,
        fee_amount: setupFee,
        trading_balance: tradingBalance,
        duration_days,
        status: 'pending', // Waiting for on-chain deposit
      })
      .select()
      .single();

    if (dbError) {
      console.error('DB error:', dbError);
      return res.status(500).json({ error: 'Failed to create session' });
    }

    // Calculate escrow PDA (would use @solana/web3.js in production)
    // For now, return session info and let frontend handle on-chain tx

    res.json({
      session_id: sessionId,
      status: 'pending',
      strategy,
      target_wallet,
      duration_days,
      deposit_amount,
      fee: {
        setup: setupFee,
        setup_pct: '2.5%',
        compute_per_day: 0.01,
        compute_total: computeFee,
      },
      trading_balance: tradingBalance,
      escrow_program: '9hyscAyfR2puBXWFoGzeBq3QtSn5e83B7AUkcS1qC5RJ',
      next_step: 'deposit_to_escrow',
      instructions: 'Send a deposit transaction to the escrow program. Once confirmed, the VM will be provisioned automatically.',
    });
  } catch (err) {
    console.error('Deploy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =========================================================
// POST /api/deploy/:id/confirm
// Called after on-chain deposit is confirmed
// =========================================================
router.post('/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const { tx_signature } = req.body;

    // Verify session exists and is pending
    const { data: session, error } = await supabase
      .from('deploy_sessions')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'pending') {
      return res.status(400).json({ error: `Session is ${session.status}, expected pending` });
    }

    // TODO: Verify tx_signature on-chain (check deposit landed in escrow PDA)
    // For dev, skip verification

    // Provision Fly.io machines
    let provisionResult;
    if (process.env.FLY_API_TOKEN) {
      provisionResult = await fly.provision({
        sessionId: id,
        targetWallet: session.strategy_config.target_wallet,
        durationDays: session.duration_days,
        botKeypair: '', // Will be generated on the VM
        tgBotToken: process.env.GENTDEX_TG_BOT_TOKEN || '',
        heliusApiKey: process.env.HELIUS_API_KEY || '',
        rpcEndpoint: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
      });
    } else {
      // Dev mode — no Fly.io
      provisionResult = {
        appName: `gentdex-agent-${id.slice(0, 8)}`,
        machines: { redis: 'dev-redis', mysql: 'dev-mysql', bot: 'dev-bot' },
        region: 'local',
        status: 'provisioned',
        expiresAt: new Date(Date.now() + session.duration_days * 86400000).toISOString(),
      };
    }

    // Update session
    await supabase
      .from('deploy_sessions')
      .update({
        status: 'active',
        vm_id: provisionResult.appName,
        funded_at: new Date().toISOString(),
        expires_at: provisionResult.expiresAt,
      })
      .eq('id', id);

    // Log the deposit transaction
    await supabase
      .from('deploy_transactions')
      .insert({
        id: randomUUID(),
        session_id: id,
        tx_signature: tx_signature || 'dev-mode',
        tx_type: 'deposit',
        amount_in: session.deposit_amount,
      });

    res.json({
      session_id: id,
      status: 'active',
      vm: provisionResult,
      telegram_bot: '@gentdex_bot',
      message: 'Agent is now live! Control it via Telegram.',
    });
  } catch (err) {
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to provision VM' });
  }
});

// =========================================================
// GET /api/deploy/:id
// =========================================================
router.get('/:id', async (req, res) => {
  try {
    const { data: session, error } = await supabase
      .from('deploy_sessions')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Get VM status if active
    let vmStatus = null;
    if (session.vm_id && process.env.FLY_API_TOKEN) {
      vmStatus = await fly.getStatus(session.vm_id);
    }

    // Get transaction history
    const { data: txs } = await supabase
      .from('deploy_transactions')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false });

    res.json({
      ...session,
      vm_status: vmStatus,
      transactions: txs || [],
    });
  } catch (err) {
    console.error('Status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =========================================================
// POST /api/deploy/:id/pause
// =========================================================
router.post('/:id/pause', async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('deploy_sessions')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'active') return res.status(400).json({ error: 'Session not active' });

    await supabase
      .from('deploy_sessions')
      .update({ status: 'paused' })
      .eq('id', req.params.id);

    // TODO: Send pause signal to VM via Telegram or direct API

    res.json({ status: 'paused' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pause' });
  }
});

// =========================================================
// POST /api/deploy/:id/resume
// =========================================================
router.post('/:id/resume', async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('deploy_sessions')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'paused') return res.status(400).json({ error: 'Session not paused' });

    await supabase
      .from('deploy_sessions')
      .update({ status: 'active' })
      .eq('id', req.params.id);

    res.json({ status: 'active' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resume' });
  }
});

// =========================================================
// DELETE /api/deploy/:id
// =========================================================
router.delete('/:id', async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('deploy_sessions')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Teardown Fly.io machines
    if (session.vm_id && process.env.FLY_API_TOKEN) {
      await fly.teardown(session.vm_id);
    }

    await supabase
      .from('deploy_sessions')
      .update({
        status: 'withdrawn',
        withdrawn_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    res.json({
      status: 'withdrawn',
      message: 'VM destroyed. Withdraw your funds from the escrow using your wallet.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to teardown' });
  }
});

export default router;
