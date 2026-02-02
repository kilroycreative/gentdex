import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPassword = process.env.DB_PASSWORD;
const projectId = process.env.SUPABASE_URL?.match(/\/\/([^.]+)/)?.[1];

if (!dbPassword || !projectId) {
  console.error('Missing DB_PASSWORD or SUPABASE_URL');
  process.exit(1);
}

const connectionString = `postgresql://postgres.${projectId}:${dbPassword}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`;

console.log('Connecting to database...');

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  
  const lines = sql.split('\n');
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('--') && !inDollarQuote) continue;
    
    current += line + '\n';
    
    const dollarMatches = (line.match(/\$\$/g) || []).length;
    if (dollarMatches % 2 === 1) inDollarQuote = !inDollarQuote;
    
    if (trimmedLine.endsWith(';') && !inDollarQuote) {
      const stmt = current.trim();
      if (stmt && !stmt.startsWith('--')) statements.push(stmt);
      current = '';
    }
  }
  
  if (current.trim() && !current.trim().startsWith('--')) {
    statements.push(current.trim());
  }
  
  return statements;
}

async function runMigration() {
  try {
    await client.connect();
    console.log('Connected!');

    const schemaPath = path.join(__dirname, '../supabase/monetization.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    console.log('Running monetization migration...');
    
    const statements = splitStatements(schema);
    let success = 0, errors = 0;

    for (const statement of statements) {
      try {
        await client.query(statement);
        success++;
        const preview = statement.replace(/\s+/g, ' ').slice(0, 50);
        console.log(`✓ ${preview}...`);
      } catch (err) {
        errors++;
        const preview = statement.replace(/\s+/g, ' ').slice(0, 50);
        console.error(`✗ ${preview}...`);
        console.error(`  ${err.message}`);
      }
    }

    console.log(`\nMigration complete: ${success} succeeded, ${errors} failed`);

    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    
    console.log('\nAll tables:');
    tables.rows.forEach(row => console.log(`  - ${row.table_name}`));

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
