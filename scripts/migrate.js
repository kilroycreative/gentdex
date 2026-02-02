import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Get password from environment or prompt
const dbPassword = process.env.DB_PASSWORD || process.argv[2];

if (!dbPassword) {
  console.error('Usage: node scripts/migrate.js <database_password>');
  console.error('Or set DB_PASSWORD environment variable');
  process.exit(1);
}

// Parse project ID from Supabase URL
const projectId = process.env.SUPABASE_URL?.match(/\/\/([^.]+)/)?.[1];
if (!projectId) {
  console.error('SUPABASE_URL not set or invalid');
  process.exit(1);
}

// Use Session Pooler for IPv4 compatibility
const connectionString = `postgresql://postgres.${projectId}:${dbPassword}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`;

console.log('Connecting to database via Session Pooler...');
console.log(`Host: aws-1-us-east-2.pooler.supabase.com`);

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

// Split SQL into statements, handling $$ function blocks
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  
  const lines = sql.split('\n');
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Skip pure comment lines
    if (trimmedLine.startsWith('--') && !inDollarQuote) {
      continue;
    }
    
    current += line + '\n';
    
    // Check for entering/exiting $$ blocks
    const dollarMatches = (line.match(/\$\$/g) || []).length;
    if (dollarMatches % 2 === 1) {
      inDollarQuote = !inDollarQuote;
    }
    
    // If we hit a semicolon at the end of line and not in a $$ block
    if (trimmedLine.endsWith(';') && !inDollarQuote) {
      const stmt = current.trim();
      if (stmt && !stmt.startsWith('--')) {
        statements.push(stmt);
      }
      current = '';
    }
  }
  
  // Handle any remaining content
  if (current.trim() && !current.trim().startsWith('--')) {
    statements.push(current.trim());
  }
  
  return statements;
}

async function runMigration() {
  try {
    await client.connect();
    console.log('Connected successfully!');

    // Read schema file
    const schemaPath = path.join(__dirname, '../supabase/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    console.log('Running schema migration...');
    
    const statements = splitStatements(schema);
    let success = 0;
    let errors = 0;

    for (const statement of statements) {
      try {
        await client.query(statement);
        success++;
        // Show first 60 chars of statement
        const preview = statement.replace(/\s+/g, ' ').slice(0, 60);
        console.log(`✓ ${preview}...`);
      } catch (err) {
        errors++;
        const preview = statement.replace(/\s+/g, ' ').slice(0, 60);
        console.error(`✗ ${preview}...`);
        console.error(`  Error: ${err.message}`);
      }
    }

    console.log(`\nMigration complete: ${success} succeeded, ${errors} failed`);

    // Verify tables exist
    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    `);
    
    console.log('\nTables created:');
    tables.rows.forEach(row => console.log(`  - ${row.table_name}`));

    // Verify functions exist
    const functions = await client.query(`
      SELECT routine_name 
      FROM information_schema.routines 
      WHERE routine_schema = 'public'
      AND routine_type = 'FUNCTION'
    `);
    
    console.log('\nFunctions created:');
    functions.rows.forEach(row => console.log(`  - ${row.routine_name}`));

  } catch (err) {
    console.error('Connection failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
