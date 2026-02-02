import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPassword = process.env.DB_PASSWORD;
const projectId = process.env.SUPABASE_URL?.match(/\/\/([^.]+)/)?.[1];

const connectionString = `postgresql://postgres.${projectId}:${dbPassword}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`;

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--') && !inDollarQuote) continue;
    
    current += line + '\n';
    
    const matches = (line.match(/\$\$/g) || []).length;
    if (matches % 2 === 1) inDollarQuote = !inDollarQuote;
    
    if (trimmed.endsWith(';') && !inDollarQuote) {
      if (current.trim() && !current.trim().startsWith('--')) {
        statements.push(current.trim());
      }
      current = '';
    }
  }
  
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function run() {
  await client.connect();
  console.log('Connected to database');

  // Run fix-search-function first
  const fixPath = path.join(__dirname, '../supabase/fix-search-function.sql');
  const fixSql = fs.readFileSync(fixPath, 'utf-8');
  
  console.log('\nFixing search function...');
  for (const stmt of splitStatements(fixSql)) {
    try {
      await client.query(stmt);
      console.log('✓ Fixed search_agents function');
    } catch (e) {
      console.log('✗', e.message);
    }
  }

  // Run crypto-payments
  const cryptoPath = path.join(__dirname, '../supabase/crypto-payments.sql');
  const cryptoSql = fs.readFileSync(cryptoPath, 'utf-8');
  
  console.log('\nCreating crypto payment tables...');
  let ok = 0, fail = 0;
  
  for (const stmt of splitStatements(cryptoSql)) {
    try {
      await client.query(stmt);
      ok++;
      console.log('✓', stmt.replace(/\s+/g, ' ').slice(0, 50) + '...');
    } catch (e) {
      fail++;
      console.log('✗', stmt.replace(/\s+/g, ' ').slice(0, 50) + '...');
      console.log('  ', e.message);
    }
  }

  console.log(`\nDone: ${ok} ok, ${fail} failed`);

  // Show tables
  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  console.log('\nAll tables:', rows.map(r => r.table_name).join(', '));

  await client.end();
}

run();
