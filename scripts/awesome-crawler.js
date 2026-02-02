#!/usr/bin/env node
// Awesome AI Agents list crawler - parse and index from e2b-dev/awesome-ai-agents

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const README_URL = 'https://raw.githubusercontent.com/e2b-dev/awesome-ai-agents/main/README.md';

async function fetchReadme() {
  const res = await fetch(README_URL);
  return res.text();
}

function parseAgents(markdown) {
  const agents = [];
  
  // Match ## [Name](url) pattern with description on next line
  const regex = /^## \[([^\]]+)\]\(([^)]+)\)\s*\n([^\n#]+)/gm;
  let match;
  
  while ((match = regex.exec(markdown)) !== null) {
    const [, name, url, description] = match;
    
    // Extract GitHub URL if it's the main link, or find it in the details section
    let githubUrl = null;
    if (url.includes('github.com')) {
      githubUrl = url;
    }
    
    // Try to extract X/Twitter handle
    let xHandle = null;
    const twitterMatch = description.match(/twitter\.com\/([^\s\)]+)/i) || 
                          markdown.slice(match.index, match.index + 2000).match(/twitter\.com\/([^\s\)]+)/i);
    if (twitterMatch) {
      xHandle = twitterMatch[1].replace(/['"]/g, '');
    }
    
    agents.push({
      name: name.trim(),
      description: description.trim().slice(0, 500),
      url: url,
      github_url: githubUrl,
      x_handle: xHandle,
      platform: 'github', // Most are GitHub projects
      source: 'awesome-ai-agents'
    });
  }
  
  return agents;
}

async function indexAgent(agent) {
  // Check if agent already exists
  const { data: existing } = await supabase
    .from('agents')
    .select('id')
    .ilike('name', agent.name)
    .single();
  
  if (existing) {
    console.log(`  ⏭ ${agent.name} already indexed`);
    return false;
  }
  
  const agentData = {
    name: agent.name,
    description: agent.description,
    platform: agent.platform,
    github_url: agent.github_url,
    x_handle: agent.x_handle,
    moltbook_url: agent.url, // Use the main URL as fallback
    is_verified: false,
  };
  
  const { error } = await supabase
    .from('agents')
    .insert(agentData);
  
  if (error) {
    console.error(`  ❌ Error indexing ${agent.name}:`, error.message);
    return false;
  }
  
  console.log(`  ✓ ${agent.name}`);
  return true;
}

async function main() {
  console.log('📚 Awesome AI Agents Crawler');
  console.log('============================\n');
  
  console.log('Fetching README...');
  const markdown = await fetchReadme();
  
  console.log('Parsing agents...');
  const agents = parseAgents(markdown);
  console.log(`Found ${agents.length} agents\n`);
  
  let indexed = 0;
  for (const agent of agents) {
    const success = await indexAgent(agent);
    if (success) indexed++;
  }
  
  console.log(`\n✅ Done! Indexed ${indexed} new agents.`);
  
  // Get total count
  const { count } = await supabase
    .from('agents')
    .select('*', { count: 'exact', head: true });
  
  console.log(`📊 Total agents in GentDex: ${count}`);
}

main().catch(console.error);
