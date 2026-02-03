#!/usr/bin/env node
// Extended GitHub crawler - search for trading bots, crypto agents, etc.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SEARCHES = [
  'polymarket bot',
  'polymarket trading',
  'crypto trading bot',
  'defi bot',
  'MEV bot',
  'arbitrage bot crypto',
  'prediction market bot',
  'automated trading agent',
  'AI trading bot',
  'LLM agent framework',
  'autonomous agent',
  'AI assistant framework',
];

async function searchGitHub(query) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=30`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'GentDex-Crawler'
    }
  });
  
  if (!res.ok) {
    console.error(`  GitHub API error for "${query}": ${res.status}`);
    return [];
  }
  
  const data = await res.json();
  return data.items || [];
}

async function indexRepo(repo) {
  // Check if already exists
  const { data: existing } = await supabase
    .from('agents')
    .select('id')
    .eq('github_url', repo.html_url)
    .single();
  
  if (existing) {
    return { status: 'skip', name: repo.name };
  }
  
  // Also check by name
  const { data: byName } = await supabase
    .from('agents')
    .select('id')
    .ilike('name', repo.name)
    .single();
  
  if (byName) {
    return { status: 'skip', name: repo.name };
  }
  
  const skills = repo.topics?.slice(0, 5) || [];
  
  const agentData = {
    name: repo.name,
    description: repo.description?.slice(0, 500) || `${repo.name} - GitHub project`,
    platform: 'github',
    github_url: repo.html_url,
    moltbook_url: repo.html_url,
    karma: repo.stargazers_count || 0,
    is_verified: false,
  };
  
  const { error } = await supabase
    .from('agents')
    .insert(agentData);
  
  if (error) {
    return { status: 'error', name: repo.name, error: error.message };
  }
  
  // Add skills if we have them
  if (skills.length > 0) {
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('github_url', repo.html_url)
      .single();
    
    if (agent) {
      for (const skill of skills) {
        // Get or create skill
        let { data: skillRow } = await supabase
          .from('skills')
          .select('id')
          .eq('name', skill)
          .single();
        
        if (!skillRow) {
          const { data: newSkill } = await supabase
            .from('skills')
            .insert({ name: skill })
            .select('id')
            .single();
          skillRow = newSkill;
        }
        
        if (skillRow) {
          await supabase.from('agent_skills').insert({
            agent_id: agent.id,
            skill_id: skillRow.id
          }).select();
        }
      }
    }
  }
  
  return { status: 'indexed', name: repo.name, stars: repo.stargazers_count };
}

async function main() {
  console.log('🔍 Extended GitHub Crawler');
  console.log('==========================\n');
  
  let totalIndexed = 0;
  let totalSkipped = 0;
  
  for (const query of SEARCHES) {
    console.log(`\nSearching: "${query}"...`);
    
    try {
      const repos = await searchGitHub(query);
      console.log(`  Found ${repos.length} repos`);
      
      for (const repo of repos) {
        const result = await indexRepo(repo);
        if (result.status === 'indexed') {
          console.log(`  ✓ ${result.name} (⭐ ${result.stars})`);
          totalIndexed++;
        } else if (result.status === 'skip') {
          totalSkipped++;
        } else {
          console.log(`  ❌ ${result.name}: ${result.error}`);
        }
      }
      
      // Rate limit - GitHub allows 10 requests/min unauthenticated
      await new Promise(r => setTimeout(r, 6000));
      
    } catch (e) {
      console.error(`  Error: ${e.message}`);
    }
  }
  
  console.log(`\n✅ Done!`);
  console.log(`   Indexed: ${totalIndexed}`);
  console.log(`   Skipped: ${totalSkipped}`);
  
  // Get total count
  const { count } = await supabase
    .from('agents')
    .select('*', { count: 'exact', head: true });
  
  console.log(`📊 Total agents in GentDex: ${count}`);
}

main().catch(console.error);
