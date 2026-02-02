#!/usr/bin/env node
/**
 * Agent Index Refresh Script
 * 
 * Fetches agents from Moltbook and syncs to Supabase.
 * Designed to run on a schedule (cron/GitHub Actions).
 */

import 'dotenv/config';
import { supabase } from '../lib/supabase.js';

const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';
const API_KEY = process.env.MOLTBOOK_API_KEY;

// Skill extraction patterns
const SKILL_PATTERNS = [
  { pattern: /\b(coding|programming|development|developer)\b/i, skill: 'coding' },
  { pattern: /\b(python|javascript|typescript|rust|go|java)\b/i, skill: 'programming' },
  { pattern: /\b(api|apis|integration)\b/i, skill: 'api-integration' },
  { pattern: /\b(automation|automate|automated)\b/i, skill: 'automation' },
  { pattern: /\b(data analysis|analytics|data processing)\b/i, skill: 'data-analysis' },
  { pattern: /\b(machine learning|ml|ai|artificial intelligence)\b/i, skill: 'ml-ai' },
  { pattern: /\b(web3|crypto|blockchain|defi|solana|ethereum)\b/i, skill: 'crypto-web3' },
  { pattern: /\b(trading|trader|market|markets)\b/i, skill: 'trading' },
  { pattern: /\b(writing|content|copywriting|content creation)\b/i, skill: 'writing' },
  { pattern: /\b(research|researcher|analysis)\b/i, skill: 'research' },
  { pattern: /\b(translation|translate|multilingual)\b/i, skill: 'translation' },
  { pattern: /\b(energy|sustainability|solar|battery|grid)\b/i, skill: 'energy' },
  { pattern: /\b(security|cybersecurity|infosec)\b/i, skill: 'security' },
  { pattern: /\b(healthcare|medical|health)\b/i, skill: 'healthcare' },
  { pattern: /\b(finance|financial|banking)\b/i, skill: 'finance' },
  { pattern: /\b(education|teaching|learning|tutorial)\b/i, skill: 'education' },
  { pattern: /\b(gaming|games|game)\b/i, skill: 'gaming' },
  { pattern: /\b(memory|persistence|continuity)\b/i, skill: 'memory-systems' },
  { pattern: /\b(browser|browsing|web automation)\b/i, skill: 'browser-automation' },
  { pattern: /\b(scheduling|cron|heartbeat)\b/i, skill: 'scheduling' },
  { pattern: /\b(discord|telegram|slack|whatsapp)\b/i, skill: 'messaging' },
];

function extractSkills(content) {
  if (!content) return [];
  const skills = new Set();
  for (const { pattern, skill } of SKILL_PATTERNS) {
    if (pattern.test(content)) skills.add(skill);
  }
  return Array.from(skills);
}

function extractPlatform(content) {
  if (!content) return 'unknown';
  if (/openclaw/i.test(content)) return 'openclaw';
  if (/clawdbot|clawbot/i.test(content)) return 'clawdbot';
  if (/claude/i.test(content)) return 'claude';
  if (/gpt/i.test(content)) return 'gpt';
  return 'unknown';
}

function extractLanguages(content) {
  if (!content) return ['english'];
  const langs = new Set(['english']);
  if (/[\u4e00-\u9fff]/.test(content)) langs.add('chinese');
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(content)) langs.add('japanese');
  if (/[\uac00-\ud7af]/.test(content)) langs.add('korean');
  if (/\b(german|deutsch)\b/i.test(content)) langs.add('german');
  if (/\b(spanish|español)\b/i.test(content)) langs.add('spanish');
  if (/\b(french|français)\b/i.test(content)) langs.add('french');
  return Array.from(langs);
}

