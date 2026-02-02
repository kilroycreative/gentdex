/**
 * Stripe Payment Integration
 * 
 * Handles subscriptions, one-time payments, and webhooks.
 * Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in .env
 */

import Stripe from 'stripe';
import 'dotenv/config';

const stripeKey = process.env.STRIPE_SECRET_KEY;

// Initialize Stripe (will be null if no key configured)
export const stripe = stripeKey ? new Stripe(stripeKey) : null;

// Check if Stripe is configured
export function isStripeConfigured() {
  return !!stripe;
}

// Subscription tier to Stripe price mapping
// You'll create these in Stripe Dashboard and add price IDs here
export const PRICE_IDS = {
  premium_monthly: process.env.STRIPE_PRICE_PREMIUM_MONTHLY || null,
  premium_yearly: process.env.STRIPE_PRICE_PREMIUM_YEARLY || null,
  enterprise_monthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY || null,
  enterprise_yearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY || null,
};

/**
 * Create or retrieve a Stripe customer for an agent
 */
export async function getOrCreateCustomer(agentId, agentName, email) {
  if (!stripe) throw new Error('Stripe not configured');
  
  // Search for existing customer
  const existing = await stripe.customers.search({
    query: `metadata['agent_id']:'${agentId}'`,
  });
  
  if (existing.data.length > 0) {
    return existing.data[0];
  }
  
  // Create new customer
  return await stripe.customers.create({
    name: agentName,
    email: email,
    metadata: {
      agent_id: agentId,
      agent_name: agentName,
    },
  });
}

/**
 * Create a checkout session for subscription
 */
export async function createSubscriptionCheckout({
  customerId,
  priceId,
  successUrl,
  cancelUrl,
  agentId,
  agentName,
}) {
  if (!stripe) throw new Error('Stripe not configured');
  
  return await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      agent_id: agentId,
      agent_name: agentName,
    },
  });
}

/**
 * Create a checkout session for sponsored listing (one-time)
 */
export async function createSponsoredListingCheckout({
  customerId,
  amountCents,
  listingName,
  successUrl,
  cancelUrl,
  agentId,
  listingId,
}) {
  if (!stripe) throw new Error('Stripe not configured');
  
  return await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Sponsored Listing: ${listingName}`,
          description: 'AgentIndex advertising credit',
        },
        unit_amount: amountCents,
      },
      quantity: 1,
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      agent_id: agentId,
      listing_id: listingId,
      payment_type: 'sponsored_listing',
    },
  });
}

/**
 * Cancel a subscription
 */
export async function cancelSubscription(subscriptionId) {
  if (!stripe) throw new Error('Stripe not configured');
  
  return await stripe.subscriptions.cancel(subscriptionId);
}

/**
 * Get subscription details
 */
export async function getSubscription(subscriptionId) {
  if (!stripe) throw new Error('Stripe not configured');
  
  return await stripe.subscriptions.retrieve(subscriptionId);
}

/**
 * Create a billing portal session for customer self-service
 */
export async function createBillingPortal(customerId, returnUrl) {
  if (!stripe) throw new Error('Stripe not configured');
  
  return await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

/**
 * Verify webhook signature
 */
export function verifyWebhookSignature(body, signature) {
  if (!stripe) throw new Error('Stripe not configured');
  
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('Webhook secret not configured');
  
  return stripe.webhooks.constructEvent(body, signature, webhookSecret);
}
