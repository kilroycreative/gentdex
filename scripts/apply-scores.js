#!/usr/bin/env node
/**
 * Fast quality score writer — uses direct Postgres for batch updates
 */

import 'dotenv/config';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function computeQualityScore(agent) {
  let score = 0;
  
  // Description quality (0-25)
  const descLen = (agent.description || '').length;
  if (descLen >= 200) score += 25;
  else if (descLen >= 100) score += 18;
  else if (descLen >= 50) score += 10;
  else if (descLen >= 20) score += 5;
  
  // Title quality (0-10) — GitHub agents don't have titles, so be lenient
  const titleLen = (agent.title || '').length;
  if (titleLen > 0 && titleLen !== descLen) score += 10;
  else if (titleLen > 0) score += 5;
  else if (agent.platform === 'github') score += 3; // no penalty for github missing title
  
  // GitHub stars (0-30)
  const stars = agent.github_stars || 0;
  if (stars > 0) {
    score += Math.min(30, Math.round(Math.log10(stars + 1) * 10));
  } else if (stars === -1) {
    score -= 10;
  }
  
  // Karma (0-15)
  const karma = agent.karma || 0;
  if (karma > 0) {
    score += Math.min(15, Math.round(Math.log10(karma + 1) * 5));
  }
  
  // Platform (0-5)
  if (agent.platform === 'github' && agent.github_url) score += 5;
  else if (['moltbook', 'virtuals'].includes(agent.platform)) score += 3;
  
  // Intro + verified + pagerank (0-15)
  if (agent.introduced_at) score += 5;
  if (agent.is_verified) score += 5;
  if (agent.pagerank_score > 0.01) score += 5;
  else if (agent.pagerank_score > 0) score += 2;
  
  // Penalties
  if ((agent.name || '').length <= 2) score -= 15;
  
  if (agent.title && agent.description && 
      agent.title.trim() === agent.description.trim().slice(0, agent.title.trim().length)) {
    score -= 5;
  }
  
  const text = `${agent.name || ''} ${agent.title || ''} ${agent.description || ''}`.toLowerCase();
  const nonAgent = [/\blibrary\b/, /\bsdk\b/, /\bboilerplate\b/, /\bstarter\s*(code|kit|template)?\b/,
    /\bdataset\b/, /\btutorial\b/, /\bcourse\b/, /\btextbook\b/, /\bawesome[- ]list\b/, /\bcurated\s*list\b/];
  for (const p of nonAgent) {
    if (p.test(text)) { score -= 10; break; }
  }
  
  return Math.max(0, Math.min(100, score));
}

async function main() {
  const CLEAN = process.argv.includes('--clean');
  
  // Get all agents (paginate past Supabase 1000 limit)
  let agents = [];
  let page = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) { console.error(error); process.exit(1); }
    if (!data || data.length === 0) break;
    agents = agents.concat(data);
    if (data.length < pageSize) break;
    page++;
  }
  console.log(`Loaded ${agents.length} agents`);
  
  // Connect to postgres directly for fast batch update
  const projectId = process.env.SUPABASE_URL?.match(/\/\/([^.]+)/)?.[1];
  const client = new pg.Client({
    connectionString: `postgresql://postgres.${projectId}:${process.env.DB_PASSWORD}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  
  // Batch update scores
  console.log('Writing quality scores...');
  let updated = 0;
  
  for (const agent of agents) {
    const score = computeQualityScore(agent);
    await client.query('UPDATE agents SET quality_score = $1 WHERE id = $2', [score, agent.id]);
    updated++;
    if (updated % 200 === 0) console.log(`  ${updated}/${agents.length}`);
  }
  
  console.log(`✅ Scored ${updated} agents`);
  
  // Cleanup
  if (CLEAN) {
    console.log('\nRunning cleanup...');
    const removals = [];
    
    for (const agent of agents) {
      const text = `${agent.name || ''} ${agent.title || ''} ${agent.description || ''}`.toLowerCase();
      const reasons = [];
      
      if (agent.github_stars === -1) reasons.push('dead_repo');
      if ((agent.name || '').length <= 2 && (agent.karma || 0) < 10) reasons.push('short_name');
      if (agent.platform === 'unknown' && (agent.description || '').length < 50 && (agent.karma || 0) === 0) reasons.push('unknown_empty');
      
      const nonAgentPatterns = [
        { p: /\blibrary\s+(to|for|that)\b/, r: 'library' },
        { p: /\bdataset\b/, r: 'dataset' },
        { p: /\btutorial\b/i, r: 'tutorial' },
        { p: /\bboilerplate\b/i, r: 'boilerplate' },
      ];
      
      for (const { p, r } of nonAgentPatterns) {
        if (p.test(text) && !(agent.karma > 100)) {
          reasons.push(r);
        }
      }
      
      // Duplicate (keep higher karma)
      const dupes = agents.filter(a => a.id !== agent.id && a.name.toLowerCase() === agent.name.toLowerCase());
      if (dupes.length > 0 && (agent.karma || 0) < Math.max(...dupes.map(d => d.karma || 0))) {
        reasons.push('duplicate');
      }
      
      if (reasons.length > 0) removals.push({ id: agent.id, name: agent.name, reasons });
    }
    
    console.log(`Found ${removals.length} to remove`);
    
    for (const r of removals) {
      await client.query('DELETE FROM agents WHERE id = $1', [r.id]);
      console.log(`  ✗ ${r.name} [${r.reasons.join(', ')}]`);
    }
    
    console.log(`✅ Removed ${removals.length} agents`);
  }
  
  // Final count
  const { rows } = await client.query('SELECT count(*) FROM agents');
  console.log(`📊 Total agents: ${rows[0].count}`);
  
  // Score distribution
  const { rows: dist } = await client.query(`
    SELECT 
      count(*) FILTER (WHERE quality_score >= 70) as excellent,
      count(*) FILTER (WHERE quality_score >= 50 AND quality_score < 70) as good,
      count(*) FILTER (WHERE quality_score >= 30 AND quality_score < 50) as mediocre,
      count(*) FILTER (WHERE quality_score >= 15 AND quality_score < 30) as poor,
      count(*) FILTER (WHERE quality_score < 15) as terrible
    FROM agents
  `);
  console.log('Score distribution:', dist[0]);
  
  await client.end();
}

main().catch(console.error);
