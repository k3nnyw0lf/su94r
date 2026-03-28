import React, { useState } from 'react';
import { signInWithEmail, signUpWithEmail, signInWithGoogle } from '../lib/supabase';
import toast from 'react-hot-toast';

export default function Auth({ onClose }) {
  const [mode, setMode] = useState('login'); // login | signup
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = mode === 'login'
        ? await signInWithEmail(email, password)
        : await signUpWithEmail(email, password);
      if (error) {
        toast.error(error.message);
      } else {
        toast.success(mode === 'login' ? 'Signed in!' : 'Check your email to confirm!');
        if (mode === 'login' && onClose) onClose();
      }
    } catch (err) {
      toast.error('Something went wrong');
    }
    setLoading(false);
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div className="auth-card" onClick={e => e.stopPropagation()}>
        <button className="auth-close" onClick={onClose}>x</button>
        <div className="auth-logo">su94r</div>
        <p className="auth-subtitle">
          {mode === 'login' ? 'Sign in to sync your data' : 'Create your account'}
        </p>

        <button className="auth-google-btn" onClick={signInWithGoogle} disabled={loading}>
          Continue with Google
        </button>

        <div className="auth-divider"><span>or</span></div>

        <form onSubmit={handleSubmit}>
          <input
            className="auth-input"
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <input
            className="auth-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? '...' : mode === 'login' ? 'Sign In' : 'Sign Up'}
          </button>
        </form>

        <p className="auth-switch">
          {mode === 'login' ? (
            <>No account? <button onClick={() => setMode('signup')}>Sign up</button></>
          ) : (
            <>Have an account? <button onClick={() => setMode('login')}>Sign in</button></>
          )}
        </p>

        <p className="auth-footer-note">By Med Inc — your data stays yours.</p>
      </div>
    </div>
  );
}
