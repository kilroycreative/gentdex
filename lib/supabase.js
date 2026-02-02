import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

// Helper to check connection
export async function checkConnection() {
  const { data, error } = await supabase.from('agents').select('count').limit(1);
  if (error && error.code !== 'PGRST116') { // PGRST116 = table doesn't exist yet
    throw error;
  }
  return true;
}
