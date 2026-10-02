import React, { useState, useEffect, useCallback } from 'react';
import { Toaster, toast } from 'react-hot-toast';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import Trackers from './pages/Trackers';
import Fitness from './pages/Fitness';
import Log from './pages/Log';
import Progress from './pages/Progress';
import Scan from './pages/Scan';
import Devices from './pages/Devices';
import Settings from './pages/Settings';
import Home from './pages/Home';
import Admin from './pages/Admin';
import Auth from './components/Auth';
import { requestNotificationPermission, getNotificationSupport, registerPeriodicSync } from './lib/notifications';
import { useHealthStore } from './store/healthStore';
import { useTranslation } from './lib/i18n.jsx';
import { supabase } from './lib/supabase';
import { isAllowedUser, isAdminUser } from './lib/access';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

// Eight tabs across a 375px phone gave each 47px and clipped five of the eight
// labels. Five primary tabs plus an overflow sheet keeps every label readable,
// which matters more than one-tap access to a screen used monthly.
//
// Primary = what a T1D opens daily. Progress and Settings are weekly at most.
const TABS = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: '📊' },
  { id: 'log', label: 'Log', icon: '💉' },
  { id: 'fitness', label: 'Fitness', icon: '💪' },
  { id: 'scan', label: 'Scan', icon: '📸' },
];

const MORE_TABS = [
  { id: 'progress', label: 'Progress', icon: '📈' },
  { id: 'agents', labelKey: 'nav.agents', icon: '🤖' },
  { id: 'trackers', labelKey: 'nav.trackers', icon: '📈' },
  { id: 'devices', labelKey: 'nav.devices', icon: '🔌' },
  { id: 'settings', labelKey: 'nav.settings', icon: '⚙️' },
];

/** Only rendered for admin accounts. */
const ADMIN_TAB = { id: 'admin', label: 'Admin', icon: '🔑' };


