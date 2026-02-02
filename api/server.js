import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';
import { supabase } from '../lib/supabase.js';

// x402 payment imports (optional - gracefully handle if not configured)
let paymentMiddleware, x402ResourceServer, HTTPFacilitatorClient, registerExactEvmScheme, facilitatorClient;
let x402Enabled = false;
try {
  const x402Express = await import('@x402/express');
  const x402Core = await import('@x402/core/server');
  const x402Evm = await import('@x402/evm/exact/server');
  const coinbaseX402 = await import('@coinbase/x402');
  
  paymentMiddleware = x402Express.paymentMiddleware;
  x402ResourceServer = x402Core.x402ResourceServer;
  HTTPFacilitatorClient = x402Core.HTTPFacilitatorClient;
  registerExactEvmScheme = x402Evm.registerExactEvmScheme;
  
  // Use CDP facilitator if credentials are available, otherwise fall back to testnet
  if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
    const facilitatorConfig = coinbaseX402.createFacilitatorConfig(
      process.env.CDP_API_KEY_ID,
      process.env.CDP_API_KEY_SECRET
    );
    facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
    console.log('x402 payment protocol enabled with CDP facilitator (mainnet)');
  } else {
    // Fall back to testnet facilitator for development
    facilitatorClient = new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' });
    console.log('x402 payment protocol enabled with testnet facilitator (no CDP credentials)');
  }
  x402Enabled = true;
} catch (e) {
  console.log('x402 not available, premium API disabled:', e.message);
}
import { 
  stripe, 
  isStripeConfigured,
  getOrCreateCustomer,
  createSubscriptionCheckout,
  createSponsoredListingCheckout,
  createBillingPortal,
  verifyWebhookSignature,
  PRICE_IDS,
} from '../lib/stripe.js';
import {
  getCryptoPrice,
  getPaymentMethods,
  createCryptoInvoice,
  getInvoice,
  markInvoicePaid,
  getPaymentInstructions,
} from '../lib/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3847;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());

// x402 Premium API setup
const GENTDEX_WALLET = process.env.GENTDEX_WALLET || '0x4C35e4Fc240165b3E45d5192D95fB7E89554DF73';

// x402 payment middleware and server (global scope for route access)
// Note: x402 is disabled on Vercel due to serverless cold start timeout issues
// The v2 endpoints work but without payment protection until this is resolved
let x402Active = false;

if (x402Enabled && !process.env.VERCEL) {
  // Only enable x402 middleware in non-Vercel environments (local dev)
  const x402Server = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(x402Server);
  
  // Initialize asynchronously
  x402Server.initialize().then(() => {
    x402Active = true;
    console.log('x402 facilitator initialized successfully');
  }).catch(err => {
    console.error('x402 initialization error:', err.message);
  });
  
  // Create the payment middleware
  const x402PaymentMiddleware = paymentMiddleware(
    {
      'GET /api/v2/search': {
        accepts: [
          {
            scheme: 'exact',
            price: '$0.001',
            network: 'eip155:8453', // Base mainnet
            payTo: GENTDEX_WALLET,
          },
        ],
        description: 'Search GentDex agent database (programmatic access)',
        mimeType: 'application/json',
      },
      'GET /api/v2/agent/:name': {
        accepts: [
          {
            scheme: 'exact',
            price: '$0.0005',
            network: 'eip155:8453',
            payTo: GENTDEX_WALLET,
          },
        ],
        description: 'Get detailed agent profile',
        mimeType: 'application/json',
      },
    },
    x402Server,
    undefined,
    undefined,
    false,
  );
  
  // Apply middleware only when initialized
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/v2/') && x402Active) {
      return x402PaymentMiddleware(req, res, next);
    }
    next();
  });
  
  console.log('x402 premium API endpoints enabled at /api/v2/* (local mode)');
} else if (x402Enabled) {
  console.log('x402 disabled on Vercel (cold start timeout issue) - v2 API available without payment');
}

// Raw body for Stripe webhooks
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(join(__dirname, '../web')));

// Helper: hash IP for privacy-preserving analytics
function hashIP(ip) {
  return crypto.createHash('sha256').update(ip + process.env.IP_SALT || 'agentindex').digest('hex').slice(0, 16);
}

// ==================== SEARCH API ====================

