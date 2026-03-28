import React, { useState } from 'react';
import { useHealthStore } from '../store/healthStore';
import { requestNotificationPermission, getNotificationSupport } from '../lib/notifications';
import { listAvailableModels } from '../lib/ai-router';
import toast from 'react-hot-toast';

const Section = ({ title, children }) => (
  <div className="settings-section">
    <h2 className="settings-section-title">{title}</h2>
    {children}
  </div>
);

const Field = ({ label, hint, children }) => (
  <div className="settings-field">
    <label className="field-label">{label}</label>
    {hint && <div className="field-hint">{hint}</div>}
    {children}
  </div>
);

const TextInput = ({ value, onChange, placeholder, type = 'text' }) => (
  <input className="settings-input" type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" />
);

export default function Settings({ onRequestNotifications, notifStatus }) {
  const { settings, updateSettings, theme, toggleTheme, dyslexicFont, toggleDyslexic } = useHealthStore();
  const [saved, setSaved] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(Notification.permission === 'granted');
  const [activeTab, setActiveTab] = useState('cgm');
  const availableModels = listAvailableModels();

  const save = (updates) => {
    updateSettings(updates);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    toast.success('Saved!');
  };

  const handleNotifRequest = async () => {
    await onRequestNotifications();
    setNotifEnabled(Notification.permission === 'granted');
  };

  const TAB_CONFIG = [
    { id: 'cgm', label: '🩸 CGM', title: 'Glucose Sources' },
    { id: 'ai', label: '🤖 AI', title: 'AI Models' },
    { id: 'fitness', label: '💪 Fitness', title: 'Fitness APIs' },
    { id: 'notif', label: '🔔 Alerts', title: 'Notifications' },
    { id: 'profile', label: '👤 Profile', title: 'Profile & Units' },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="theme-btn" onClick={toggleDyslexic} title="Dyslexia-friendly font" style={{ fontSize: 14, opacity: dyslexicFont ? 1 : 0.4 }}>Aa</button>
          <button className="theme-btn" onClick={toggleTheme}>{theme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </div>

      {/* AI status summary */}
      <div className="ai-status-card">
        <div className="ai-status-title">Active AI Models</div>
        {availableModels.length > 0 ? (
          availableModels.map(m => (
            <div key={m.id} className="ai-model-row">
              <span>{m.free ? '🟢 Free' : '💳 Paid'}</span>
              <span>{m.name}</span>
              <span className="ai-speed">{m.speed}</span>
            </div>
          ))
        ) : (
          <div className="no-ai-warning">⚠️ No AI configured. Add Groq (free) below to start.</div>
        )}
      </div>

      {/* Tab bar */}
      <div className="settings-tabs">
        {TAB_CONFIG.map(t => (
          <button key={t.id} className={`settings-tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* CGM Sources */}
      {activeTab === 'cgm' && (
        <Section title="Continuous Glucose Monitor">
          <Field label="Glucose Source">
            <select className="settings-input" value={settings.glucoseSource} onChange={e => updateSettings({ glucoseSource: e.target.value })}>
              <option value="libre">FreeStyle Libre 2/3/3+ (LibreLinkUp)</option>
              <option value="dexcom">Dexcom G6/G7 (Dexcom Share)</option>
              <option value="nightscout">Nightscout (Any CGM)</option>
              <option value="manual">Manual Entry</option>
            </select>
          </Field>

          {settings.glucoseSource === 'libre' && (
            <>
              <Field label="LibreLink Email" hint="Your FreeStyle LibreLink app login">
                <TextInput value={settings.libreEmail} onChange={v => updateSettings({ libreEmail: v })} placeholder="you@email.com" type="email" />
              </Field>
              <Field label="LibreLink Password">
                <TextInput value={settings.librePassword} onChange={v => updateSettings({ librePassword: v })} placeholder="••••••••" type="password" />
              </Field>
              <div className="info-card">💡 Make sure LibreLinkUp sharing is enabled in your LibreLink app.</div>
            </>
          )}

          {settings.glucoseSource === 'dexcom' && (
            <>
              <Field label="Dexcom Username">
                <TextInput value={settings.dexcomUser} onChange={v => updateSettings({ dexcomUser: v })} placeholder="dexcom_username" />
              </Field>
              <Field label="Dexcom Password">
                <TextInput value={settings.dexcomPass} onChange={v => updateSettings({ dexcomPass: v })} placeholder="••••••••" type="password" />
              </Field>
              <Field label="Server">
                <select className="settings-input" value={settings.dexcomServer} onChange={e => updateSettings({ dexcomServer: e.target.value })}>
                  <option value="us">US (share2.dexcom.com)</option>
                  <option value="ous">Outside US (shareous1.dexcom.com)</option>
                </select>
              </Field>
            </>
          )}

          {settings.glucoseSource === 'nightscout' && (
            <>
              <Field label="Nightscout URL" hint="e.g. https://mynightscout.herokuapp.com">
                <TextInput value={settings.nightscoutUrl} onChange={v => updateSettings({ nightscoutUrl: v })} placeholder="https://your-nightscout-site.com" />
              </Field>
              <Field label="API Secret (optional)" hint="If your site has auth enabled">
                <TextInput value={settings.nightscoutToken} onChange={v => updateSettings({ nightscoutToken: v })} placeholder="API secret" type="password" />
              </Field>
            </>
          )}
        </Section>
      )}

      {/* AI Models */}
      {activeTab === 'ai' && (
        <Section title="AI Models — Free First">
          <div className="info-card green">
            🟢 <strong>All models below are free tier.</strong> The app picks the best available automatically. Add at least one to use AI agents.
          </div>

          <Field label="🟢 Groq API Key (RECOMMENDED — ultra fast, free)" hint="Get at console.groq.com — supports Llama 3.1 70B">
            <TextInput value={settings.groqKey} onChange={v => updateSettings({ groqKey: v })} placeholder="gsk_..." type="password" />
          </Field>
          <Field label="🟢 Google Gemini API Key (free)" hint="Get at aistudio.google.com">
            <TextInput value={settings.geminiKey} onChange={v => updateSettings({ geminiKey: v })} placeholder="AIza..." type="password" />
          </Field>
          <Field label="🟢 Mistral AI Key (free tier)" hint="Get at console.mistral.ai">
            <TextInput value={settings.mistralKey} onChange={v => updateSettings({ mistralKey: v })} placeholder="..." type="password" />
          </Field>
          <Field label="🟢 Hugging Face Token (free)" hint="Get at huggingface.co/settings/tokens">
            <TextInput value={settings.hfKey} onChange={v => updateSettings({ hfKey: v })} placeholder="hf_..." type="password" />
          </Field>
          <Field label="🏠 Ollama Endpoint (local, free, private)" hint="Run locally: ollama serve — totally private, no internet needed">
            <TextInput value={settings.ollamaEndpoint} onChange={v => updateSettings({ ollamaEndpoint: v })} placeholder="http://localhost:11434" />
          </Field>

          <div className="settings-divider">Optional Paid Models</div>
          <Field label="💳 Anthropic Claude API Key" hint="Best for medical reasoning — claude.ai/settings">
            <TextInput value={settings.claudeKey} onChange={v => updateSettings({ claudeKey: v })} placeholder="sk-ant-..." type="password" />
          </Field>
          <Field label="💳 OpenAI API Key" hint="GPT-4o Mini is cheapest option — platform.openai.com">
            <TextInput value={settings.openaiKey} onChange={v => updateSettings({ openaiKey: v })} placeholder="sk-..." type="password" />
          </Field>

          <button className="btn-save" onClick={() => save({})}>Save AI Keys</button>
        </Section>
      )}

      {/* Fitness APIs */}
      {activeTab === 'fitness' && (
        <Section title="Fitness & Wearable APIs">
          <div className="info-card">💡 These require OAuth — click "Connect" to authorize. Data is stored locally.</div>

          {[
            { key: 'ouraToken', label: 'Oura Ring', icon: '💍', hint: 'Token from cloud.ouraring.com/oauth/authorize' },
            { key: 'fitbitToken', label: 'Fitbit', icon: '⌚', hint: 'OAuth token from dev.fitbit.com' },
            { key: 'garminToken', label: 'Garmin', icon: '🏃', hint: 'From Garmin Health API — apply at developer.garmin.com' },
            { key: 'withingsToken', label: 'Withings', icon: '⚖️', hint: 'From developer.withings.com' },
            { key: 'googleFitToken', label: 'Google Fit', icon: '💪', hint: 'OAuth via Google — requires Google account' },
          ].map(({ key, label, icon, hint }) => (
            <Field key={key} label={`${icon} ${label}`} hint={hint}>
              <TextInput value={settings[key]} onChange={v => updateSettings({ [key]: v })} placeholder="Access token..." type="password" />
            </Field>
          ))}

          <Field label="📍 USDA Food API Key (free)" hint="fdc.nal.usda.gov/api-guide.html — for food nutrition data">
            <TextInput value={settings.usdaKey} onChange={v => updateSettings({ usdaKey: v })} placeholder="DEMO_KEY or your key" />
          </Field>
          <Field label="🍔 Nutritionix App ID + Key (free 500/day)" hint="developer.nutritionix.com — for restaurant food data">
            <div style={{ display: 'flex', gap: 8 }}>
              <TextInput value={settings.nutritionixId} onChange={v => updateSettings({ nutritionixId: v })} placeholder="App ID" />
              <TextInput value={settings.nutritionixKey} onChange={v => updateSettings({ nutritionixKey: v })} placeholder="App Key" type="password" />
            </div>
          </Field>

          <button className="btn-save" onClick={() => save({})}>Save</button>
        </Section>
      )}

      {/* Notifications */}
      {activeTab === 'notif' && (
        <Section title="Alerts & Notifications">
          {/* iOS install prompt */}
          {notifStatus?.iosNeedsInstall && (
            <div className="warning-card">
              📱 <strong>iPhone users:</strong> Add to Home Screen first, then notifications will work.
              <br/>Tap Share → Add to Home Screen → Open from Home Screen
            </div>
          )}

          <div className="notif-status-row">
            <span>Push Notifications</span>
            {notifEnabled ? (
              <span className="status-on">✓ Enabled</span>
            ) : (
              <button className="btn-enable-notif" onClick={handleNotifRequest}>Enable</button>
            )}
          </div>

          <Field label="Very Low Threshold (mg/dL)" hint="Critical alert — bypasses silent mode">
            <input className="settings-input" type="number" value={settings.thresholds.veryLow} onChange={e => updateSettings({ thresholds: { ...settings.thresholds, veryLow: parseInt(e.target.value) } })} />
          </Field>
          <Field label="Low Threshold (mg/dL)">
            <input className="settings-input" type="number" value={settings.thresholds.low} onChange={e => updateSettings({ thresholds: { ...settings.thresholds, low: parseInt(e.target.value) } })} />
          </Field>
          <Field label="High Threshold (mg/dL)">
            <input className="settings-input" type="number" value={settings.thresholds.high} onChange={e => updateSettings({ thresholds: { ...settings.thresholds, high: parseInt(e.target.value) } })} />
          </Field>
          <Field label="Very High Threshold (mg/dL)">
            <input className="settings-input" type="number" value={settings.thresholds.veryHigh} onChange={e => updateSettings({ thresholds: { ...settings.thresholds, veryHigh: parseInt(e.target.value) } })} />
          </Field>

          <Field label="💳 Twilio (optional — for SMS to family)" hint="twilio.com — for sending alerts to family members via SMS">
            <TextInput value={settings.twilioSid} onChange={v => updateSettings({ twilioSid: v })} placeholder="Account SID" />
            <TextInput value={settings.twilioToken} onChange={v => updateSettings({ twilioToken: v })} placeholder="Auth Token" type="password" />
            <TextInput value={settings.twilioFrom} onChange={v => updateSettings({ twilioFrom: v })} placeholder="+1 Phone number" />
          </Field>

          <button className="btn-save" onClick={() => save({})}>Save Alert Settings</button>
        </Section>
      )}

      {/* Profile */}
      {activeTab === 'profile' && (
        <Section title="Profile & Preferences">
          <Field label="Your Name">
            <TextInput value={settings.userName} onChange={v => updateSettings({ userName: v })} placeholder="Ken" />
          </Field>
          <Field label="Glucose Unit">
            <select className="settings-input" value={settings.glucoseUnit} onChange={e => updateSettings({ glucoseUnit: e.target.value })}>
              <option value="mgdl">mg/dL (US)</option>
              <option value="mmol">mmol/L (International)</option>
            </select>
          </Field>
          <Field label="Weight Unit">
            <select className="settings-input" value={settings.weightUnit} onChange={e => updateSettings({ weightUnit: e.target.value })}>
              <option value="lbs">lbs</option>
              <option value="kg">kg</option>
            </select>
          </Field>
          <Field label="Temperature Unit">
            <select className="settings-input" value={settings.tempUnit} onChange={e => updateSettings({ tempUnit: e.target.value })}>
              <option value="f">°F</option>
              <option value="c">°C</option>
            </select>
          </Field>
          <Field label="Dyslexia-Friendly Font" hint="Uses OpenDyslexic font with increased spacing for easier reading">
            <button
              onClick={toggleDyslexic}
              style={{ width: '100%', background: dyslexicFont ? 'var(--cyan)' : 'var(--bg2)', color: dyslexicFont ? '#000' : 'var(--text)', border: `1px solid ${dyslexicFont ? 'var(--cyan)' : 'var(--border2)'}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, fontWeight: 600, cursor: 'pointer', transition: 'all .2s' }}
            >
              {dyslexicFont ? '✓ Dyslexic Font ON' : 'Enable Dyslexic Font'}
            </button>
          </Field>
          <Field label="Diabetes Type">
            <select className="settings-input" value={settings.diabetesType} onChange={e => updateSettings({ diabetesType: e.target.value })}>
              <option value="t1d">Type 1</option>
              <option value="t2d">Type 2</option>
              <option value="lada">LADA</option>
              <option value="mody">MODY</option>
              <option value="none">No diabetes</option>
            </select>
          </Field>

          <button className="btn-save" onClick={() => save({})}>Save Profile</button>

          <div className="danger-zone">
            <div className="danger-title">⚠️ Data</div>
            <button className="btn-danger" onClick={() => {
              if (confirm('Clear all local data? This cannot be undone.')) {
                localStorage.clear();
                window.location.reload();
              }
            }}>Clear All Data</button>
            <div className="field-hint">All data is stored locally on your device. Nothing is shared without your permission.</div>
          </div>
        </Section>
      )}
    </div>
  );
}
