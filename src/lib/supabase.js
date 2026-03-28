import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://sfelhasepvaoianyuvxe.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmZWxoYXNlcHZhb2lhbnl1dnhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2ODY0NDcsImV4cCI6MjA4NjI2MjQ0N30.kNzRAcdXaHoo0xQnJwNXyqcFsSiUZj9PP1fwziEQkdc';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Auth helpers
export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
}

export async function signInWithEmail(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signUpWithEmail(email, password) {
  return supabase.auth.signUp({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

// Profile helpers
export async function upsertProfile(profile) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('user_profiles')
    .upsert({ id: user.id, ...profile, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) console.error('Profile upsert error:', error);
  return data;
}

export async function getProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  return data;
}

// Lab results helpers
export async function getLabResults() {
  const { data } = await supabase
    .from('lab_results')
    .select('*')
    .order('test_date', { ascending: false })
    .limit(100);
  return data || [];
}

export async function addLabResult(result) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('lab_results')
    .insert({ ...result, user_id: user.id })
    .select()
    .single();
  if (error) console.error('Lab insert error:', error);
  return data;
}

export async function deleteLabResult(id) {
  return supabase.from('lab_results').delete().eq('id', id);
}
