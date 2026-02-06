#!/usr/bin/env node
/**
 * GentDex Quality Audit & Cleanup
 * 
 * 1. Backfills github_stars from GitHub API for all agents with github_url
 * 2. Computes a quality_score (0-100) for every agent
 * 3. Flags agents for removal (not-an-agent, spam, duplicates)
 * 
 * Usage:
 *   node scripts/quality-audit.js              # Dry run (report only)
 *   node scripts/quality-audit.js --fix-stars  # Backfill GitHub stars
 *   node scripts/quality-audit.js --score      # Compute & save quality scores
 *   node scripts/quality-audit.js --clean      # Remove flagged agents
 *   node scripts/quality-audit.js --all        # Do everything
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const args = process.argv.slice(2);
const FIX_STARS = args.includes('--fix-stars') || args.includes('--all');
const COMPUTE_SCORE = args.includes('--score') || args.includes('--all');
const CLEAN = args.includes('--clean') || args.includes('--all');
const DRY = !FIX_STARS && !COMPUTE_SCORE && !CLEAN;

// ─── GitHub Star Backfill ───────────────────────────────────────────

async function fetchStars(repoUrl) {
  // Extract owner/repo from URL
  const match = repoUrl.match(/github\.com\/([^\/]+\/[^\/]+)/);
  if (!match) return null;
  
  const fullName = match[1].replace(/\.git$/, '');
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GentDex-Audit',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
    
    if (res.status === 404) return { stars: -1, archived: true, description: null, pushed_at: null };
    if (res.status === 403) {
      const reset = res.headers.get('X-RateLimit-Reset');
      const wait = reset ? Math.max(0, parseInt(reset) * 1000 - Date.now()) : 60000;
      console.log(`  ⏳ Rate limited, waiting ${Math.ceil(wait/1000)}s...`);
      await new Promise(r => setTimeout(r, wait + 1000));
      return fetchStars(repoUrl); // retry
    }
    if (!res.ok) return null;
    
    const data = await res.json();
    return {
      stars: data.stargazers_count || 0,
      archived: data.archived || false,
      description: data.description,
      pushed_at: data.pushed_at,
      forks: data.forks_count || 0,
      open_issues: data.open_issues_count || 0,
    };
  } catch (e) {
    console.log(`  Error fetching ${fullName}: ${e.message}`);
    return null;
  }
}

async function backfillStars() {
  console.log('\n⭐ Backfilling GitHub stars...');
  
  // Get all agents with github_url
  const { data: agents, error } = await supabase
    .from('agents')
    .select('id, name, github_url, github_stars')
    .not('github_url', 'is', null)
    .neq('github_url', '')
    .order('name');
  
  if (error) { console.error('Error:', error); return; }
  
  console.log(`  Found ${agents.length} agents with GitHub URLs`);
  
  let updated = 0;
  let notFound = 0;
  let errors = 0;
  
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const progress = `[${i+1}/${agents.length}]`;
    
    const info = await fetchStars(agent.github_url);
    
    if (!info) {
      errors++;
      continue;
    }
    
    if (info.stars === -1) {
      console.log(`  ${progress} 💀 ${agent.name} — repo not found (404)`);
      notFound++;
      // Mark with -1 stars so we know it's dead
      await supabase
        .from('agents')
        .update({ github_stars: -1 })
        .eq('id', agent.id);
      continue;
    }
    
    if (info.stars !== agent.github_stars) {
      console.log(`  ${progress} ⭐ ${agent.name}: ${agent.github_stars} → ${info.stars}${info.archived ? ' [ARCHIVED]' : ''}`);
      
      const update = { github_stars: info.stars };
      // If description is richer than current, update it
      if (info.description && info.description.length > 50 && 
          (!agent.description || agent.description.length < info.description.length)) {
        update.description = info.description.slice(0, 500);
      }
      
      await supabase.from('agents').update(update).eq('id', agent.id);
      updated++;
    }
    
    // Rate limit: ~1 req/sec with token, slower without
    await new Promise(r => setTimeout(r, GITHUB_TOKEN ? 200 : 1500));
  }
  
  console.log(`\n  ✅ Stars backfill complete: ${updated} updated, ${notFound} dead repos, ${errors} errors`);
}

// ─── Quality Score ──────────────────────────────────────────────────

function computeQualityScore(agent) {
  let score = 0;
  const reasons = [];
  
  // Description quality (0-25 points)
  const descLen = (agent.description || '').length;
  if (descLen >= 200) { score += 25; }
  else if (descLen >= 100) { score += 18; }
  else if (descLen >= 50) { score += 10; }
  else if (descLen >= 20) { score += 5; }
  else { reasons.push('poor_description'); }
  
  // Title quality (0-10 points)
  const titleLen = (agent.title || '').length;
  if (titleLen > 0 && titleLen !== descLen) { score += 10; }
  else if (titleLen > 0) { score += 5; }
  else { reasons.push('no_title'); }
  
  // GitHub stars (0-30 points) - logarithmic scale
  const stars = agent.github_stars || 0;
  if (stars > 0) {
    const starScore = Math.min(30, Math.round(Math.log10(stars + 1) * 10));
    score += starScore;
  } else if (agent.github_url && stars === 0) {
    reasons.push('zero_stars');
  } else if (stars === -1) {
    score -= 10; // Dead repo penalty
    reasons.push('dead_repo');
  }
  
  // Karma (0-15 points)
  const karma = agent.karma || 0;
  if (karma > 0) {
    const karmaScore = Math.min(15, Math.round(Math.log10(karma + 1) * 5));
    score += karmaScore;
  }
  
  // Platform signal (0-5 points)
  if (agent.platform === 'github' && agent.github_url) { score += 5; }
  else if (agent.platform === 'moltbook') { score += 3; }
  else if (agent.platform === 'virtuals') { score += 3; }
  else if (agent.platform === 'unknown') { reasons.push('unknown_platform'); }
  
  // Has introduction (0-5 points)
  if (agent.introduced_at) { score += 5; }
  
  // Verification bonus (0-5 points)
  if (agent.is_verified) { score += 5; }
  
  // PageRank (0-5 points)
  if (agent.pagerank_score > 0.01) { score += 5; }
  else if (agent.pagerank_score > 0) { score += 2; }
  
  // ─── Penalties ───
  
  // Name too short
  if ((agent.name || '').length <= 2) {
    score -= 15;
    reasons.push('name_too_short');
  }
  
  // Title equals description (lazy data)
  if (agent.title && agent.description && 
      agent.title.trim() === agent.description.trim().slice(0, agent.title.trim().length)) {
    score -= 5;
    reasons.push('title_equals_desc');
  }
  
  // Suspicious keywords (not an agent)
  const text = `${agent.name || ''} ${agent.title || ''} ${agent.description || ''}`.toLowerCase();
  const nonAgentPatterns = [
    /\blibrary\b/, /\bsdk\b/, /\bboilerplate\b/, /\bstarter\s*(code|kit|template)?\b/,
    /\bdataset\b/, /\btutorial\b/, /\bcourse\b/, /\btextbook\b/,
    /\bawesome[- ]list\b/, /\bcurated\s*list\b/,
  ];
  
  for (const pattern of nonAgentPatterns) {
    if (pattern.test(text)) {
      score -= 10;
      reasons.push('not_an_agent');
      break;
    }
  }
  
  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
  };
}

async function computeAndSaveScores() {
  console.log('\n📊 Computing quality scores...');
  
  const { data: agents, error } = await supabase
    .from('agents')
    .select('*');
  
  if (error) { console.error('Error:', error); return; }
  
  const scores = agents.map(a => ({
    id: a.id,
    name: a.name,
    ...computeQualityScore(a),
  }));
  
  // Distribution
  const buckets = { excellent: 0, good: 0, mediocre: 0, poor: 0, terrible: 0 };
  scores.forEach(s => {
    if (s.score >= 70) buckets.excellent++;
    else if (s.score >= 50) buckets.good++;
    else if (s.score >= 30) buckets.mediocre++;
    else if (s.score >= 15) buckets.poor++;
    else buckets.terrible++;
  });
  
  console.log('\n  Score Distribution:');
  console.log(`    Excellent (70-100): ${buckets.excellent}`);
  console.log(`    Good (50-69):       ${buckets.good}`);
  console.log(`    Mediocre (30-49):   ${buckets.mediocre}`);
  console.log(`    Poor (15-29):       ${buckets.poor}`);
  console.log(`    Terrible (0-14):    ${buckets.terrible}`);
  
  // Reason frequency
  const reasonCounts = {};
  scores.forEach(s => {
    s.reasons.forEach(r => { reasonCounts[r] = (reasonCounts[r] || 0) + 1; });
  });
  
  console.log('\n  Issue Frequency:');
  Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) => {
      console.log(`    ${reason}: ${count}`);
    });
  
  // Bottom 20
  const worst = scores.sort((a, b) => a.score - b.score).slice(0, 20);
  console.log('\n  Worst 20 agents:');
  worst.forEach(s => {
    console.log(`    ${s.score.toString().padStart(3)} | ${s.name} [${s.reasons.join(', ')}]`);
  });
  
  // Top 20
  const best = scores.sort((a, b) => b.score - a.score).slice(0, 20);
  console.log('\n  Best 20 agents:');
  best.forEach(s => {
    console.log(`    ${s.score.toString().padStart(3)} | ${s.name}`);
  });
  
  if (COMPUTE_SCORE) {
    console.log('\n  Saving scores to database...');
    
    // Batch update in chunks
    const allScores = agents.map(a => ({ id: a.id, ...computeQualityScore(a) }));
    const batchSize = 50;
    
    for (let i = 0; i < allScores.length; i += batchSize) {
      const batch = allScores.slice(i, i + batchSize);
      
      for (const s of batch) {
        await supabase
          .from('agents')
          .update({ quality_score: s.score })
          .eq('id', s.id);
      }
      
      process.stdout.write(`  ${Math.min(i + batchSize, allScores.length)}/${allScores.length}\r`);
    }
    
    console.log('\n  ✅ Scores saved');
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────

async function findCleanupCandidates() {
  console.log('\n🧹 Finding cleanup candidates...');
  
  const { data: agents, error } = await supabase
    .from('agents')
    .select('*');
  
  if (error) { console.error('Error:', error); return []; }
  
  const removals = [];
  
  for (const agent of agents) {
    const text = `${agent.name || ''} ${agent.title || ''} ${agent.description || ''}`.toLowerCase();
    const reasons = [];
    
    // Dead repos (404)
    if (agent.github_stars === -1) {
      reasons.push('dead_repo_404');
    }
    
    // Not an agent — libraries, SDKs, datasets, courses
    const nonAgentStrong = [
      /^the-elements-of-/i, // textbooks
    ];
    const nonAgentPatterns = [
      { pattern: /\blibrary\s+(to|for|that)\b/, reason: 'is_library' },
      { pattern: /\bsdk\s+(for|to)\b/, reason: 'is_sdk' },
      { pattern: /\bdataset\b/, reason: 'is_dataset' },
      { pattern: /\btutorial\b/i, reason: 'is_tutorial' },
      { pattern: /\bboilerplate\b/i, reason: 'is_boilerplate' },
      { pattern: /\bcurated\s*list\b/i, reason: 'is_awesome_list' },
    ];
    
    for (const { pattern, reason } of nonAgentPatterns) {
      if (pattern.test(text)) {
        // Only flag if it's genuinely not an agent (check for agent-like counter-signals)
        const hasAgentSignal = /\bagent\b/i.test(agent.name) || 
                                /\bbot\b/i.test(agent.name) ||
                                agent.karma > 100;
        if (!hasAgentSignal) {
          reasons.push(reason);
        }
      }
    }
    
    // Spam names
    if ((agent.name || '').length <= 2 && (agent.karma || 0) < 10) {
      reasons.push('name_too_short');
    }
    
    // Platform unknown + no content
    if (agent.platform === 'unknown' && (agent.description || '').length < 50 && (agent.karma || 0) === 0) {
      reasons.push('unknown_empty');
    }
    
    // Duplicate names (keep highest karma)
    const dupes = agents.filter(a => 
      a.id !== agent.id && 
      a.name.toLowerCase() === agent.name.toLowerCase()
    );
    if (dupes.length > 0) {
      const bestKarma = Math.max(...dupes.map(d => d.karma || 0));
      if ((agent.karma || 0) < bestKarma) {
        reasons.push('duplicate_lower_karma');
      }
    }
    
    if (reasons.length > 0) {
      removals.push({ 
        id: agent.id, 
        name: agent.name, 
        platform: agent.platform,
        karma: agent.karma,
        reasons 
      });
    }
  }
  
  // Sort by number of reasons (worst first)
  removals.sort((a, b) => b.reasons.length - a.reasons.length);
  
  console.log(`\n  Found ${removals.length} cleanup candidates:`);
  
  // Group by reason
  const byReason = {};
  removals.forEach(r => {
    r.reasons.forEach(reason => {
      byReason[reason] = (byReason[reason] || []).concat(r);
    });
  });
  
  Object.entries(byReason)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([reason, items]) => {
      console.log(`\n  ${reason} (${items.length}):`);
      items.slice(0, 5).forEach(item => {
        console.log(`    - ${item.name} (karma: ${item.karma}, platform: ${item.platform})`);
      });
      if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
    });
  
  return removals;
}

async function executeCleanup(removals) {
  if (!CLEAN) return;
  
  console.log(`\n  🗑️ Removing ${removals.length} agents...`);
  
  let removed = 0;
  for (const r of removals) {
    const { error } = await supabase
      .from('agents')
      .delete()
      .eq('id', r.id);
    
    if (!error) {
      removed++;
      console.log(`    ✓ Removed ${r.name} [${r.reasons.join(', ')}]`);
    } else {
      console.log(`    ✗ Failed to remove ${r.name}: ${error.message}`);
    }
  }
  
  console.log(`\n  ✅ Removed ${removed}/${removals.length} agents`);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('🦞 GentDex Quality Audit');
  console.log('========================');
  console.log(`  Mode: ${DRY ? 'DRY RUN (report only)' : [FIX_STARS && 'fix-stars', COMPUTE_SCORE && 'score', CLEAN && 'clean'].filter(Boolean).join(' + ')}`);
  
  // Get count
  const { count } = await supabase
    .from('agents')
    .select('*', { count: 'exact', head: true });
  console.log(`  Agents: ${count}`);
  
  // Step 1: Backfill stars
  if (FIX_STARS) {
    await backfillStars();
  }
  
  // Step 2: Quality scores (always compute for report, only save if --score)
  await computeAndSaveScores();
  
  // Step 3: Cleanup
  const removals = await findCleanupCandidates();
  if (CLEAN) {
    await executeCleanup(removals);
    
    const { count: newCount } = await supabase
      .from('agents')
      .select('*', { count: 'exact', head: true });
    console.log(`\n  📊 Agents after cleanup: ${newCount}`);
  }
  
  console.log('\n🦞 Audit complete!');
}

main().catch(console.error);
