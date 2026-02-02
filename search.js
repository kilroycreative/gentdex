#!/usr/bin/env node
/**
 * Agent Discovery Search
 * 
 * Simple semantic search over the agent index.
 * Usage: node search.js "query"
 */

const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'agent-index.json');
const agents = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

const query = process.argv.slice(2).join(' ').toLowerCase();

if (!query) {
  console.log('Usage: node search.js "query"');
  console.log('Examples:');
  console.log('  node search.js "crypto trading"');
  console.log('  node search.js "energy sustainability"');
  console.log('  node search.js "automation api"');
  process.exit(0);
}

// Simple scoring function
function scoreAgent(agent, queryTerms) {
  let score = 0;
  
  // Skill matches (highest weight)
  for (const skill of agent.skills) {
    for (const term of queryTerms) {
      if (skill.includes(term) || term.includes(skill.split('-')[0])) {
        score += 10;
      }
    }
  }
  
  // Description matches
  const desc = (agent.description || '').toLowerCase();
  for (const term of queryTerms) {
    if (desc.includes(term)) {
      score += 3;
    }
  }
  
  // Title matches
  const title = (agent.title || '').toLowerCase();
  for (const term of queryTerms) {
    if (title.includes(term)) {
      score += 2;
    }
  }
  
  // Karma bonus (reputation)
  score += Math.log10(agent.karma + 1) * 0.5;
  
  return score;
}

// Search
const queryTerms = query.split(/\s+/).filter(t => t.length > 2);
const results = agents
  .map(agent => ({ ...agent, score: scoreAgent(agent, queryTerms) }))
  .filter(agent => agent.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, 10);

// Output
console.log(`\n🔍 Search: "${query}"\n`);
console.log(`Found ${results.length} matching agents:\n`);

results.forEach((agent, i) => {
  console.log(`${i + 1}. ${agent.name} (karma: ${agent.karma}, score: ${agent.score.toFixed(1)})`);
  console.log(`   Skills: ${agent.skills.join(', ') || 'none detected'}`);
  console.log(`   Platform: ${agent.platform}`);
  console.log(`   ${agent.description?.slice(0, 150)}...`);
  console.log(`   ${agent.moltbook_url}\n`);
});

// Also output as JSON for programmatic use
if (process.env.JSON_OUTPUT) {
  console.log('\n--- JSON ---\n');
  console.log(JSON.stringify(results.map(r => ({
    name: r.name,
    karma: r.karma,
    score: r.score,
    skills: r.skills,
    url: r.moltbook_url,
  })), null, 2));
}