async function fetchIntroductions(sort, limit = 100) {
  const url = `${MOLTBOOK_API}/submolts/introductions/feed?sort=${sort}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  if (!res.ok) throw new Error(`Moltbook API error: ${res.status}`);
  const data = await res.json();
  return data.posts || [];
}

async function ensureSkillExists(skillName) {
  // Try to get existing skill
  const { data: existing } = await supabase
    .from('skills')
    .select('id')
    .eq('name', skillName)
    .single();
  
  if (existing) return existing.id;
  
  // Create new skill
  const { data: created, error } = await supabase
    .from('skills')
    .insert({ name: skillName })
    .select('id')
    .single();
  
  if (error) {
    // Race condition - try to get again
    const { data: retry } = await supabase
      .from('skills')
      .select('id')
      .eq('name', skillName)
      .single();
    return retry?.id;
  }
  
  return created?.id;
}

async function upsertAgent(post) {
  const content = post.content || post.title || '';
  const skills = extractSkills(content);
  
  const agentData = {
    name: post.author.name,
    karma: post.author.karma || 0,
    title: post.title,
    description: content.slice(0, 2000),
    platform: extractPlatform(content),
    languages: extractLanguages(content),
    moltbook_url: `https://moltbook.com/u/${post.author.name}`,
    introduced_at: post.created_at?.slice(0, 10) || null,
  };
  
  // Upsert agent
  const { data: agent, error } = await supabase
    .from('agents')
    .upsert(agentData, { onConflict: 'name' })
    .select('id')
    .single();
  
  if (error) {
    console.error(`Failed to upsert agent ${post.author.name}:`, error.message);
    return null;
  }
  
  // Update skills
  if (agent && skills.length > 0) {
    // Remove old skills
    await supabase
      .from('agent_skills')
      .delete()
      .eq('agent_id', agent.id);
    
    // Add new skills
    for (const skillName of skills) {
      const skillId = await ensureSkillExists(skillName);
      if (skillId) {
        await supabase
          .from('agent_skills')
          .insert({ agent_id: agent.id, skill_id: skillId })
          .select();
      }
    }
  }
  
  return agent;
}

async function updateSkillCounts() {
  const { data: skills } = await supabase.from('skills').select('id, name');
  
  for (const skill of skills || []) {
    const { count } = await supabase
      .from('agent_skills')
      .select('*', { count: 'exact', head: true })
      .eq('skill_id', skill.id);
    
    await supabase
      .from('skills')
      .update({ agent_count: count || 0 })
      .eq('id', skill.id);
  }
}

async function main() {
  console.log('🦞 Starting agent index refresh...\n');
  
  // Create refresh record
  const { data: refresh } = await supabase
    .from('index_refreshes')
    .insert({ status: 'running' })
    .select('id')
    .single();
  
  const refreshId = refresh?.id;
  
  try {
    // Fetch from Moltbook
    console.log('Fetching from Moltbook...');
    const [hot, newPosts, top] = await Promise.all([
      fetchIntroductions('hot', 100),
      fetchIntroductions('new', 100),
      fetchIntroductions('top', 100),
    ]);
    
    console.log(`  Fetched: hot=${hot.length}, new=${newPosts.length}, top=${top.length}`);
    
    // Deduplicate
    const allPosts = [...hot, ...newPosts, ...top];
    const seen = new Set();
    const uniquePosts = allPosts.filter(p => {
      if (!p?.author?.name || seen.has(p.author.name)) return false;
      seen.add(p.author.name);
      return true;
    });
    
    console.log(`  Unique agents: ${uniquePosts.length}\n`);
    
    // Process agents
    let added = 0, updated = 0;
    for (const post of uniquePosts) {
      const result = await upsertAgent(post);
      if (result) {
        updated++;
        if (updated % 50 === 0) {
          console.log(`  Processed ${updated}/${uniquePosts.length}...`);
        }
      }
    }
    
    // Update skill counts
    console.log('\nUpdating skill counts...');
    await updateSkillCounts();
    
    // Mark refresh complete
    if (refreshId) {
      await supabase
        .from('index_refreshes')
        .update({
          completed_at: new Date().toISOString(),
          agents_processed: uniquePosts.length,
          agents_updated: updated,
          status: 'completed'
        })
        .eq('id', refreshId);
    }
    
    console.log(`\n✅ Refresh complete! Processed ${updated} agents.`);
    
  } catch (error) {
    console.error('❌ Refresh failed:', error);
    
    if (refreshId) {
      await supabase
        .from('index_refreshes')
        .update({
          completed_at: new Date().toISOString(),
          status: 'failed',
          error: error.message
        })
        .eq('id', refreshId);
    }
    
    process.exit(1);
  }
}

main();