export default function App() {
  const [tab, setTab] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    // su94r.com is a marketing page. Always. Nothing else is served at the
    // root — not for returning visitors, not for signed-in users. The app is
    // reached by an explicit action, never by landing here.
    return params.get('tab') || 'home';
  });
  const [deferredInstall, setDeferredInstall] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [notifStatus, setNotifStatus] = useState(null);
  const [showAuth, setShowAuth] = useState(false);
  const [user, setUser] = useState(null);
  const [deniedEmail, setDeniedEmail] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const { theme, dyslexicFont, settings, initializeApp } = useHealthStore();
  const { t: tr, locale, setLocale, locales } = useTranslation();

  // Auth state listener. Sign-ins outside the allowlist are rejected and
  // signed straight back out — see lib/access.js for why this is UI only.
  useEffect(() => {
    const admit = (session) => {
      const u = session?.user ?? null;
      if (u && !isAllowedUser(u)) {
        setUser(null);
        setDeniedEmail(u.email || 'that account');
        supabase.auth.signOut();
        return;
      }
      setDeniedEmail(null);
      setUser(u);
      if (u) setShowAuth(false);
    };

    supabase.auth.getSession().then(({ data: { session } }) => admit(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => admit(session));
    return () => subscription.unsubscribe();
  }, []);

  // Sync body background with theme
  useEffect(() => {
    document.body.style.background = theme === 'light' ? '#f8fafc' : '#050810';
    document.body.style.color = theme === 'light' ? '#0f172a' : '#e2e8f0';
  }, [theme]);

  // Init app on mount
  useEffect(() => {
    initializeApp();

    const handleInstall = e => {
      e.preventDefault();
      setDeferredInstall(e);
      if (!localStorage.getItem('install_dismissed')) setShowInstallBanner(true);
    };
    window.addEventListener('beforeinstallprompt', handleInstall);

    const support = getNotificationSupport();
    setNotifStatus(support);

    if (support.iosNeedsInstall && !localStorage.getItem('ios_install_dismissed')) {
      setTimeout(() => setShowInstallBanner(true), 2000);
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => {
        registerPeriodicSync().then(ok => {
          if (ok) console.log('[App] Background glucose sync registered');
        });
        navigator.serviceWorker.addEventListener('message', e => {
          if (e.data?.type === 'GLUCOSE_UPDATE') {
            useHealthStore.getState().updateGlucose(e.data.glucose);
          }
        });
      });
    }

    return () => window.removeEventListener('beforeinstallprompt', handleInstall);
  }, [initializeApp]);

  const handleEnableNotifications = useCallback(async () => {
    const result = await requestNotificationPermission();
    if (result.granted) {
      toast.success(result.push ? '🔔 Push notifications enabled!' : '🔔 Notifications enabled (foreground only)');
    } else {
      toast.error('Notifications blocked. Enable in browser settings.');
    }
  }, []);

  const handleInstall = useCallback(async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      const { outcome } = await deferredInstall.userChoice;
      if (outcome === 'accepted') {
        toast.success('App installed!');
        setShowInstallBanner(false);
      }
    }
  }, [deferredInstall]);

  const PAGE_MAP = { home: Home, dashboard: Dashboard, agents: Agents, trackers: Trackers, fitness: Fitness, log: Log, progress: Progress, scan: Scan, devices: Devices, settings: Settings, admin: Admin };
  const ActivePage = PAGE_MAP[tab] || Dashboard;

  // The admin tab is appended rather than baked into TABS so a non-admin never
  // renders it. The database is what actually protects app_secrets — this only
  // keeps the nav honest.
  const moreTabs = isAdminUser(user) ? [...MORE_TABS, ADMIN_TAB] : MORE_TABS;
  const inMore = moreTabs.some(t => t.id === tab);

  const enterApp = useCallback(() => setTab('dashboard'), []);

  // The landing page is a front door, not a screen of the app. App navigation
  // on it would offer to take you places you have not entered yet.
  const showChrome = tab !== 'home';

  return (
    <div className={`app-root ${theme}${dyslexicFont ? ' dyslexic' : ''}`}>
      <Toaster position="top-center" toastOptions={{ style: { background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)' } }} />

      {/* Auth modal */}
      {showAuth && <Auth onClose={() => setShowAuth(false)} />}

      {/* Rejected sign-in */}
      {deniedEmail && (
        <div className="install-banner">
          <span>🔒 <strong>{deniedEmail}</strong> is not on the allowlist. Signed out.</span>
          <button onClick={() => setDeniedEmail(null)}>✕</button>
        </div>
      )}

      {/* iOS Install Banner */}
      {showInstallBanner && notifStatus?.isIOS && !notifStatus?.isPWA && (
        <div className="install-banner">
          <span>📱 <strong>Install for notifications:</strong> Tap Share → Add to Home Screen</span>
          <button onClick={() => { setShowInstallBanner(false); localStorage.setItem('ios_install_dismissed', '1'); }}>✕</button>
        </div>
      )}

      {/* Android Install Banner */}
      {showInstallBanner && deferredInstall && (
        <div className="install-banner">
          <span>📲 Install Open Health Monitor as an app?</span>
          <button className="btn-install" onClick={handleInstall}>Install</button>
          <button onClick={() => { setShowInstallBanner(false); localStorage.setItem('install_dismissed', '1'); }}>✕</button>
        </div>
      )}

      {/* Main content */}
      <main className="main-content">
        <ErrorBoundary>
          <ActivePage
            onRequestNotifications={handleEnableNotifications}
            notifStatus={notifStatus}
            user={user}
            onShowAuth={() => setShowAuth(true)}
            onEnter={enterApp}
          />
        </ErrorBoundary>
      </main>

      {/* Footer credit — the landing page carries its own. */}
      {showChrome && (
        <footer className="app-footer">
          {tr('footer.madeBy')} &nbsp;|&nbsp; <a href="https://su94r.com">{tr('footer.company')}</a>
          <div className="lang-picker">
            {/*
              Language codes, not flag emoji. Windows ships no flag glyphs at
              all, so every one of these rendered as an empty box or a bare
              country code. A flag is a poor label for a language regardless —
              es is not only Spain.
            */}
            {locales.map(l => (
              <button
                key={l.code}
                className={`lang-btn ${locale === l.code ? 'active' : ''}`}
                onClick={() => setLocale(l.code)}
                title={l.label}
                aria-label={l.label}
                lang={l.code}
              >
                {l.code.toUpperCase()}
              </button>
            ))}
          </div>
        </footer>
      )}

      {/* Overflow sheet */}
      {showMore && (
        <div className="more-sheet" onClick={() => setShowMore(false)}>
          <div className="more-panel" onClick={e => e.stopPropagation()}>
            <div className="more-handle" />
            {moreTabs.map(t => {
              const label = t.labelKey ? tr(t.labelKey) : t.label;
              return (
                <button
                  key={t.id}
                  className={`more-item ${tab === t.id ? 'active' : ''}`}
                  onClick={() => { setTab(t.id); setShowMore(false); }}
                >
                  <span className="more-icon">{t.icon}</span>
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Bottom nav */}
      {showChrome && (
      <nav className="bottom-nav">
        {TABS.map(tabItem => {
          const label = tabItem.labelKey ? tr(tabItem.labelKey) : tabItem.label;
          return (
            <button
              key={tabItem.id}
              className={`nav-item ${tab === tabItem.id ? 'active' : ''}`}
              onClick={() => setTab(tabItem.id)}
              aria-label={label}
            >
              <span className="nav-icon">{tabItem.icon}</span>
              <span className="nav-label">{label}</span>
            </button>
          );
        })}
        <button
          className={`nav-item ${inMore || showMore ? 'active' : ''}`}
          onClick={() => setShowMore(v => !v)}
          aria-expanded={showMore}
          aria-label="More"
        >
          <span className="nav-icon">⋯</span>
          <span className="nav-label">More</span>
        </button>
      </nav>
      )}
    </div>
  );
}
