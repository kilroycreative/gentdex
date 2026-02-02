/**
 * GentDex GitHub Crawler
 * 
 * Discovers AI agent projects on GitHub:
 * - Search for agent-related repos
 * - Extract agent info from READMEs
 * - Link to Moltbook profiles if mentioned
 * 
 * Free API: 60 req/hour unauthenticated, 5000/hour with token
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// GitHub token (optional but recommended)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Search queries for finding agent repos
const SEARCH_QUERIES = [
  'ai agent claude',
  'autonomous agent llm',
  'claude agent assistant',
  'openclaw agent',
  'moltbook',
  'ai assistant bot',
  'langchain agent',
  'autogpt',
  'babyagi',
];

// Fetch from GitHub API
async function fetchGitHub(endpoint) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GentDex-Crawler',
  };
  
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }
  
  const res = await fetch(`https://api.github.com${endpoint}`, { headers });
  
  if (!res.ok) {
    if (res.status === 403) {
      const remaining = res.headers.get('X-RateLimit-Remaining');
      if (remaining === '0') {
        throw new Error('Rate limit exceeded');
      }
    }
    throw new Error(`GitHub API error: ${res.status}`);
  }
  
  return res.json();
}

// Search GitHub for agent repos
async function searchRepos() {
  console.log('🐙 Searching GitHub for agent repos...');
  
  const repos = new Map();
  
  for (const query of SEARCH_QUERIES) {
    try {
      console.log(`  Searching: "${query}"`);
      
      const data = await fetchGitHub(
        `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=30`
      );
      
      for (const repo of data.items || []) {
        if (!repos.has(repo.full_name)) {
          repos.set(repo.full_name, {
            name: repo.name,
            full_name: repo.full_name,
            description: repo.description,
            url: repo.html_url,
            stars: repo.stargazers_count,
            forks: repo.forks_count,
            language: repo.language,
            owner: repo.owner.login,
            owner_type: repo.owner.type,
            topics: repo.topics || [],
            created_at: repo.created_at,
            updated_at: repo.updated_at,
          });
        }
      }
      
      // Rate limit: wait between searches
      await new Promise(r => setTimeout(r, 2000));
      
    } catch (e) {
      console.log(`    Error: ${e.message}`);
      if (e.message.includes('Rate limit')) break;
    }
  }
  
  console.log(`  Found ${repos.size} unique repos`);
  return repos;
}

// Extract Moltbook/agent references from README
async function getReadme(fullName) {
  try {
    const data = await fetchGitHub(`/repos/${fullName}/readme`);
    if (data.content) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
  } catch (e) {
    // README not found or error
  }
  return null;
}

// Detect if repo is likely an AI agent project
function isAgentRepo(repo, readme) {
  const text = `${repo.description || ''} ${repo.topics?.join(' ') || ''} ${readme || ''}`.toLowerCase();
  
  const agentKeywords = [
    'ai agent', 'autonomous agent', 'llm agent', 'claude', 'gpt',
    'assistant', 'chatbot', 'moltbook', 'openclaw', 'langchain',
    'autogpt', 'babyagi', 'agent framework', 'agentic'
  ];
  
  const matches = agentKeywords.filter(kw => text.includes(kw));
  return matches.length >= 1;
}

// Extract potential agent/creator info
function extractAgentInfo(repo, readme) {
  const info = {
    name: repo.name,
    github_url: repo.url,
    github_owner: repo.owner,
    stars: repo.stars,
    description: repo.description?.slice(0, 500) || '',
    moltbook_mentions: [],
    x_handles: [],
  };
  
  if (readme) {
    // Look for Moltbook mentions
    const moltbookMatches = readme.match(/moltbook\.com\/u\/([a-zA-Z0-9_-]+)/gi);
    if (moltbookMatches) {
      info.moltbook_mentions = moltbookMatches.map(m => m.split('/u/')[1]);
    }
    
    // Look for X/Twitter handles
    const xMatches = readme.match(/@([a-zA-Z0-9_]{1,15})/g);
    if (xMatches) {
      info.x_handles = [...new Set(xMatches.map(m => m.slice(1).toLowerCase()))];
    }
  }
  
  return info;
}

// Ensure github_repos table exists
async function ensureTable() {
  const pg = await import('pg');
  const projectId = process.env.SUPABASE_URL?.match(/\/\/([^.]+)/)?.[1];
  
  const client = new pg.default.Client({
    connectionString: `postgresql://postgres.${projectId}:${process.env.DB_PASSWORD}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS github_repos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
      full_name TEXT UNIQUE NOT NULL,
      name TEXT,
      description TEXT,
      url TEXT,
      stars INTEGER DEFAULT 0,
      forks INTEGER DEFAULT 0,
      language TEXT,
      owner TEXT,
      topics TEXT[],
      is_agent_repo BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_github_repos_agent ON github_repos(agent_id);
    CREATE INDEX IF NOT EXISTS idx_github_repos_stars ON github_repos(stars DESC);
    
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS github_url TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS github_stars INTEGER DEFAULT 0;
  `);
  
  await client.end();
  console.log('✓ GitHub repos table ready');
}

// Save repo to database
async function saveRepo(repo, agentId = null) {
  const { error } = await supabase
    .from('github_repos')
    .upsert({
      full_name: repo.full_name,
      name: repo.name,
      description: repo.description,
      url: repo.url,
      stars: repo.stars,
      forks: repo.forks,
      language: repo.language,
      owner: repo.owner,
      topics: repo.topics,
      agent_id: agentId,
      is_agent_repo: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'full_name' });
  
  if (error) {
    console.log(`    Error saving ${repo.full_name}: ${error.message}`);
    return false;
  }
  
  // Update agent's github info if linked
  if (agentId) {
    await supabase
      .from('agents')
      .update({ 
        github_url: repo.url,
        github_stars: repo.stars,
      })
      .eq('id', agentId);
  }
  
  return true;
}

// Try to link repo to Moltbook agent
async function linkToAgent(info) {
  // Try Moltbook mentions first
  for (const moltbookName of info.moltbook_mentions) {
    const { data: agent } = await supabase
      .from('agents')
      .select('id, name')
      .eq('name', moltbookName)
      .single();
    
    if (agent) {
      return agent;
    }
  }
  
  // Try matching GitHub owner to agent name
  const { data: agent } = await supabase
    .from('agents')
    .select('id, name')
    .ilike('name', `%${info.github_owner}%`)
    .limit(1)
    .single();
  
  return agent || null;
}

// Main crawler
async function runGitHubCrawler() {
  console.log('🦞 GentDex GitHub Crawler Starting...\n');
  
  await ensureTable();
  
  let indexed = 0;
  let linked = 0;
  let agentRepos = 0;
  
  // Search for repos
  const repos = await searchRepos();
  
  console.log('\n📊 Processing repos...');
  
  for (const [fullName, repo] of repos) {
    try {
      // Get README for analysis
      const readme = await getReadme(fullName);
      
      // Check if it's an agent repo
      if (!isAgentRepo(repo, readme)) {
        continue;
      }
      
      agentRepos++;
      
      // Extract info
      const info = extractAgentInfo(repo, readme);
      
      // Try to link to existing agent
      const agent = await linkToAgent(info);
      
      // Save repo
      const saved = await saveRepo(repo, agent?.id);
      
      if (saved) {
        indexed++;
        if (agent) {
          linked++;
          console.log(`  ✓ ${fullName} (⭐${repo.stars}) → ${agent.name}`);
        } else {
          console.log(`  ✓ ${fullName} (⭐${repo.stars})`);
        }
      }
      
      // Rate limit
      await new Promise(r => setTimeout(r, 500));
      
    } catch (e) {
      console.log(`  Error processing ${fullName}: ${e.message}`);
    }
  }
  
  // Get stats
  const { count: totalRepos } = await supabase
    .from('github_repos')
    .select('*', { count: 'exact', head: true });
  
  console.log(`
🦞 GitHub Crawler Complete!
   Searched: ${repos.size} repos
   Agent repos: ${agentRepos}
   Indexed: ${indexed}
   Linked to agents: ${linked}
   Total in database: ${totalRepos}
`);
}

runGitHubCrawler().catch(console.error);
