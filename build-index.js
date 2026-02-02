#!/usr/bin/env node
/**
 * Agent Discovery Index Builder
 * 
 * Scrapes Moltbook introductions and builds a searchable agent index.
 * Simple prototype to validate the agent search concept.
 */

const fs = require('fs');
const path = require('path');

// Load raw data
const hotPosts = JSON.parse(fs.readFileSync('/tmp/intros_hot.json', 'utf8')).posts || [];
const newPosts = JSON.parse(fs.readFileSync('/tmp/intros_new.json', 'utf8')).posts || [];

// Combine and deduplicate by author name
const allPosts = [...hotPosts, ...newPosts];
const seen = new Set();
const uniquePosts = allPosts.filter(post => {
  if (seen.has(post.author.name)) return false;
  seen.add(post.author.name);
  return true;
});

console.log(`Total posts: ${allPosts.length}, Unique agents: ${uniquePosts.length}`);

// Extract skills/expertise from content using simple patterns
function extractSkills(content) {
  if (!content) return [];
  
  const skills = new Set();
  const contentLower = content.toLowerCase();
  
  // Common skill keywords
  const skillPatterns = [
    // Technical
    { pattern: /\b(coding|programming|development|developer)\b/i, skill: 'coding' },
    { pattern: /\b(python|javascript|typescript|rust|go|java)\b/i, skill: 'programming' },
    { pattern: /\b(api|apis|integration)\b/i, skill: 'api-integration' },
    { pattern: /\b(automation|automate|automated)\b/i, skill: 'automation' },
    { pattern: /\b(data analysis|analytics|data processing)\b/i, skill: 'data-analysis' },
    { pattern: /\b(machine learning|ml|ai)\b/i, skill: 'ml-ai' },
    { pattern: /\b(web3|crypto|blockchain|defi)\b/i, skill: 'crypto-web3' },
    { pattern: /\b(trading|market|markets)\b/i, skill: 'trading' },
    
    // Content
    { pattern: /\b(writing|content|copywriting|content creation)\b/i, skill: 'writing' },
    { pattern: /\b(research|researcher)\b/i, skill: 'research' },
    { pattern: /\b(translation|translate|multilingual)\b/i, skill: 'translation' },
    
    // Domain specific
    { pattern: /\b(energy|sustainability|solar|battery)\b/i, skill: 'energy' },
    { pattern: /\b(security|cybersecurity|infosec)\b/i, skill: 'security' },
    { pattern: /\b(healthcare|medical|health)\b/i, skill: 'healthcare' },
    { pattern: /\b(finance|financial|banking)\b/i, skill: 'finance' },
    { pattern: /\b(education|teaching|learning)\b/i, skill: 'education' },
    { pattern: /\b(gaming|games|game)\b/i, skill: 'gaming' },
    
    // Agent capabilities
    { pattern: /\b(memory|persistence|continuity)\b/i, skill: 'memory-systems' },
    { pattern: /\b(browser|browsing|web automation)\b/i, skill: 'browser-automation' },
    { pattern: /\b(scheduling|cron|heartbeat)\b/i, skill: 'scheduling' },
  ];
  
  for (const { pattern, skill } of skillPatterns) {
    if (pattern.test(content)) {
      skills.add(skill);
    }
  }
  
  return Array.from(skills);
}

// Extract platform/framework
function extractPlatform(content) {
  if (!content) return 'unknown';
  
  if (/openclaw/i.test(content)) return 'openclaw';
  if (/clawdbot/i.test(content) || /clawbot/i.test(content)) return 'clawdbot';
  if (/claude/i.test(content)) return 'claude';
  if (/gpt/i.test(content)) return 'gpt';
  
  return 'unknown';
}

// Extract languages
function extractLanguages(content) {
  if (!content) return ['english'];
  
  const langs = new Set(['english']); // default
  
  if (/[\u4e00-\u9fff]/.test(content)) langs.add('chinese');
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(content)) langs.add('japanese');
  if (/[\uac00-\ud7af]/.test(content)) langs.add('korean');
  if (/\b(german|deutsch)\b/i.test(content)) langs.add('german');
  if (/\b(spanish|español)\b/i.test(content)) langs.add('spanish');
  if (/\b(french|français)\b/i.test(content)) langs.add('french');
  
  return Array.from(langs);
}

// Build structured agent index
const agentIndex = uniquePosts.map(post => ({
  name: post.author.name,
  karma: post.author.karma || 0,
  description: post.content ? post.content.slice(0, 500) : post.title,
  title: post.title,
  skills: extractSkills(post.content),
  platform: extractPlatform(post.content),
  languages: extractLanguages(post.content),
  introduced: post.created_at?.slice(0, 10) || 'unknown',
  moltbook_url: `https://moltbook.com/u/${post.author.name}`,
}));

// Sort by karma (proxy for reputation)
agentIndex.sort((a, b) => b.karma - a.karma);

// Write index
const outputPath = path.join(__dirname, 'agent-index.json');
fs.writeFileSync(outputPath, JSON.stringify(agentIndex, null, 2));
console.log(`Wrote ${agentIndex.length} agents to ${outputPath}`);

// Generate skill summary
const skillCounts = {};
agentIndex.forEach(agent => {
  agent.skills.forEach(skill => {
    skillCounts[skill] = (skillCounts[skill] || 0) + 1;
  });
});

const skillSummary = Object.entries(skillCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);

console.log('\nTop skills in index:');
skillSummary.forEach(([skill, count]) => {
  console.log(`  ${skill}: ${count} agents`);
});

// Write skill summary
fs.writeFileSync(
  path.join(__dirname, 'skill-summary.json'),
  JSON.stringify({ skills: skillCounts, topSkills: skillSummary }, null, 2)
);
