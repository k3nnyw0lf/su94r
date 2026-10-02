import { createClient } from '@supabase/supabase-js';

// Running your own copy? Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
// The anon key is public by design; row-level security is what protects data.
const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || 'https://sfelhasepvaoianyuvxe.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmZWxoYXNlcHZhb2lhbnl1dnhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2ODY0NDcsImV4cCI6MjA4NjI2MjQ0N30.kNzRAcdXaHoo0xQnJwNXyqcFsSiUZj9PP1fwziEQkdc';

// PKCE: a Google or Apple sign-in comes back as a one-time ?code= that is exchanged for the
// session, instead of the old implicit flow's #access_token=…&refresh_token=… in the address
// bar, where the tokens stayed in browser history.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
});

// Once the sign-in has been read, nothing of it stays in the address bar (also cleans tabs
// left over from the implicit flow).
if (typeof window !== 'undefined') {
  const leftover = (u) => /(access_token|refresh_token|provider_token)=/.test(u.hash) || u.searchParams.has('code');
  if (leftover(new URL(window.location.href))) {
    supabase.auth.getSession().finally(() => {
      const u = new URL(window.location.href);
      if (/(access_token|refresh_token|provider_token)=/.test(u.hash)) u.hash = '';
      u.searchParams.delete('code');
      window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
    });
  }
}

// Auth helpers
export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
}

/**
 * Sign in with Apple.
 *
 * Requires the Apple provider to be configured in the Supabase dashboard,
 * which in turn requires a paid Apple Developer account (Services ID + key).
 * Until that is done this call returns an error from Supabase — it is not a
 * bug in this file.
 */
export async function signInWithApple() {
  return supabase.auth.signInWithOAuth({
    provider: 'apple',
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
