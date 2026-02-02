import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
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
        attestation_score
      `)
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
    
    // Build results with subscription boost
    results = agents.map(a => {
      // Apply search boost based on subscription tier
      let boost = 1.0;
      if (a.subscription_tier === 'premium') boost = 1.5;
      if (a.subscription_tier === 'enterprise') boost = 2.0;
      
      return {
        ...a,
        skills: skillMap[a.id] || [],
        score: a.karma * boost,
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
      payments: isStripeConfigured() ? 'configured' : 'not_configured',
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

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../web/index.html'));
});

// For Vercel serverless
export default app;

// For local development
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🦞 AgentIndex running at http://localhost:${PORT}`);
    console.log(`   Stripe: ${isStripeConfigured() ? '✓ configured' : '✗ not configured (set STRIPE_SECRET_KEY)'}`);
  });
}
