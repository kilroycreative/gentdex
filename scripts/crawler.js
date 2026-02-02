/**
 * GentDex Multi-Source Crawler
 * 
 * Phase 1: Comprehensive agent discovery
 * - Moltbook: all submolts, user profiles, post history
 * - Extensible for GitHub, Twitter, Discord
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MOLTBOOK_API = 'https://moltbook.com/api/v1';
const MOLTBOOK_KEY = process.env.MOLTBOOK_API_KEY;

// Skill detection patterns
const SKILL_PATTERNS = {
  'ml-ai': /\b(machine learning|ml|ai|artificial intelligence|neural|deep learning|llm|gpt|claude|model|training|inference)\b/i,
  'trading': /\b(trading|trader|defi|dex|swap|arbitrage|market making|signals|alpha)\b/i,
  'crypto-web3': /\b(crypto|web3|blockchain|ethereum|solana|bitcoin|smart contract|nft|token|wallet)\b/i,
  'automation': /\b(automat|workflow|pipeline|cron|scheduler|bot|script|task)\b/i,
  'research': /\b(research|analysis|investigate|study|report|data|insights)\b/i,
  'coding': /\b(code|coding|programming|developer|software|engineer|github|api|sdk)\b/i,
  'writing': /\b(writ|content|copy|blog|article|documentation|technical writing)\b/i,
  'memory-systems': /\b(memory|context|recall|persistent|knowledge base|vector|embedding)\b/i,
  'security': /\b(security|audit|vulnerability|penetration|pentest|exploit|secure)\b/i,
  'data': /\b(data|analytics|visualization|dashboard|metrics|sql|database)\b/i,
  'creative': /\b(creative|art|design|image|visual|generate|dall-e|midjourney|stable diffusion)\b/i,
  'education': /\b(teach|tutor|learn|education|explain|mentor|guide)\b/i,
  'productivity': /\b(productiv|organiz|task|todo|calendar|schedule|time management)\b/i,
  'communication': /\b(communicat|email|message|chat|slack|discord|notification)\b/i,
  'finance': /\b(finance|accounting|tax|budget|investment|portfolio|money)\b/i,
  'legal': /\b(legal|law|contract|compliance|regulation|attorney)\b/i,
  'health': /\b(health|medical|fitness|wellness|mental health|therapy)\b/i,
  'gaming': /\b(game|gaming|play|steam|runescape|minecraft|esport)\b/i,
  'social': /\b(social media|twitter|x\.com|instagram|tiktok|influencer|follower)\b/i,
  'ops': /\b(devops|infrastructure|deploy|ci\/cd|docker|kubernetes|aws|cloud)\b/i,
};

// Extract skills from text
function extractSkills(text) {
  const skills = [];
  for (const [skill, pattern] of Object.entries(SKILL_PATTERNS)) {
    if (pattern.test(text)) {
      skills.push(skill);
    }
  }
  return skills;
}

// Detect source platform (where we found them)
function detectPlatform(source) {
  // For now, all agents come from Moltbook
  // When we add GitHub/Twitter crawlers, this will differentiate
  return 'moltbook';
}

// Fetch with rate limiting and redirect following
async function fetchMoltbook(endpoint, options = {}) {
  const url = `${MOLTBOOK_API}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    redirect: 'follow',
    headers: {
      'X-API-Key': MOLTBOOK_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  
  if (!res.ok) {
    throw new Error(`Moltbook API error: ${res.status} ${res.statusText}`);
  }
  
  return res.json();
}

// Crawl all submolts to find agent-related posts
async function crawlSubmolts() {
  console.log('📡 Crawling Moltbook submolts...');
  
  const agentSubmolts = [
    'introductions',
    'agenttips', 
    'memory',
    'todayilearned',
    'automation',
    'thinkingsystems',
    'markets',
    'coding',
  ];
  
  const discoveredAgents = new Map();
  
  for (const submolt of agentSubmolts) {
    console.log(`  Scanning m/${submolt}...`);
    
    try {
      // Fetch posts from submolt
      const data = await fetchMoltbook(`/posts?submolt=${submolt}&limit=100`);
      const posts = data.posts || data || [];
      
      for (const post of posts) {
        const authorName = post.author?.name || post.author_name;
        if (!authorName) continue;
        
        // Skip if we already have detailed info
        if (discoveredAgents.has(authorName) && discoveredAgents.get(authorName).hasDetail) {
          continue;
        }
        
        const existing = discoveredAgents.get(authorName) || {
          name: authorName,
          posts: [],
          karma: post.author?.karma || 0,
          skills: new Set(),
          hasDetail: false,
        };
        
        // Add post content for skill extraction
        const fullText = `${post.title || ''} ${post.content || ''}`;
        existing.posts.push(fullText);
        
        // Extract skills from post
        for (const skill of extractSkills(fullText)) {
          existing.skills.add(skill);
        }
        
        discoveredAgents.set(authorName, existing);
      }
      
      // Rate limit
      await new Promise(r => setTimeout(r, 500));
      
    } catch (e) {
      console.log(`    Error crawling m/${submolt}: ${e.message}`);
    }
  }
  
  console.log(`  Found ${discoveredAgents.size} unique agents from posts`);
  return discoveredAgents;
}

// Get detailed agent info from their profile
async function enrichAgentProfile(agentName) {
  try {
    const data = await fetchMoltbook(`/users/${agentName}`);
    return {
      name: data.name || agentName,
      karma: data.karma || 0,
      bio: data.bio || data.about || '',
      created_at: data.created_at,
      post_count: data.post_count || 0,
      comment_count: data.comment_count || 0,
    };
  } catch (e) {
    return null;
  }
}

// Upsert agent to database
async function upsertAgent(agent) {
  const { name, karma, title, description, skills, platform, moltbook_url } = agent;
  
  // Check if exists
  const { data: existing } = await supabase
    .from('agents')
    .select('id, karma')
    .eq('name', name)
    .single();
  
  if (existing) {
    // Update if karma increased or we have new info
    if (karma > existing.karma || !existing.description) {
      await supabase
        .from('agents')
        .update({
          karma,
          title: title || undefined,
          description: description || undefined,
          platform: platform || undefined,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    }
    return { id: existing.id, updated: true };
  }
  
  // Insert new agent
  const { data: newAgent, error } = await supabase
    .from('agents')
    .insert({
      name,
      karma: karma || 0,
      title: title || `${name} on Moltbook`,
      description: description || '',
      platform: platform || 'unknown',
      moltbook_url: moltbook_url || `https://moltbook.com/u/${name}`,
      languages: ['english'],
    })
    .select()
    .single();
  
  if (error) {
    console.log(`    Error inserting ${name}: ${error.message}`);
    return null;
  }
  
  return { id: newAgent.id, inserted: true };
}

// Upsert skills for an agent
async function upsertAgentSkills(agentId, skills) {
  for (const skillName of skills) {
    // Get or create skill
    let { data: skill } = await supabase
      .from('skills')
      .select('id')
      .eq('name', skillName)
      .single();
    
    if (!skill) {
      const { data: newSkill } = await supabase
        .from('skills')
        .insert({ name: skillName, agent_count: 0 })
        .select()
        .single();
      skill = newSkill;
    }
    
    if (skill) {
      // Upsert agent_skill link
      await supabase
        .from('agent_skills')
        .upsert({ agent_id: agentId, skill_id: skill.id }, { onConflict: 'agent_id,skill_id' });
    }
  }
}

// Update skill counts
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

// Main crawler function
async function runCrawler() {
  console.log('🦞 GentDex Crawler Starting...\n');
  const startTime = Date.now();
  
  let inserted = 0, updated = 0, errors = 0;
  
  // Phase 1: Crawl submolts for agent discovery
  const discoveredAgents = await crawlSubmolts();
  
  // Phase 2: Enrich with profile data and save
  console.log('\n📊 Processing agents...');
  
  for (const [name, agentData] of discoveredAgents) {
    try {
      // Get profile details
      const profile = await enrichAgentProfile(name);
      
      // Combine all text for analysis
      const allText = [
        profile?.bio || '',
        ...agentData.posts,
      ].join(' ');
      
      // Detect platform and extract more skills
      const platform = detectPlatform(allText);
      const skills = new Set([...agentData.skills, ...extractSkills(allText)]);
      
      // Build description from bio or first post
      let description = profile?.bio || '';
      if (!description && agentData.posts.length > 0) {
        description = agentData.posts[0].slice(0, 500);
      }
      
      // Upsert agent
      const result = await upsertAgent({
        name,
        karma: profile?.karma || agentData.karma || 0,
        title: description.split('\n')[0].slice(0, 100) || `${name} on Moltbook`,
        description,
        skills: Array.from(skills),
        platform,
        moltbook_url: `https://moltbook.com/u/${name}`,
      });
      
      if (result) {
        // Add skills
        await upsertAgentSkills(result.id, Array.from(skills));
        
        if (result.inserted) {
          inserted++;
          console.log(`  ✓ NEW: ${name} (${Array.from(skills).join(', ')})`);
        } else if (result.updated) {
          updated++;
        }
      }
      
      // Rate limit
      await new Promise(r => setTimeout(r, 200));
      
    } catch (e) {
      errors++;
      console.log(`  ✗ Error processing ${name}: ${e.message}`);
    }
  }
  
  // Update skill counts
  console.log('\n📈 Updating skill counts...');
  await updateSkillCounts();
  
  // Record refresh
  const elapsed = Date.now() - startTime;
  await supabase.from('index_refreshes').insert({
    source: 'crawler-v2',
    status: 'completed',
    agents_processed: discoveredAgents.size,
    agents_added: inserted,
    agents_updated: updated,
    errors,
    completed_at: new Date().toISOString(),
  });
  
  // Final stats
  const { count: totalAgents } = await supabase
    .from('agents')
    .select('*', { count: 'exact', head: true });
  
  console.log(`
🦞 Crawler Complete!
   Time: ${(elapsed / 1000).toFixed(1)}s
   Processed: ${discoveredAgents.size}
   New agents: ${inserted}
   Updated: ${updated}
   Errors: ${errors}
   Total indexed: ${totalAgents}
`);
}

// Run
runCrawler().catch(console.error);
