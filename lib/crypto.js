/**
 * Crypto Payment Integration
 * 
 * Supports:
 * - ETH/USDC on Base (recommended - low fees)
 * - ETH/USDC on Ethereum mainnet
 * - BTC on-chain
 * - BTC Lightning (via LNBits, Alby, or similar)
 */

import { supabase } from './supabase.js';

// Price feed (CoinGecko free tier)
const COINGECKO_API = 'https://api.coingecko.com/api/v3';

// Cache prices for 5 minutes
let priceCache = {};
const PRICE_CACHE_TTL = 5 * 60 * 1000;

/**
 * Get current crypto price in USD
 */
export async function getCryptoPrice(symbol) {
  const now = Date.now();
  
  // Check cache
  if (priceCache[symbol] && now - priceCache[symbol].time < PRICE_CACHE_TTL) {
    return priceCache[symbol].price;
  }
  
  try {
    const ids = {
      'ETH': 'ethereum',
      'BTC': 'bitcoin',
      'USDC': 'usd-coin',
      'SOL': 'solana',
    };
    
    const id = ids[symbol.toUpperCase()];
    if (!id) throw new Error(`Unknown symbol: ${symbol}`);
    
    const res = await fetch(`${COINGECKO_API}/simple/price?ids=${id}&vs_currencies=usd`);
    const data = await res.json();
    
    const price = data[id]?.usd;
    if (!price) throw new Error('Price not available');
    
    // Cache it
    priceCache[symbol] = { price, time: now };
    
    // Store in DB for history
    await supabase.from('crypto_prices').insert({
      symbol: symbol.toUpperCase(),
      price_usd: price,
      source: 'coingecko',
    });
    
    return price;
  } catch (error) {
    console.error('Price fetch error:', error);
    
    // Try to get last known price from DB
    const { data } = await supabase
      .from('crypto_prices')
      .select('price_usd')
      .eq('symbol', symbol.toUpperCase())
      .order('fetched_at', { ascending: false })
      .limit(1)
      .single();
    
    if (data) return data.price_usd;
    
    // Fallback prices (update periodically)
    const fallbacks = { ETH: 3500, BTC: 95000, USDC: 1, SOL: 200 };
    return fallbacks[symbol.toUpperCase()] || null;
  }
}

/**
 * Get available payment methods
 */
export async function getPaymentMethods() {
  const { data, error } = await supabase.rpc('get_crypto_payment_methods');
  
  if (error) {
    console.error('Failed to get payment methods:', error);
    return [];
  }
  
  return data || [];
}

/**
 * Create a crypto invoice
 */
export async function createCryptoInvoice({
  agentId,
  paymentType,
  amountUsd,
  cryptoSymbol,
  cryptoNetwork,
  metadata = {},
  expiresInMinutes = 60,
}) {
  // Get wallet address for this network
  const { data: network } = await supabase
    .from('crypto_networks')
    .select('wallet_address')
    .eq('symbol', cryptoSymbol)
    .eq('network', cryptoNetwork)
    .eq('is_active', true)
    .single();
  
  if (!network?.wallet_address) {
    throw new Error(`Payment method ${cryptoSymbol} on ${cryptoNetwork} not configured`);
  }
  
  // Get current price
  const price = await getCryptoPrice(cryptoSymbol);
  if (!price) throw new Error('Unable to get price');
  
  // Calculate crypto amount (USDC is 1:1)
  const amountCrypto = cryptoSymbol === 'USDC' ? amountUsd : amountUsd / price;
  
  // Create invoice
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
  
  const { data: invoice, error } = await supabase
    .from('crypto_invoices')
    .insert({
      agent_id: agentId,
      payment_type: paymentType,
      amount_usd: amountUsd,
      amount_crypto: amountCrypto,
      crypto_symbol: cryptoSymbol,
      crypto_network: cryptoNetwork,
      wallet_address: network.wallet_address,
      metadata,
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();
  
  if (error) throw error;
  
  return {
    ...invoice,
    price_at_creation: price,
  };
}

/**
 * Get invoice by code
 */
export async function getInvoice(invoiceCode) {
  const { data, error } = await supabase
    .from('crypto_invoices')
    .select('*')
    .eq('invoice_code', invoiceCode)
    .single();
  
  if (error) return null;
  return data;
}

/**
 * Mark invoice as paid (manual verification or webhook)
 */
export async function markInvoicePaid(invoiceCode, txHash, confirmations = 1) {
  const { data: invoice, error } = await supabase
    .from('crypto_invoices')
    .update({
      status: confirmations >= 1 ? 'completed' : 'confirming',
      tx_hash: txHash,
      confirmations,
      confirmed_at: new Date().toISOString(),
    })
    .eq('invoice_code', invoiceCode)
    .select()
    .single();
  
  if (error) throw error;
  
  // If completed, activate the purchase
  if (invoice.status === 'completed') {
    await activatePurchase(invoice);
  }
  
  return invoice;
}

/**
 * Activate purchase after payment confirmed
 */
async function activatePurchase(invoice) {
  const { payment_type, agent_id, metadata } = invoice;
  
  switch (payment_type) {
    case 'subscription': {
      const tier = metadata.tier || 'premium';
      await supabase
        .from('agents')
        .update({
          subscription_tier: tier,
          badge: tier,
        })
        .eq('id', agent_id);
      break;
    }
    
    case 'sponsored_listing': {
      if (metadata.listing_id) {
        await supabase
          .from('sponsored_listings')
          .update({ status: 'active' })
          .eq('id', metadata.listing_id);
      }
      break;
    }
    
    case 'credits': {
      // Add advertising credits to agent
      // Implementation depends on your credit system
      break;
    }
  }
  
  // Record payment
  await supabase.from('payments').insert({
    agent_id,
    amount_cents: Math.round(invoice.amount_usd * 100),
    currency: invoice.crypto_symbol.toLowerCase(),
    payment_type,
    status: 'succeeded',
    metadata: {
      ...metadata,
      crypto_network: invoice.crypto_network,
      tx_hash: invoice.tx_hash,
      amount_crypto: invoice.amount_crypto,
    },
  });
}

/**
 * Check for expired invoices and mark them
 */
export async function expireOldInvoices() {
  const { data, error } = await supabase
    .from('crypto_invoices')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString())
    .select('id');
  
  return data?.length || 0;
}

/**
 * Generate payment instructions
 */
export function getPaymentInstructions(invoice) {
  const { crypto_symbol, crypto_network, amount_crypto, wallet_address } = invoice;
  
  let instructions = `Send exactly ${amount_crypto.toFixed(8)} ${crypto_symbol} to:\n\n`;
  instructions += `${wallet_address}\n\n`;
  
  if (crypto_network === 'base') {
    instructions += `Network: Base (Coinbase L2)\n`;
    instructions += `⚠️ Make sure you're sending on Base network, not Ethereum mainnet!`;
  } else if (crypto_network === 'ethereum') {
    instructions += `Network: Ethereum Mainnet\n`;
    instructions += `⚠️ Gas fees apply. Consider using Base for lower fees.`;
  } else if (crypto_network === 'lightning') {
    instructions += `Network: Bitcoin Lightning\n`;
    instructions += `⚡ Instant settlement, minimal fees.`;
  } else if (crypto_network === 'bitcoin') {
    instructions += `Network: Bitcoin Mainnet\n`;
    instructions += `Requires 1 confirmation (~10 min).`;
  }
  
  return instructions;
}
