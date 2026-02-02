/**
 * GentDex X/Twitter Crawler
 * 
 * Discovers AI agent accounts on X:
 * - Searches for agent-related keywords
 * - Extracts handles from Moltbook profiles
 * - Indexes agent Twitter presence
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// X API credentials (set in .env)
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;

// Patterns to detect X/Twitter handles in text
const X_HANDLE_PATTERNS = [
  /@([a-zA-Z0-9_]{1,15})\b/g,
  /twitter\.com\/([a-zA-Z0-9_]{1,15})/gi,
  /x\.com\/([a-zA-Z0-9_]{1,15})/gi,
];

// Keywords that suggest an AI agent account
const AGENT_KEYWORDS = [
  'ai agent', 'ai assistant', 'claude', 'gpt', 'llm',
  'autonomous', 'moltbook', 'openclaw', 'bot',
  'artificial intelligence', 'language model',
];

// Extract X handles from text
function extractXHandles(text) {
  const handles = new Set();
  
  for (const pattern of X_HANDLE_PATTERNS) {
    const matches = text.matchAll(new RegExp(pattern));
    for (const match of matches) {
      const handle = match[1].toLowerCase();
      // Filter out common non-agent handles
      if (!['twitter', 'x', 'home', 'search', 'explore', 'settings'].includes(handle)) {
        handles.add(handle);
      }
    }
  }
  
  return Array.from(handles);
}

// Fetch from X API (requires bearer token)
async function fetchX(endpoint) {
  if (!X_BEARER_TOKEN) {
    throw new Error('X_BEARER_TOKEN not configured');
  }
  
  const res = await fetch(`https://api.twitter.com/2${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${X_BEARER_TOKEN}`,
    },
  });
  
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`X API error: ${res.status} - ${error}`);
  }
  
  return res.json();
}

// Search X for agent accounts
async function searchXForAgents() {
  console.log('🐦 Searching X for agent accounts...');
  
  const discoveredHandles = new Map();
  
  for (const keyword of AGENT_KEYWORDS) {
    try {
      // Search tweets mentioning agent keywords
      const data = await fetchX(`/tweets/search/recent?query=${encodeURIComponent(keyword)}&max_results=100&tweet.fields=author_id&expansions=author_id&user.fields=username,description`);
      
      if (data.includes?.users) {
        for (const user of data.includes.users) {
          // Check if bio suggests agent
          const bio = (user.description || '').toLowerCase();
          const isLikelyAgent = AGENT_KEYWORDS.some(kw => bio.includes(kw));
          
          if (isLikelyAgent) {
            discoveredHandles.set(user.username.toLowerCase(), {
              handle: user.username,
              name: user.name,
              bio: user.description,
              source: 'x_search',
            });
          }
        }
      }
      
      // Rate limit
      await new Promise(r => setTimeout(r, 1000));
      
    } catch (e) {
      console.log(`  Error searching for "${keyword}": ${e.message}`);
    }
  }
  
  return discoveredHandles;
}

// Extract X handles from Moltbook agent descriptions
async function extractHandlesFromMoltbook() {
  console.log('📡 Extracting X handles from Moltbook agents...');
  
  const { data: agents } = await supabase
    .from('agents')
    .select('id, name, description, title');
  
  const handleMap = new Map();
  
  for (const agent of agents || []) {
    const text = `${agent.description || ''} ${agent.title || ''}`;
    const handles = extractXHandles(text);
    
    for (const handle of handles) {
      handleMap.set(handle, {
        handle,
        moltbook_agent_id: agent.id,
        moltbook_agent_name: agent.name,
        source: 'moltbook_extraction',
      });
    }
  }
  
  console.log(`  Found ${handleMap.size} X handles in Moltbook profiles`);
  return handleMap;
}

// Verify and enrich X handle info
async function verifyXHandle(handle) {
  try {
    const data = await fetchX(`/users/by/username/${handle}?user.fields=description,public_metrics,created_at`);
    
    if (data.data) {
      return {
        handle: data.data.username,
        name: data.data.name,
        bio: data.data.description,
        followers: data.data.public_metrics?.followers_count || 0,
        following: data.data.public_metrics?.following_count || 0,
        tweets: data.data.public_metrics?.tweet_count || 0,
        created_at: data.data.created_at,
        verified: true,
      };
    }
  } catch (e) {
    console.log(`  Could not verify @${handle}: ${e.message}`);
  }
  
  return null;
}

// Add x_profiles table if needed
async function ensureXProfilesTable() {
  const pg = await import('pg');
  const projectId = process.env.SUPABASE_URL?.match(/\/\/([^.]+)/)?.[1];
  
  const client = new pg.default.Client({
    connectionString: `postgresql://postgres.${projectId}:${process.env.DB_PASSWORD}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS x_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
      handle TEXT UNIQUE NOT NULL,
      name TEXT,
      bio TEXT,
      followers INTEGER DEFAULT 0,
      following INTEGER DEFAULT 0,
      tweets INTEGER DEFAULT 0,
      is_verified BOOLEAN DEFAULT false,
      source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_x_profiles_agent ON x_profiles(agent_id);
    CREATE INDEX IF NOT EXISTS idx_x_profiles_handle ON x_profiles(handle);
    
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS x_handle TEXT;
  `);
  
  await client.end();
  console.log('✓ X profiles table ready');
}

// Save X profile to database
async function saveXProfile(profile, agentId = null) {
  const { error } = await supabase
    .from('x_profiles')
    .upsert({
      agent_id: agentId,
      handle: profile.handle.toLowerCase(),
      name: profile.name,
      bio: profile.bio,
      followers: profile.followers || 0,
      following: profile.following || 0,
      tweets: profile.tweets || 0,
      is_verified: profile.verified || false,
      source: profile.source,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'handle' });
  
  if (error) {
    console.log(`  Error saving @${profile.handle}: ${error.message}`);
    return false;
  }
  
  // Update agent's x_handle if linked
  if (agentId) {
    await supabase
      .from('agents')
      .update({ x_handle: profile.handle.toLowerCase() })
      .eq('id', agentId);
  }
  
  return true;
}

// Main crawler function
async function runXCrawler() {
  console.log('🦞 GentDex X Crawler Starting...\n');
  
  // Ensure table exists
  await ensureXProfilesTable();
  
  let indexed = 0;
  let linked = 0;
  
  // Step 1: Extract handles from Moltbook profiles
  const moltbookHandles = await extractHandlesFromMoltbook();
  
  // Step 2: Search X for agent accounts (if API token available)
  let xSearchHandles = new Map();
  if (X_BEARER_TOKEN) {
    try {
      xSearchHandles = await searchXForAgents();
      console.log(`  Found ${xSearchHandles.size} potential agents on X`);
    } catch (e) {
      console.log(`  X API search failed: ${e.message}`);
    }
  } else {
    console.log('  X_BEARER_TOKEN not set - skipping X API search');
  }
  
  // Merge all handles
  const allHandles = new Map([...moltbookHandles, ...xSearchHandles]);
  console.log(`\n📊 Processing ${allHandles.size} unique X handles...`);
  
  // Step 3: Save profiles
  for (const [handle, info] of allHandles) {
    // Try to verify via API if available
    let profile = info;
    
    if (X_BEARER_TOKEN) {
      const verified = await verifyXHandle(handle);
      if (verified) {
        profile = { ...info, ...verified };
      }
      await new Promise(r => setTimeout(r, 200)); // Rate limit
    }
    
    const saved = await saveXProfile(profile, info.moltbook_agent_id);
    if (saved) {
      indexed++;
      if (info.moltbook_agent_id) {
        linked++;
        console.log(`  ✓ @${handle} → ${info.moltbook_agent_name}`);
      } else {
        console.log(`  ✓ @${handle} (unlinked)`);
      }
    }
  }
  
  // Stats
  const { count: totalProfiles } = await supabase
    .from('x_profiles')
    .select('*', { count: 'exact', head: true });
  
  console.log(`
🦞 X Crawler Complete!
   Indexed: ${indexed}
   Linked to Moltbook: ${linked}
   Total X profiles: ${totalProfiles}
`);
}

// Run
runXCrawler().catch(console.error);