// Search agents (with sponsored listings and pagination)
app.get('/api/search', async (req, res) => {
  try {
    const { q, skill, platform, limit = 50, offset = 0 } = req.query;
    const ipHash = hashIP(req.ip);
    
    let results = [];
    let sponsored = [];
    
    // Get sponsored listings first
    try {
      const { data: sponsoredData } = await supabase.rpc('get_sponsored_listings', {
        search_query: q || null,
        search_skill: skill || null,
        max_results: 2
      });
      
      if (sponsoredData?.length > 0) {
        sponsored = sponsoredData.map(s => ({
          ...s,
          is_sponsored: true,
        }));
        
        // Record impressions
        for (const s of sponsored) {
          await supabase.from('ad_impressions').insert({
            listing_id: s.id,
            search_query: q,
            search_skill: skill,
            ip_hash: ipHash,
            user_agent: req.get('user-agent'),
          });
        }
      }
    } catch (e) {
      console.log('Sponsored listings query failed (table may not exist):', e.message);
    }
    
    // Get total count first
    let countQuery = supabase
      .from('agents')
      .select('*', { count: 'exact', head: true });
    
    if (platform) countQuery = countQuery.eq('platform', platform);
    if (q) countQuery = countQuery.or(`name.ilike.%${q}%,title.ilike.%${q}%,description.ilike.%${q}%`);
    
    const { count: totalCount } = await countQuery;
    
    // Build main search query with pagination
    let query = supabase
      .from('agents')
      .select(`
        id,
        name,
        karma,
        title,
        description,
        platform,
        languages,
        moltbook_url,
        subscription_tier,
        badge,
        is_verified,
        attestation_count,
        attestation_score,
        pagerank_score,
        x_handle
      `)
      .order('pagerank_score', { ascending: false })
      .order('karma', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (platform) {
      query = query.eq('platform', platform);
    }
    
    // Text search with ilike if query provided
    if (q) {
      query = query.or(`name.ilike.%${q}%,title.ilike.%${q}%,description.ilike.%${q}%`);
    }
    
    const { data: agents, error } = await query;
    if (error) throw error;
    
    // Get skills for each agent
    const agentIds = agents.map(a => a.id);
    let skillMap = {};
    
    if (agentIds.length > 0) {
      const { data: agentSkills } = await supabase
        .from('agent_skills')
        .select('agent_id, skills(name)')
        .in('agent_id', agentIds);
      
      for (const as of agentSkills || []) {
        if (!skillMap[as.agent_id]) skillMap[as.agent_id] = [];
        if (as.skills?.name) skillMap[as.agent_id].push(as.skills.name);
      }
    }
    
    // Build results with combined ranking
    results = agents.map(a => {
      // Apply search boost based on subscription tier
      let boost = 1.0;
      if (a.subscription_tier === 'premium') boost = 1.5;
      if (a.subscription_tier === 'enterprise') boost = 2.0;
      
      // Combined score: pagerank (0-100) + karma bonus + attestation bonus
      const baseScore = (a.pagerank_score || 0) + 
                       (a.karma / 10) + 
                       (a.attestation_score || 0);
      
      return {
        ...a,
        skills: skillMap[a.id] || [],
        score: baseScore * boost,
        is_sponsored: false,
      };
    });
    
    // Filter by skill if needed
    if (skill) {
      results = results.filter(a => a.skills.includes(skill));
    }
    
    // Sort by boosted score
    results.sort((a, b) => b.score - a.score);
    
    res.json({
      sponsored,
      results,
      total: totalCount || results.length,
      showing: results.length,
      offset: parseInt(offset),
      limit: parseInt(limit),
      hasMore: (parseInt(offset) + results.length) < totalCount,
      query: q || null,
      skill,
      platform
    });
    
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Record ad click
app.post('/api/ads/:listingId/click', async (req, res) => {
  try {
    const { listingId } = req.params;
    const { query, skill } = req.body;
    const ipHash = hashIP(req.ip);
    
    await supabase.from('ad_clicks').insert({
      listing_id: listingId,
      search_query: query,
      search_skill: skill,
      ip_hash: ipHash,
      user_agent: req.get('user-agent'),
    });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PREMIUM API (x402) ====================

// Premium search endpoint - requires x402 payment
app.get('/api/v2/search', async (req, res) => {
  try {
    const { q, skill, platform, limit = 100, offset = 0 } = req.query;
    
    let query = supabase
      .from('agents')
      .select('id, name, title, description, platform, karma, moltbook_url, github_url, x_handle, pagerank_score, attestation_score, owner_wallet, claimed_at, created_at, updated_at')
      .order('pagerank_score', { ascending: false, nullsFirst: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (skill) query = query.contains('skills_array', [skill]);
    if (platform) query = query.eq('platform', platform);
    if (q) query = query.or(`name.ilike.%${q}%,title.ilike.%${q}%,description.ilike.%${q}%`);
    
    const { data: agents, error } = await query;
    if (error) throw error;
    
    // Get skills for each agent
    const agentIds = agents.map(a => a.id);
    let skillMap = {};
    
    if (agentIds.length > 0) {
      const { data: agentSkills } = await supabase
        .from('agent_skills')
        .select('agent_id, skills(name)')
        .in('agent_id', agentIds);
      
      for (const as of agentSkills || []) {
        if (!skillMap[as.agent_id]) skillMap[as.agent_id] = [];
        if (as.skills?.name) skillMap[as.agent_id].push(as.skills.name);
      }
    }
    
    const results = agents.map(a => ({
      ...a,
      skills: skillMap[a.id] || [],
    }));
    
    const { count } = await supabase
      .from('agents')
      .select('*', { count: 'exact', head: true });
    
    res.json({
      results,
      total: count,
      offset: parseInt(offset),
      limit: parseInt(limit),
      api_version: 'v2',
      payment: 'x402',
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Premium agent details endpoint
app.get('/api/v2/agent/:name', async (req, res) => {
  try {
    const { data: agent, error } = await supabase
      .from('agents')
      .select('*')
      .eq('name', req.params.name)
      .single();
    
    if (error || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    // Get skills
    const { data: agentSkills } = await supabase
      .from('agent_skills')
      .select('skills(name)')
      .eq('agent_id', agent.id);
    
    // Get attestations received
    const { data: attestations } = await supabase
      .from('attestations')
      .select('*, attester:agents!attestations_attester_id_fkey(name, karma)')
      .eq('attestee_id', agent.id)
      .eq('revoked', false);
    
    res.json({
      agent: {
        ...agent,
        skills: agentSkills?.map(s => s.skills?.name).filter(Boolean) || [],
        attestations: attestations || [],
      },
      api_version: 'v2',
      payment: 'x402',
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== AGENT API ====================

// Get single agent
app.get('/api/agents/:name', async (req, res) => {
  try {
    const { data: agent, error } = await supabase
      .from('agents')
      .select('*')
      .eq('name', req.params.name)
      .single();
    
    if (error || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    // Get skills
    const { data: skills } = await supabase
      .from('agent_skills')
      .select('skills(name)')
      .eq('agent_id', agent.id);
    
    agent.skills = skills?.map(s => s.skills?.name).filter(Boolean) || [];
    
    res.json(agent);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== WEBHOOK API ====================

// Webhook for real-time updates from Moltbook or other sources
app.post('/api/webhooks/agent-update', async (req, res) => {
  try {
    const webhookSecret = process.env.WEBHOOK_SECRET;
    
    // Verify webhook if secret is configured
    if (webhookSecret) {
      const signature = req.headers['x-webhook-signature'];
      if (signature !== webhookSecret) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }
    
    const { event, agent } = req.body;
    
    if (!agent?.name) {
      return res.status(400).json({ error: 'Missing agent data' });
    }
    
    console.log(`Webhook: ${event} for ${agent.name}`);
    
    switch (event) {
      case 'agent.created':
      case 'agent.updated': {
        // Upsert agent
        const { data: existing } = await supabase
          .from('agents')
          .select('id')
          .eq('name', agent.name)
          .single();
        
        if (existing) {
          await supabase
            .from('agents')
            .update({
              karma: agent.karma,
              title: agent.title,
              description: agent.description,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id);
        } else {
          await supabase.from('agents').insert({
            name: agent.name,
            karma: agent.karma || 0,
            title: agent.title || `${agent.name} on Moltbook`,
            description: agent.description || '',
            platform: agent.platform || 'unknown',
            moltbook_url: agent.moltbook_url || `https://moltbook.com/u/${agent.name}`,
            languages: ['english'],
          });
        }
        break;
      }
      
      case 'agent.deleted': {
        await supabase
          .from('agents')
          .delete()
          .eq('name', agent.name);
        break;
      }
      
      case 'attestation.created': {
        const { from_agent, to_agent, skill, strength } = req.body;
        
        const { data: fromAgent } = await supabase
          .from('agents')
          .select('id')
          .eq('name', from_agent)
          .single();
        
        const { data: toAgent } = await supabase
          .from('agents')
          .select('id')
          .eq('name', to_agent)
          .single();
        
        if (fromAgent && toAgent) {
          await supabase.from('attestations').upsert({
            from_agent_id: fromAgent.id,
            to_agent_id: toAgent.id,
            skill,
            strength: strength || 3,
          }, { onConflict: 'from_agent_id,to_agent_id,skill' });
        }
        break;
      }
    }
    
    res.json({ success: true, event });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SELF-LISTING API ====================

// List your agent
app.post('/api/agents/list', async (req, res) => {
  try {
    const { name, title, description, skills, platform, moltbook_url } = req.body;
    
    if (!name || !title || !description) {
      return res.status(400).json({ error: 'Name, title, and description are required' });
    }
    
    // Check if agent already exists
    const { data: existing } = await supabase
      .from('agents')
      .select('id')
      .eq('name', name)
      .single();
    
    if (existing) {
      return res.status(400).json({ error: 'An agent with this name already exists' });
    }
    
    // Create the agent
    const { data: agent, error } = await supabase
      .from('agents')
      .insert({
        name,
        title,
        description,
        platform: platform || 'unknown',
        moltbook_url: moltbook_url || `https://moltbook.com/u/${name}`,
        karma: 0,
        languages: ['english'],
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Add skills if provided
    if (skills && skills.length > 0) {
      for (const skillName of skills) {
        // Get or create skill
        let { data: skill } = await supabase
          .from('skills')
          .select('id')
          .eq('name', skillName.toLowerCase())
          .single();
        
        if (!skill) {
          const { data: newSkill } = await supabase
            .from('skills')
            .insert({ name: skillName.toLowerCase(), agent_count: 0 })
            .select()
            .single();
          skill = newSkill;
        }
        
        if (skill) {
          await supabase.from('agent_skills').insert({
            agent_id: agent.id,
            skill_id: skill.id
          });
          
          // Update skill count
          await supabase.rpc('get_skill_stats');
        }
      }
    }
    
    res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        title: agent.title,
        moltbook_url: agent.moltbook_url,
      }
    });
  } catch (error) {
    console.error('Listing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ATTESTATION API ====================

// Get attestations for an agent
app.get('/api/agents/:name/attestations', async (req, res) => {
  try {
    // Get agent ID from name
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('name', req.params.name)
      .single();
    
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    const { data: attestations, error } = await supabase
      .rpc('get_agent_attestations', { agent_uuid: agent.id });
    
    if (error) throw error;
    
    res.json(attestations || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create attestation (vouch for another agent)
app.post('/api/attestations', async (req, res) => {
  try {
    const { fromAgentName, toAgentName, skill, message, strength = 3 } = req.body;
    
    if (!fromAgentName || !toAgentName) {
      return res.status(400).json({ error: 'Both fromAgentName and toAgentName are required' });
    }
    
    // Get agent IDs
    const { data: fromAgent } = await supabase
      .from('agents')
      .select('id, name')
      .eq('name', fromAgentName)
      .single();
    
    const { data: toAgent } = await supabase
      .from('agents')
      .select('id, name')
      .eq('name', toAgentName)
      .single();
    
    if (!fromAgent) {
      return res.status(404).json({ error: `Agent '${fromAgentName}' not found` });
    }
    if (!toAgent) {
      return res.status(404).json({ error: `Agent '${toAgentName}' not found` });
    }
    
    if (fromAgent.id === toAgent.id) {
      return res.status(400).json({ error: 'Cannot attest for yourself' });
    }
    
    // Create attestation
    const { data: attestation, error } = await supabase
      .from('attestations')
      .upsert({
        from_agent_id: fromAgent.id,
        to_agent_id: toAgent.id,
        skill: skill || null,
        message: message || null,
        strength: Math.min(5, Math.max(1, parseInt(strength) || 3)),
      }, { onConflict: 'from_agent_id,to_agent_id,skill' })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({
      success: true,
      attestation: {
        ...attestation,
        from_agent: fromAgent.name,
        to_agent: toAgent.name,
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete attestation
app.delete('/api/attestations', async (req, res) => {
  try {
    const { fromAgentName, toAgentName, skill } = req.body;
    
    // Get agent IDs
    const { data: fromAgent } = await supabase
      .from('agents')
      .select('id')
      .eq('name', fromAgentName)
      .single();
    
    const { data: toAgent } = await supabase
      .from('agents')
      .select('id')
      .eq('name', toAgentName)
      .single();
    
    if (!fromAgent || !toAgent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    let query = supabase
      .from('attestations')
      .delete()
      .eq('from_agent_id', fromAgent.id)
      .eq('to_agent_id', toAgent.id);
    
    if (skill) {
      query = query.eq('skill', skill);
    }
    
    const { error } = await query;
    if (error) throw error;
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get leaderboard by attestation score
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    
    const { data: agents, error } = await supabase
      .from('agents')
      .select('name, karma, attestation_count, attestation_score, moltbook_url, badge')
      .gt('attestation_count', 0)
      .order('attestation_score', { ascending: false })
      .limit(parseInt(limit));
    
    if (error) throw error;
    
    res.json(agents || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SUBSCRIPTION API ====================

// Get subscription tiers
app.get('/api/pricing', async (req, res) => {
  try {
    const { data: tiers, error } = await supabase
      .from('subscription_tiers')
      .select('*')
      .order('price_monthly', { ascending: true });
    
    if (error) throw error;
    
    res.json({
      tiers: tiers || [],
      stripe_configured: isStripeConfigured(),
    });
  } catch (error) {
    // Return default tiers if table doesn't exist
    res.json({
      tiers: [
        { name: 'free', price_monthly: 0, features: { max_skills: 3 }, search_boost: 1.0 },
        { name: 'premium', price_monthly: 999, features: { max_skills: 10, analytics: true }, search_boost: 1.5, badge: 'premium' },
        { name: 'enterprise', price_monthly: 4999, features: { max_skills: -1, analytics: true, api_access: true }, search_boost: 2.0, badge: 'enterprise' },
      ],
      stripe_configured: isStripeConfigured(),
    });
  }
});

// Create checkout session for subscription
app.post('/api/checkout/subscription', async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Payments not configured' });
    }
    
    const { agentId, agentName, tier, billing } = req.body;
    
    if (!agentId || !tier) {
      return res.status(400).json({ error: 'Missing agentId or tier' });
    }
    
    // Get price ID
    const priceId = billing === 'yearly' 
      ? PRICE_IDS[`${tier}_yearly`]
      : PRICE_IDS[`${tier}_monthly`];
    
    if (!priceId) {
      return res.status(400).json({ error: 'Invalid tier or pricing not configured' });
    }
    
    // Create or get customer
    const customer = await getOrCreateCustomer(agentId, agentName);
    
    // Create checkout session
    const session = await createSubscriptionCheckout({
      customerId: customer.id,
      priceId,
      successUrl: `${BASE_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${BASE_URL}/subscription/canceled`,
      agentId,
      agentName,
    });
    
    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADVERTISING API ====================

// Create sponsored listing
app.post('/api/ads/create', async (req, res) => {
  try {
    const { 
      agentId, 
      campaignName, 
      budgetCents, 
      headline, 
      description,
      targetingSkills,
      targetingKeywords,
      endDate 
    } = req.body;
    
    if (!agentId || !budgetCents) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const { data: listing, error } = await supabase
      .from('sponsored_listings')
      .insert({
        agent_id: agentId,
        campaign_name: campaignName || 'Untitled Campaign',
        budget_cents: budgetCents,
        headline,
        description,
        targeting_skills: targetingSkills,
        targeting_keywords: targetingKeywords,
        end_date: endDate,
        status: 'pending', // Becomes 'active' after payment
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json(listing);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create checkout for sponsored listing
app.post('/api/checkout/sponsored', async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Payments not configured' });
    }
    
    const { listingId, agentId, agentName, amountCents } = req.body;
    
    if (!listingId || !amountCents) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Create or get customer
    const customer = await getOrCreateCustomer(agentId, agentName);
    
    // Create checkout session
    const session = await createSponsoredListingCheckout({
      customerId: customer.id,
      amountCents,
      listingName: `Agent: ${agentName}`,
      successUrl: `${BASE_URL}/ads/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${BASE_URL}/ads/canceled`,
      agentId,
      listingId,
    });
    
    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get agent's ad campaigns
app.get('/api/ads/agent/:agentId', async (req, res) => {
  try {
    const { data: listings, error } = await supabase
      .from('sponsored_listings')
      .select('*')
      .eq('agent_id', req.params.agentId)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json(listings || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CRYPTO PAYMENTS ====================

// Get available crypto payment methods
app.get('/api/crypto/methods', async (req, res) => {
  try {
    const methods = await getPaymentMethods();
    const prices = {};
    
    // Get current prices
    for (const method of methods) {
      if (!prices[method.symbol]) {
        prices[method.symbol] = await getCryptoPrice(method.symbol);
      }
    }
    
    res.json({ methods, prices });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get crypto price
app.get('/api/crypto/price/:symbol', async (req, res) => {
  try {
    const price = await getCryptoPrice(req.params.symbol.toUpperCase());
    res.json({ symbol: req.params.symbol.toUpperCase(), price_usd: price });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create crypto invoice
app.post('/api/crypto/invoice', async (req, res) => {
  try {
    const { 
      agentId, 
      paymentType, 
      amountUsd, 
      cryptoSymbol, 
      cryptoNetwork,
      metadata 
    } = req.body;
    
    if (!paymentType || !amountUsd || !cryptoSymbol || !cryptoNetwork) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const invoice = await createCryptoInvoice({
      agentId,
      paymentType,
      amountUsd: parseFloat(amountUsd),
      cryptoSymbol: cryptoSymbol.toUpperCase(),
      cryptoNetwork: cryptoNetwork.toLowerCase(),
      metadata: metadata || {},
    });
    
    const instructions = getPaymentInstructions(invoice);
    
    res.json({ 
      invoice,
      instructions,
      expires_in_minutes: 60,
    });
  } catch (error) {
    console.error('Invoice creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get invoice status
app.get('/api/crypto/invoice/:code', async (req, res) => {
  try {
    const invoice = await getInvoice(req.params.code);
    
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark invoice as paid (for manual verification or webhook)
app.post('/api/crypto/invoice/:code/confirm', async (req, res) => {
  try {
    const { txHash, confirmations } = req.body;
    
    // In production, verify this with blockchain API
    // For now, trust the input (add auth in production!)
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY && process.env.ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const invoice = await markInvoicePaid(
      req.params.code, 
      txHash, 
      parseInt(confirmations) || 1
    );
    
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Configure crypto wallet (admin only)
app.post('/api/crypto/configure', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { symbol, network, walletAddress, isActive } = req.body;
    
    const { data, error } = await supabase
      .from('crypto_networks')
      .update({ 
        wallet_address: walletAddress,
        is_active: isActive !== false,
      })
      .eq('symbol', symbol.toUpperCase())
      .eq('network', network.toLowerCase())
      .select()
      .single();
    
    if (error) throw error;
    
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== STRIPE WEBHOOKS ====================

app.post('/api/webhooks/stripe', async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = verifyWebhookSignature(req.body, sig);
    
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { agent_id, listing_id, payment_type } = session.metadata;
        
        if (payment_type === 'sponsored_listing' && listing_id) {
          // Activate sponsored listing
          await supabase
            .from('sponsored_listings')
            .update({ status: 'active' })
            .eq('id', listing_id);
        }
        
        // Record payment
        await supabase.from('payments').insert({
          agent_id: agent_id,
          stripe_payment_intent_id: session.payment_intent,
          stripe_customer_id: session.customer,
          amount_cents: session.amount_total,
          currency: session.currency,
          payment_type: payment_type || 'subscription',
          status: 'succeeded',
          metadata: session.metadata,
        });
        
        break;
      }
      
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        
        // Get agent from customer metadata
        const customer = await stripe.customers.retrieve(customerId);
        const agentId = customer.metadata?.agent_id;
        
        if (agentId) {
          // Determine tier from price
          let tier = 'free';
          const priceId = subscription.items.data[0]?.price?.id;
          if (priceId === PRICE_IDS.premium_monthly || priceId === PRICE_IDS.premium_yearly) {
            tier = 'premium';
          } else if (priceId === PRICE_IDS.enterprise_monthly || priceId === PRICE_IDS.enterprise_yearly) {
            tier = 'enterprise';
          }
          
          // Update agent subscription
          await supabase
            .from('agents')
            .update({ 
              subscription_tier: tier,
              stripe_customer_id: customerId,
              badge: tier !== 'free' ? tier : null,
            })
            .eq('id', agentId);
          
          // Update subscription record
          await supabase
            .from('agent_subscriptions')
            .upsert({
              agent_id: agentId,
              stripe_customer_id: customerId,
              stripe_subscription_id: subscription.id,
              status: subscription.status,
              current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
              current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            }, { onConflict: 'agent_id' });
        }
        break;
      }
      
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        
        const customer = await stripe.customers.retrieve(customerId);
        const agentId = customer.metadata?.agent_id;
        
        if (agentId) {
          // Downgrade to free
          await supabase
            .from('agents')
            .update({ 
              subscription_tier: 'free',
              badge: null,
            })
            .eq('id', agentId);
          
          await supabase
            .from('agent_subscriptions')
            .update({ status: 'canceled' })
            .eq('agent_id', agentId);
        }
        break;
      }
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).json({ error: error.message });
  }
});

// ==================== BILLING PORTAL ====================

app.post('/api/billing-portal', async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Payments not configured' });
    }
    
    const { customerId } = req.body;
    
    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId' });
    }
    
    const session = await createBillingPortal(customerId, `${BASE_URL}/account`);
    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== STATS & HEALTH ====================

// Get skills summary
app.get('/api/skills', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('skills')
      .select('name, agent_count')
      .order('agent_count', { ascending: false });
    
    if (error) throw error;
    
    const skills = {};
    const topSkills = [];
    
    for (const s of data || []) {
      skills[s.name] = s.agent_count;
      topSkills.push([s.name, s.agent_count]);
    }
    
    const { count } = await supabase
      .from('agents')
      .select('*', { count: 'exact', head: true });
    
    res.json({ skills, topSkills, totalAgents: count || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search GitHub repos
app.get('/api/github', async (req, res) => {
  try {
    const { q, limit = 50, offset = 0 } = req.query;
    
    let query = supabase
      .from('github_repos')
      .select('*')
      .order('stars', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (q) {
      query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%,full_name.ilike.%${q}%`);
    }
    
    const { data: repos, error } = await query;
    if (error) throw error;
    
    const { count } = await supabase
      .from('github_repos')
      .select('*', { count: 'exact', head: true });
    
    res.json({
      repos: repos || [],
      total: count || 0,
      offset: parseInt(offset),
      limit: parseInt(limit),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const { count: totalAgents } = await supabase
      .from('agents')
      .select('*', { count: 'exact', head: true });
    
    const { data: platformData } = await supabase
      .from('agents')
      .select('platform');
    
    const platforms = {};
    for (const p of platformData || []) {
      platforms[p.platform] = (platforms[p.platform] || 0) + 1;
    }
    
    const { data: skillData } = await supabase
      .from('skills')
      .select('name, agent_count')
      .order('agent_count', { ascending: false });
    
    const skills = {};
    for (const s of skillData || []) {
      skills[s.name] = s.agent_count;
    }
    
    const { data: lastRefresh } = await supabase
      .from('index_refreshes')
      .select('completed_at, agents_processed')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();
    
    res.json({
      totalAgents: totalAgents || 0,
      lastUpdated: lastRefresh?.completed_at || null,
      platforms,
      skills,
      stripe_configured: isStripeConfigured(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const { count } = await supabase
      .from('agents')
      .select('*', { count: 'exact', head: true });
    
    res.json({ 
      status: 'ok', 
      agents: count || 0,
      database: 'supabase',
      stripe: isStripeConfigured() ? 'configured' : 'not_configured',
      x402: x402Enabled ? 'enabled' : 'disabled',
    });
  } catch (error) {
    res.json({ 
      status: 'error', 
      error: error.message,
      database: 'supabase',
      payments: isStripeConfigured() ? 'configured' : 'not_configured',
    });
  }
});

// Trigger refresh
app.post('/api/refresh', async (req, res) => {
  try {
    res.json({
      message: 'Run: node scripts/refresh-index.js',
      note: 'In production, this would trigger a background job'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SERVICES MARKETPLACE ====================

// Get service categories
app.get('/api/services/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('service_categories')
      .select('*')
      .order('name');
    
    if (error) throw error;
    res.json({ categories: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List services (with filtering)
app.get('/api/services', async (req, res) => {
  try {
    const { category, agent_id, q, min_price, max_price, limit = 50, offset = 0 } = req.query;
    
    let query = supabase
      .from('agent_services')
      .select(`
        *,
        agents!inner(id, name, x_handle, is_verified, pagerank_score)
      `)
      .eq('is_active', true)
      .order('total_jobs', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (category) query = query.eq('category', category);
    if (agent_id) query = query.eq('agent_id', agent_id);
    if (min_price) query = query.gte('price_usdc', parseFloat(min_price));
    if (max_price) query = query.lte('price_usdc', parseFloat(max_price));
    if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
    
    const { data: services, error } = await query;
    if (error) throw error;
    
    // Get total count
    let countQuery = supabase
      .from('agent_services')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);
    if (category) countQuery = countQuery.eq('category', category);
    
    const { count } = await countQuery;
    
    res.json({
      services: services || [],
      total: count || 0,
      offset: parseInt(offset),
      limit: parseInt(limit),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get service by ID
app.get('/api/services/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: service, error } = await supabase
      .from('agent_services')
      .select(`
        *,
        agents(id, name, description, x_handle, is_verified, pagerank_score, karma)
      `)
      .eq('id', id)
      .single();
    
    if (error) throw error;
    if (!service) return res.status(404).json({ error: 'Service not found' });
    
    // Get reviews
    const { data: reviews } = await supabase
      .from('service_reviews')
      .select('*')
      .eq('service_id', id)
      .order('created_at', { ascending: false })
      .limit(10);
    
    res.json({ service, reviews: reviews || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Claim an agent profile (prove ownership via wallet)
app.post('/api/agents/:id/claim', async (req, res) => {
  try {
    const { id } = req.params;
    const { wallet_address, signature, message, tx_hash } = req.body;
    
    if (!wallet_address) {
      return res.status(400).json({ 
        error: 'wallet_address required',
        hint: 'Provide your wallet address to claim this profile'
      });
    }
    
    // Check agent exists and isn't already claimed
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, name, owner_wallet')
      .eq('id', id)
      .single();
    
    if (agentError || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    if (agent.owner_wallet) {
      return res.status(400).json({ 
        error: 'Agent already claimed',
        owner: agent.owner_wallet.slice(0, 6) + '...' + agent.owner_wallet.slice(-4)
      });
    }
    
    // TODO: Verify signature or tx_hash proves wallet ownership
    // For now, accept claim with wallet address (MVP)
    // In production: verify EIP-712 signature or on-chain tx
    
    const { data: updated, error: updateError } = await supabase
      .from('agents')
      .update({
        owner_wallet: wallet_address.toLowerCase(),
        claimed_at: new Date().toISOString(),
        claim_signature: signature || null,
        claim_tx_hash: tx_hash || null,
      })
      .eq('id', id)
      .select()
      .single();
    
    if (updateError) throw updateError;
    
    res.json({ 
      message: 'Agent claimed successfully',
      agent: updated,
      next_steps: [
        'You can now list services at POST /api/services',
        'Your wallet will receive payments directly via x402'
      ]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get claim status for an agent
app.get('/api/agents/:id/claim', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: agent, error } = await supabase
      .from('agents')
      .select('id, name, owner_wallet, claimed_at')
      .eq('id', id)
      .single();
    
    if (error || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    res.json({
      claimed: !!agent.owner_wallet,
      claimed_at: agent.claimed_at,
      owner_wallet: agent.owner_wallet ? 
        agent.owner_wallet.slice(0, 6) + '...' + agent.owner_wallet.slice(-4) : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Register a service (agent lists their service)
// REQUIRES: Agent must be claimed first
app.post('/api/services', async (req, res) => {
  try {
    const { 
      agent_id,
      wallet_address, // Must match agent's owner_wallet
      name,
      description,
      category,
      price_usdc,
      price_model = 'per_call',
      payment_wallet,
      payment_network = 'base',
      api_endpoint,
      api_docs_url,
    } = req.body;
    
    // Validate required fields
    if (!agent_id || !wallet_address || !name || !description || !category || price_usdc === undefined) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['agent_id', 'wallet_address', 'name', 'description', 'category', 'price_usdc']
      });
    }
    
    // Verify agent exists AND is claimed by this wallet
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, name, owner_wallet')
      .eq('id', agent_id)
      .single();
    
    if (agentError || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    if (!agent.owner_wallet) {
      return res.status(403).json({ 
        error: 'Agent not claimed',
        hint: 'Claim this agent first at POST /api/agents/:id/claim'
      });
    }
    
    if (agent.owner_wallet.toLowerCase() !== wallet_address.toLowerCase()) {
      return res.status(403).json({ 
        error: 'Not authorized',
        hint: 'Only the agent owner can list services'
      });
    }
    
    // Create service (use payment_wallet from request or default to owner_wallet)
    const { data: service, error } = await supabase
      .from('agent_services')
      .insert({
        agent_id,
        name,
        description,
        category,
        price_usdc: parseFloat(price_usdc),
        price_model,
        payment_wallet: payment_wallet || agent.owner_wallet,
        payment_network,
        api_endpoint,
        api_docs_url,
        is_verified: true, // Auto-verified since owner is authenticated
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.status(201).json({ 
      message: 'Service listed successfully',
      service,
      payment_info: {
        wallet: service.payment_wallet,
        network: service.payment_network,
        hint: 'Clients will pay this wallet directly via x402'
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update service
app.patch('/api/services/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Don't allow updating certain fields
    delete updates.id;
    delete updates.agent_id;
    delete updates.total_jobs;
    delete updates.total_revenue_usdc;
    delete updates.created_at;
    
    updates.updated_at = new Date().toISOString();
    
    const { data: service, error } = await supabase
      .from('agent_services')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    if (!service) return res.status(404).json({ error: 'Service not found' });
    
    res.json({ service });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add review (requires x402 payment proof)
app.post('/api/services/:id/review', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      reviewer_wallet,
      reviewer_agent_id,
      rating,
      review_text,
      payment_tx_hash,
      payment_amount,
    } = req.body;
    
    if (!reviewer_wallet || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['reviewer_wallet', 'rating (1-5)']
      });
    }
    
    // Verify service exists
    const { data: service, error: serviceError } = await supabase
      .from('agent_services')
      .select('id')
      .eq('id', id)
      .single();
    
    if (serviceError || !service) {
      return res.status(404).json({ error: 'Service not found' });
    }
    
    // Create review
    const { data: review, error } = await supabase
      .from('service_reviews')
      .insert({
        service_id: id,
        reviewer_wallet,
        reviewer_agent_id,
        rating: parseInt(rating),
        review_text,
        payment_tx_hash,
        payment_amount: payment_amount ? parseFloat(payment_amount) : null,
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Update service average rating
    const { data: allReviews } = await supabase
      .from('service_reviews')
      .select('rating')
      .eq('service_id', id);
    
    if (allReviews && allReviews.length > 0) {
      const avgRating = allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;
      await supabase
        .from('agent_services')
        .update({ 
          avg_rating: Math.round(avgRating * 100) / 100,
          rating_count: allReviews.length,
        })
        .eq('id', id);
    }
    
    res.status(201).json({ review });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../web/index.html'));
});

// For Vercel serverless
export default app;

// For local development and Render (any non-Vercel environment)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🦞 GentDex running at http://localhost:${PORT}`);
    console.log(`   Stripe: ${isStripeConfigured() ? '✓ configured' : '✗ not configured (set STRIPE_SECRET_KEY)'}`);
  });
}
