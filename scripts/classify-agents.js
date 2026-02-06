#!/usr/bin/env node
/**
 * Classify GentDex agents into: agent, framework, tool, knowledge, interface
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const projectId = process.env.SUPABASE_URL?.match(/\/\/([^.]+)/)?.[1];

function classify(agent) {
  const name = (agent.name || '').toLowerCase();
  const desc = (agent.description || '').toLowerCase();
  const title = (agent.title || '').toLowerCase();
  const text = `${name} ${desc} ${title}`;

  const scores = { agent: 0, framework: 0, tool: 0, knowledge: 0, interface: 0 };

  // ── KNOWLEDGE (datasets, lists, tutorials, papers) ──
  if (/^awesome[- ]/.test(name)) scores.knowledge += 20;
  if (/curated.{0,10}list/i.test(text)) scores.knowledge += 10;
  if (/\bdataset\b/.test(text)) scores.knowledge += 8;
  if (/\btutorial\b/.test(text)) scores.knowledge += 8;
  if (/\bcourse\b/.test(text)) scores.knowledge += 6;
  if (/\btextbook\b|\bbook\b/.test(text)) scores.knowledge += 5;
  if (/\bsurvey\b|\breview of\b/.test(text)) scores.knowledge += 5;
  if (/\bresearch\b.*\bpaper\b/.test(text)) scores.knowledge += 6;
  if (/reinforcement learning\b/.test(text) && !/\bbot\b|\bagent\b/.test(name)) scores.knowledge += 5;
  if (/\blist of\b|\bcollection of\b/.test(text)) scores.knowledge += 4;
  if (/\bexamples?\b/.test(name)) scores.knowledge += 4;
  if (/\bcheatsheet\b|\bcookbook\b/.test(text)) scores.knowledge += 5;
  if (/\bwhitepaper\b/.test(text)) scores.knowledge += 5;

  // ── FRAMEWORK (platforms for building agents) ──
  if (/\bframework\b/.test(text)) scores.framework += 6;
  if (/\bplatform\b/.test(text) && /\bbuild\b|\bcreate\b|\bdevelop\b/.test(text)) scores.framework += 6;
  if (/\borchestrat/.test(text)) scores.framework += 5;
  if (/\bmulti[- ]?agent\b/.test(text)) scores.framework += 4;
  if (/\bagent.{0,10}(framework|platform|runtime|engine)\b/.test(text)) scores.framework += 8;
  if (/\b(build|create|deploy).{0,15}(agents?|bots?)\b/.test(text)) scores.framework += 5;
  if (/\bworkflow.{0,10}(engine|automat|builder)\b/.test(text)) scores.framework += 5;
  if (/\bswarm\b/.test(text) && /\bagent/.test(text)) scores.framework += 4;
  // Known frameworks by name
  const knownFrameworks = ['langchain', 'langgraph', 'crewai', 'autogen', 'n8n', 'dify',
    'flowise', 'haystack', 'semantic-kernel', 'camel', 'metagpt', 'taskweaver',
    'agentverse', 'superagi', 'e2b', 'composio', 'phidata', 'julep',
    'letta', 'memgpt', 'botpress', 'rasa', 'voiceflow'];
  if (knownFrameworks.some(f => name === f || name.startsWith(f + '-'))) scores.framework += 10;

  // ── TOOL (SDKs, libraries, CLIs, dev tools) ──
  if (/\bsdk\b/.test(text)) scores.tool += 6;
  if (/\bcli\b/.test(text) && !/\bclick\b/.test(text)) scores.tool += 4;
  if (/\blibrary\b/.test(text)) scores.tool += 5;
  if (/\bapi\b/.test(text) && /\b(client|wrapper|integration)\b/.test(text)) scores.tool += 5;
  if (/\bmonitoring\b|\bobservability\b|\btracing\b/.test(text)) scores.tool += 6;
  if (/\bbenchmark\b/.test(text) && !/dataset/.test(text)) scores.tool += 4;
  if (/\beval(uation)?\b/.test(text) && /\b(tool|framework|suite)\b/.test(text)) scores.tool += 5;
  if (/\bprompt.{0,10}(engineering|management|template)\b/.test(text)) scores.tool += 5;
  if (/\bvector\b.*\b(store|database|db)\b/.test(text)) scores.tool += 5;
  if (/\bembedding\b/.test(text) && /\b(model|generate|search)\b/.test(text)) scores.tool += 4;
  if (/\bcode.{0,5}(review|gen|complet)\b/.test(text)) scores.tool += 3;
  if (/\bplayground\b|\bsandbox\b/.test(text)) scores.tool += 3;
  // Known tools by name
  const knownTools = ['agentops', 'helicone', 'langfuse', 'langsmith', 'promptflow',
    'instructor', 'guardrails', 'nemoguardrails', 'litellm', 'chromadb', 'qdrant',
    'weaviate', 'pinecone', 'llamaindex'];
  if (knownTools.some(t => name === t || name.startsWith(t + '-'))) scores.tool += 10;

  // ── INTERFACE (UIs, chat clients, wrappers) ──
  if (/\bchat\s*(ui|interface|frontend|client|app)\b/.test(text)) scores.interface += 8;
  if (/\bweb\s*(ui|interface|app|frontend)\b/.test(text)) scores.interface += 6;
  if (/\bdashboard\b/.test(text) && !/\banalytics\b/.test(text)) scores.interface += 4;
  if (/\bchatgpt.{0,5}(wrapper|clone|alternative)\b/.test(text)) scores.interface += 8;
  if (/\bopen.?webui\b|\blobe.?chat\b|\bbig-agi\b/.test(name)) scores.interface += 10;
  if (/\bdesktop\s*app\b|\bmobile\s*app\b/.test(text)) scores.interface += 4;
  if (/\bbrowser\s*extension\b|\bchrome\s*extension\b/.test(text)) scores.interface += 5;
  // Known interfaces
  const knownInterfaces = ['chatbox', 'jan', 'lmstudio', 'text-generation-webui',
    'oobabooga', 'koboldai', 'silly-tavern', 'typingmind', 'chatgpt-web',
    'open-webui', 'librechat', 'big-agi', 'chatgpt-next-web'];
  if (knownInterfaces.some(i => name === i || name.startsWith(i))) scores.interface += 10;

  // ── AGENT (autonomous bots, assistants, trading bots) ──
  if (/\bbot\b/.test(name)) scores.agent += 5;
  if (/\bagent\b/.test(name) && !/framework|platform|ops/.test(text)) scores.agent += 3;
  if (/\b(trading|trade)\s*(bot|agent|system)\b/.test(text)) scores.agent += 8;
  if (/\b(mev|arbitrage|sniper|sandwich)\b/.test(text)) scores.agent += 7;
  if (/\b(defi|crypto)\s*(bot|agent|trader)\b/.test(text)) scores.agent += 7;
  if (/\bcopy\s*trad/.test(text)) scores.agent += 6;
  if (/\byield\s*farm/.test(text)) scores.agent += 5;
  if (/\bautonomous\b/.test(text) && !/framework/.test(text)) scores.agent += 5;
  if (/\bpersonal\s*assistant\b|\bvirtual\s*assistant\b/.test(text)) scores.agent += 5;
  if (/\bcoding\s*(assistant|agent|copilot)\b/.test(text)) scores.agent += 5;
  if (/\bsearch\s*(agent|assistant)\b/.test(text)) scores.agent += 4;
  if (/\bautomation\b/.test(text) && /\btask\b|\bworkflow\b/.test(text)) scores.agent += 3;
  // Moltbook agents are almost always agents
  if (agent.platform === 'moltbook') scores.agent += 4;
  if (agent.platform === 'virtuals') scores.agent += 4;
  // If has karma > 0 on moltbook, strong agent signal
  if (agent.platform === 'moltbook' && (agent.karma || 0) > 0) scores.agent += 3;

  // Pick highest
  let best = 'agent';
  let max = -1;
  for (const [cat, score] of Object.entries(scores)) {
    if (score > max) { max = score; best = cat; }
  }

  // Default: if nothing matched and it's from github with no strong signal, default to agent
  if (max === 0) best = 'agent';

  return best;
}

async function main() {
  console.log('🏷️  Classifying GentDex agents...\n');

  // Fetch all agents
  let agents = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase.from('agents').select('*').range(page * 1000, (page + 1) * 1000 - 1);
    if (error) { console.error(error); process.exit(1); }
    if (!data || data.length === 0) break;
    agents = agents.concat(data);
    if (data.length < 1000) break;
    page++;
  }
  console.log(`Loaded ${agents.length} agents`);

  // Classify
  const results = agents.map(a => ({ id: a.id, name: a.name, category: classify(a) }));

  // Distribution
  const dist = {};
  results.forEach(r => { dist[r.category] = (dist[r.category] || 0) + 1; });
  console.log('\nDistribution:');
  Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([cat, n]) => {
    console.log(`  ${cat}: ${n} (${(n / agents.length * 100).toFixed(1)}%)`);
  });

  // Examples per category
  for (const cat of ['agent', 'framework', 'tool', 'knowledge', 'interface']) {
    const examples = results.filter(r => r.category === cat).slice(0, 8);
    console.log(`\n${cat.toUpperCase()} examples: ${examples.map(e => e.name).join(', ')}`);
  }

  // Write to DB
  console.log('\nWriting to database...');
  const client = new pg.Client({
    connectionString: `postgresql://postgres.${projectId}:${process.env.DB_PASSWORD}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  let updated = 0;
  for (const r of results) {
    await client.query('UPDATE agents SET category = $1 WHERE id = $2', [r.category, r.id]);
    updated++;
    if (updated % 200 === 0) console.log(`  ${updated}/${results.length}`);
  }

  console.log(`\n✅ Classified ${updated} agents`);

  // Final counts from DB
  const { rows } = await client.query(
    "SELECT category, count(*) as cnt FROM agents GROUP BY category ORDER BY cnt DESC"
  );
  console.log('\nFinal DB distribution:');
  rows.forEach(r => console.log(`  ${r.category}: ${r.cnt}`));

  await client.end();
}

main().catch(console.error);
