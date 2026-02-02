#!/usr/bin/env node
// Virtuals Protocol crawler - index agents from virtuals.io

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const VIRTUALS_API = 'https://api.virtuals.io/api/virtuals';

async function fetchVirtualsAgents(offset = 0, limit = 100) {
  const url = `${VIRTUALS_API}?offset=${offset}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Virtuals API error: ${res.status}`);
  const data = await res.json();
  return data.data || [];
}

async function indexAgent(agent) {
  // Extract X handle from socials
  let xHandle = null;
  if (agent.socials?.x || agent.socials?.TWITTER) {
    const xUrl = agent.socials.x || agent.socials.TWITTER;
    const match = xUrl.match(/x\.com\/([^\/\?]+)/);
    if (match) xHandle = match[1];
  }
  
  // Check if agent already exists
  const { data: existing } = await supabase
    .from('agents')
    .select('id')
    .eq('name', agent.name)
    .eq('platform', 'virtuals')
    .single();
  
  if (existing) {
    console.log(`  ⏭ ${agent.name} already indexed`);
    return false;
  }
  
  const agentData = {
    name: agent.name,
    description: agent.description?.slice(0, 1000) || `${agent.name} on Virtuals Protocol`,
    platform: 'virtuals',
    x_handle: xHandle,
    is_verified: true,
    moltbook_url: `https://app.virtuals.io/virtuals/${agent.id}`,
  };
  
  const { error } = await supabase
    .from('agents')
    .insert(agentData);
  
  if (error) {
    console.error(`  ❌ Error indexing ${agent.name}:`, error.message);
    return false;
  }
  
  console.log(`  ✓ ${agent.name}${xHandle ? ` (@${xHandle})` : ''}`);
  return true;
}

async function main() {
  console.log('🔮 Virtuals Protocol Crawler');
  console.log('============================\n');
  
  let offset = 0;
  const limit = 100;
  let totalIndexed = 0;
  let hasMore = true;
  
  while (hasMore) {
    console.log(`Fetching agents ${offset} - ${offset + limit}...`);
    
    try {
      const agents = await fetchVirtualsAgents(offset, limit);
      
      if (agents.length === 0) {
        hasMore = false;
        break;
      }
      
      for (const agent of agents) {
        const indexed = await indexAgent(agent);
        if (indexed) totalIndexed++;
      }
      
      offset += limit;
      
      // Rate limit
      await new Promise(r => setTimeout(r, 500));
      
      // Stop after 1000 for now
      if (offset >= 1000) {
        console.log('\nReached 1000 agent limit for this run.');
        break;
      }
      
    } catch (e) {
      console.error('Error:', e.message);
      hasMore = false;
    }
  }
  
  console.log(`\n✅ Done! Indexed ${totalIndexed} new agents from Virtuals.`);
  
  // Get total count
  const { count } = await supabase
    .from('agents')
    .select('*', { count: 'exact', head: true });
  
  console.log(`📊 Total agents in GentDex: ${count}`);
}

main().catch(console.error);
