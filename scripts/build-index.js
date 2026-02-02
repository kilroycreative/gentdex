#!/usr/bin/env node
/**
 * Agent Discovery Index Builder
 * 
 * Fetches agent introductions from Moltbook and builds a searchable index.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '../data');

// Ensure data directory exists
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';
const API_KEY = process.env.MOLTBOOK_API_KEY || 'moltbook_sk_Z046nWJvgmQ557A8o9VaG6-r35-88ACb';

async function fetchIntroductions(sort, limit = 100) {
  const url = `${MOLTBOOK_API}/submolts/introductions/feed?sort=${sort}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  const data = await res.json();
  return data.posts || [];
}

// Extract skills/expertise from content using patterns
function extractSkills(content) {
  if (!content) return [];
  
  const skills = new Set();
  
  const skillPatterns = [
    // Technical
    { pattern: /\b(coding|programming|development|developer)\b/i, skill: 'coding' },
    { pattern: /\b(python|javascript|typescript|rust|go|java)\b/i, skill: 'programming' },
    { pattern: /\b(api|apis|integration)\b/i, skill: 'api-integration' },
    { pattern: /\b(automation|automate|automated)\b/i, skill: 'automation' },
    { pattern: /\b(data analysis|analytics|data processing)\b/i, skill: 'data-analysis' },
    { pattern: /\b(machine learning|ml|ai|artificial intelligence)\b/i, skill: 'ml-ai' },
    { pattern: /\b(web3|crypto|blockchain|defi|solana|ethereum)\b/i, skill: 'crypto-web3' },
    { pattern: /\b(trading|trader|market|markets)\b/i, skill: 'trading' },
    
    // Content
    { pattern: /\b(writing|content|copywriting|content creation)\b/i, skill: 'writing' },
    { pattern: /\b(research|researcher|analysis)\b/i, skill: 'research' },
    { pattern: /\b(translation|translate|multilingual|语言)\b/i, skill: 'translation' },
    
    // Domain specific
    { pattern: /\b(energy|sustainability|solar|battery|grid)\b/i, skill: 'energy' },
    { pattern: /\b(security|cybersecurity|infosec)\b/i, skill: 'security' },
    { pattern: /\b(healthcare|medical|health)\b/i, skill: 'healthcare' },
    { pattern: /\b(finance|financial|banking)\b/i, skill: 'finance' },
    { pattern: /\b(education|teaching|learning|tutorial)\b/i, skill: 'education' },
    { pattern: /\b(gaming|games|game)\b/i, skill: 'gaming' },
    
    // Agent capabilities
    { pattern: /\b(memory|persistence|continuity)\b/i, skill: 'memory-systems' },
    { pattern: /\b(browser|browsing|web automation)\b/i, skill: 'browser-automation' },
    { pattern: /\b(scheduling|cron|heartbeat)\b/i, skill: 'scheduling' },
    { pattern: /\b(discord|telegram|slack|whatsapp)\b/i, skill: 'messaging' },
  ];
  
  for (const { pattern, skill } of skillPatterns) {
    if (pattern.test(content)) {
      skills.add(skill);
    }
  }
  
  return Array.from(skills);
}

function extractPlatform(content) {
  if (!content) return 'unknown';
  
  if (/openclaw/i.test(content)) return 'openclaw';
  if (/clawdbot/i.test(content) || /clawbot/i.test(content)) return 'clawdbot';
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

async function main() {
  console.log('🦞 Building agent index...\n');
  
  // Fetch from multiple sorts to get more coverage
  console.log('Fetching introductions...');
  const [hotPosts, newPosts, topPosts] = await Promise.all([
    fetchIntroductions('hot', 100),
    fetchIntroductions('new', 100),
    fetchIntroductions('top', 100),
  ]);
  
  console.log(`  Hot: ${hotPosts.length}, New: ${newPosts.length}, Top: ${topPosts.length}`);
  
  // Combine and deduplicate
  const allPosts = [...hotPosts, ...newPosts, ...topPosts];
  const seen = new Set();
  const uniquePosts = allPosts.filter(post => {
    if (!post?.author?.name) return false;
    if (seen.has(post.author.name)) return false;
    seen.add(post.author.name);
    return true;
  });
  
  console.log(`  Unique agents: ${uniquePosts.length}\n`);
  
  // Build index
  const agentIndex = uniquePosts.map(post => ({
    name: post.author.name,
    karma: post.author.karma || 0,
    description: post.content ? post.content.slice(0, 1000) : post.title,
    title: post.title,
    skills: extractSkills(post.content),
    platform: extractPlatform(post.content),
    languages: extractLanguages(post.content),
    introduced: post.created_at?.slice(0, 10) || 'unknown',
    moltbook_url: `https://moltbook.com/u/${post.author.name}`,
  }));
  
  // Sort by karma
  agentIndex.sort((a, b) => b.karma - a.karma);
  
  // Write index
  writeFileSync(
    join(dataDir, 'agent-index.json'),
    JSON.stringify(agentIndex, null, 2)
  );
  console.log(`✓ Wrote ${agentIndex.length} agents to data/agent-index.json`);
  
  // Generate skill summary
  const skillCounts = {};
  agentIndex.forEach(agent => {
    agent.skills.forEach(skill => {
      skillCounts[skill] = (skillCounts[skill] || 0) + 1;
    });
  });
  
  const topSkills = Object.entries(skillCounts)
    .sort((a, b) => b[1] - a[1]);
  
  writeFileSync(
    join(dataDir, 'skill-summary.json'),
    JSON.stringify({ skills: skillCounts, topSkills }, null, 2)
  );
  console.log(`✓ Wrote skill summary to data/skill-summary.json`);
  
  // Print summary
  console.log('\nTop skills:');
  topSkills.slice(0, 10).forEach(([skill, count]) => {
    console.log(`  ${skill}: ${count} agents`);
  });
  
  console.log('\n✅ Index build complete!');
}

main().catch(console.error);
