import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { I18nProvider } from './lib/i18n.jsx';
// Self-hosted fonts (Fontsource, OFL): no requests to Google Fonts or a font CDN.
import '@fontsource-variable/inter';
import '@fontsource-variable/lexend';
import '@fontsource/share-tech-mono/400.css';
import '@fontsource/opendyslexic/400.css';
import './styles.css';

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      console.log('[su94r] SW registered:', reg.scope);
    }).catch(err => console.warn('[su94r] SW failed:', err));
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);
