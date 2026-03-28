import React, { useState, useEffect, useCallback } from 'react';
import { Toaster, toast } from 'react-hot-toast';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import Trackers from './pages/Trackers';
import Devices from './pages/Devices';
import Settings from './pages/Settings';
import { requestNotificationPermission, getNotificationSupport, registerPeriodicSync } from './lib/notifications';
import { useHealthStore } from './store/healthStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'agents', label: 'Agents', icon: '🤖' },
  { id: 'trackers', label: 'Trackers', icon: '📈' },
  { id: 'devices', label: 'Devices', icon: '🔌' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

export default function App() {
  const [tab, setTab] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('tab') || 'dashboard';
  });
  const [deferredInstall, setDeferredInstall] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [notifStatus, setNotifStatus] = useState(null);
  const { theme, dyslexicFont, settings, initializeApp } = useHealthStore();

  // Sync body background with theme
  useEffect(() => {
    document.body.style.background = theme === 'light' ? '#f8fafc' : '#050810';
    document.body.style.color = theme === 'light' ? '#0f172a' : '#e2e8f0';
  }, [theme]);

  // Init app on mount
  useEffect(() => {
    initializeApp();

    // PWA install prompt capture (Android Chrome)
    const handleInstall = e => {
      e.preventDefault();
      setDeferredInstall(e);
      if (!localStorage.getItem('install_dismissed')) setShowInstallBanner(true);
    };
    window.addEventListener('beforeinstallprompt', handleInstall);

    // Check notification support
    const support = getNotificationSupport();
    setNotifStatus(support);

    // iOS install banner
    if (support.iosNeedsInstall && !localStorage.getItem('ios_install_dismissed')) {
      setTimeout(() => setShowInstallBanner(true), 2000);
    }

    // Register periodic background sync (Android Chrome)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => {
        registerPeriodicSync().then(ok => {
          if (ok) console.log('[App] Background glucose sync registered');
        });
        // Listen for SW messages (glucose updates)
        navigator.serviceWorker.addEventListener('message', e => {
          if (e.data?.type === 'GLUCOSE_UPDATE') {
            useHealthStore.getState().updateGlucose(e.data.glucose);
          }
        });
      });
    }

    return () => window.removeEventListener('beforeinstallprompt', handleInstall);
  }, [initializeApp]);

  // Request notifications after user interaction
  const handleEnableNotifications = useCallback(async () => {
    const result = await requestNotificationPermission();
    if (result.granted) {
      toast.success(result.push ? '🔔 Push notifications enabled!' : '🔔 Notifications enabled (foreground only)');
    } else {
      toast.error('Notifications blocked. Enable in browser settings.');
    }
  }, []);

  // Handle PWA install
  const handleInstall = useCallback(async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      const { outcome } = await deferredInstall.userChoice;
      if (outcome === 'accepted') {
        toast.success('✅ App installed!');
        setShowInstallBanner(false);
      }
    }
  }, [deferredInstall]);

  const PAGE_MAP = { dashboard: Dashboard, agents: Agents, trackers: Trackers, devices: Devices, settings: Settings };
  const ActivePage = PAGE_MAP[tab] || Dashboard;

  return (
    <div className={`app-root ${theme}${dyslexicFont ? ' dyslexic' : ''}`}>
      <Toaster position="top-center" toastOptions={{ style: { background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)' } }} />

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
          />
        </ErrorBoundary>
      </main>

      {/* Footer credit */}
      <footer className="app-footer">
        Made by Ken Wolf with 💚 &nbsp;|&nbsp; <a href="https://su94r.com">Med Inc</a>
      </footer>

      {/* Bottom nav */}
      <nav className="bottom-nav">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`nav-item ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
            aria-label={t.label}
          >
            <span className="nav-icon">{t.icon}</span>
            <span className="nav-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
