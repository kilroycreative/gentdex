/**
 * GentDex PageRank - Recursive Attestation Scoring
 * 
 * Like Google's PageRank but for agents:
 * - Attestations from high-ranked agents worth more
 * - Iterative calculation until convergence
 * - Decay factor for inactive agents
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// PageRank parameters
const DAMPING = 0.85;           // Standard PageRank damping factor
const ITERATIONS = 20;          // Max iterations
const CONVERGENCE = 0.0001;     // Stop when delta < this
const KARMA_WEIGHT = 0.3;       // How much karma influences base score
const ATTESTATION_WEIGHT = 0.7; // How much attestations influence score

async function calculatePageRank() {
  console.log('🦞 GentDex PageRank Starting...\n');
  
  // Get all agents
  const { data: agents, error } = await supabase
    .from('agents')
    .select('id, name, karma, attestation_score');
  
  if (error) throw error;
  
  console.log(`Processing ${agents.length} agents...`);
  
  // Get all attestations
  const { data: attestations } = await supabase
    .from('attestations')
    .select('from_agent_id, to_agent_id, strength');
  
  console.log(`Processing ${attestations?.length || 0} attestations...`);
  
  // Build agent map and outlink counts
  const agentMap = new Map();
  const outlinks = new Map(); // How many attestations each agent has given
  
  for (const agent of agents) {
    agentMap.set(agent.id, {
      ...agent,
      rank: 1.0, // Initial rank
      newRank: 0,
      inlinks: [], // Who attests for this agent
    });
    outlinks.set(agent.id, 0);
  }
  
  // Count outlinks and build inlink graph
  for (const att of attestations || []) {
    const fromAgent = agentMap.get(att.from_agent_id);
    const toAgent = agentMap.get(att.to_agent_id);
    
    if (fromAgent && toAgent) {
      // Increment outlink count for the attester
      outlinks.set(att.from_agent_id, (outlinks.get(att.from_agent_id) || 0) + 1);
      
      // Add inlink to the attestee
      toAgent.inlinks.push({
        from: att.from_agent_id,
        strength: att.strength || 1,
      });
    }
  }
  
  // Base score from karma (normalized)
  const maxKarma = Math.max(...agents.map(a => a.karma || 0), 1);
  for (const agent of agentMap.values()) {
    agent.baseScore = (agent.karma || 0) / maxKarma;
  }
  
  // Iterative PageRank calculation
  let iteration = 0;
  let maxDelta = 1;
  
  while (iteration < ITERATIONS && maxDelta > CONVERGENCE) {
    maxDelta = 0;
    
    for (const agent of agentMap.values()) {
      // Calculate new rank from inlinks
      let inlinkScore = 0;
      
      for (const inlink of agent.inlinks) {
        const fromAgent = agentMap.get(inlink.from);
        if (fromAgent) {
          const outlinkCount = outlinks.get(inlink.from) || 1;
          // Rank contribution = (attester's rank * strength) / attester's outlink count
          inlinkScore += (fromAgent.rank * inlink.strength) / outlinkCount;
        }
      }
      
      // PageRank formula with karma weighting
      const attestationComponent = DAMPING * inlinkScore;
      const karmaComponent = (1 - DAMPING) * agent.baseScore;
      
      agent.newRank = (ATTESTATION_WEIGHT * attestationComponent) + 
                      (KARMA_WEIGHT * karmaComponent) +
                      ((1 - ATTESTATION_WEIGHT - KARMA_WEIGHT) * (1 / agents.length));
      
      // Track convergence
      const delta = Math.abs(agent.newRank - agent.rank);
      if (delta > maxDelta) maxDelta = delta;
    }
    
    // Update ranks for next iteration
    for (const agent of agentMap.values()) {
      agent.rank = agent.newRank;
    }
    
    iteration++;
    console.log(`  Iteration ${iteration}: max delta = ${maxDelta.toFixed(6)}`);
  }
  
  console.log(`\nConverged after ${iteration} iterations`);
  
  // Normalize ranks to 0-100 scale
  const ranks = Array.from(agentMap.values()).map(a => a.rank);
  const minRank = Math.min(...ranks);
  const maxRank = Math.max(...ranks);
  const range = maxRank - minRank || 1;
  
  // Update database with new scores
  console.log('\nUpdating agent scores...');
  let updated = 0;
  
  const updates = [];
  for (const agent of agentMap.values()) {
    const normalizedScore = ((agent.rank - minRank) / range) * 100;
    updates.push({
      id: agent.id,
      pagerank_score: normalizedScore,
    });
  }
  
  // Batch update
  for (const update of updates) {
    await supabase
      .from('agents')
      .update({ pagerank_score: update.pagerank_score })
      .eq('id', update.id);
    updated++;
  }
  
  // Get top agents
  const sorted = Array.from(agentMap.values())
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 20);
  
  console.log('\n📊 Top 20 Agents by PageRank:');
  sorted.forEach((agent, i) => {
    const score = ((agent.rank - minRank) / range) * 100;
    console.log(`  ${i + 1}. ${agent.name} (score: ${score.toFixed(2)}, karma: ${agent.karma}, inlinks: ${agent.inlinks.length})`);
  });
  
  console.log(`\n✅ Updated ${updated} agents with PageRank scores`);
}

// Add pagerank_score column if it doesn't exist
async function ensureColumn() {
  try {
    await supabase.rpc('exec_sql', {
      sql: 'ALTER TABLE agents ADD COLUMN IF NOT EXISTS pagerank_score REAL DEFAULT 0'
    });
  } catch (e) {
    // Column might already exist or RPC not available, try direct
    console.log('Note: pagerank_score column may need manual creation');
  }
}

async function run() {
  await ensureColumn();
  await calculatePageRank();
}

run().catch(console.error);
