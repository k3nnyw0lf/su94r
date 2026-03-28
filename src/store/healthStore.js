import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { fetchAllHealthData } from '../lib/apis/health';
import { checkGlucoseAlert } from '../lib/notifications';

export const useHealthStore = create(
  persist(
    (set, get) => ({
      // ── Theme ─────────────────────────────────────────────────────────────
      theme: 'dark',
      dyslexicFont: false,
      toggleTheme: () => set(s => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      toggleDyslexic: () => set(s => ({ dyslexicFont: !s.dyslexicFont })),

      // ── Settings / API Keys ───────────────────────────────────────────────
      settings: {
        userName: '',
        glucoseSource: 'libre', // libre | dexcom | nightscout | manual
        libreEmail: '', librePassword: '',
        dexcomUser: '', dexcomPass: '', dexcomServer: 'us',
        nightscoutUrl: '', nightscoutToken: '',
        // Fitness integrations
        fitbitToken: '', googleFitToken: '', garminToken: '', ouraToken: '', withingsToken: '',
        // AI keys
        groqKey: '', geminiKey: '', mistralKey: '', hfKey: '', ollamaEndpoint: '',
        claudeKey: '', openaiKey: '',
        // Notification settings
        thresholds: { veryLow: 55, low: 70, high: 180, veryHigh: 250 },
        alertsEnabled: true,
        familyPhones: [], // for SMS via Twilio
        // Units
        glucoseUnit: 'mgdl', // mgdl | mmol
        weightUnit: 'lbs', // lbs | kg
        tempUnit: 'f', // f | c
      },
      updateSettings: (updates) => set(s => ({
        settings: { ...s.settings, ...updates },
      })),

      // ── Glucose Data ──────────────────────────────────────────────────────
      glucose: {
        current: null,     // { value, trend, timestamp, source }
        history: [],       // last 36 readings (3 hours)
        lastFetch: null,
        loading: false,
        error: null,
      },
      updateGlucose: (reading) => set(s => ({
        glucose: {
          ...s.glucose,
          current: reading,
          history: [reading, ...s.glucose.history].slice(0, 288), // 24hr at 5min
          lastFetch: new Date().toISOString(),
        },
      })),

      // ── Health Metrics ────────────────────────────────────────────────────
      metrics: {
        heartRate: [],         // [{ timestamp, bpm, hrv }]
        sleep: [],             // [{ date, duration, efficiency, stages }]
        bloodPressure: [],     // [{ timestamp, systolic, diastolic }]
        weight: [],            // [{ date, value, unit }]
        steps: [],             // [{ date, count }]
        spo2: [],              // [{ timestamp, value }]
        ketones: [],           // [{ timestamp, value, unit }]
        temperature: [],       // [{ timestamp, value }]
        medications: [],       // [{ id, name, dose, time, taken }]
        nutrition: [],         // [{ date, meals: [] }]
        labs: [],              // [{ date, type, value, unit }]
        mood: [],              // [{ timestamp, score, note }]
      },
      addMetric: (type, entry) => set(s => ({
        metrics: {
          ...s.metrics,
          [type]: [entry, ...(s.metrics[type] || [])].slice(0, 1000),
        },
      })),

      // ── Fetch all data ────────────────────────────────────────────────────
      loading: false,
      lastSync: null,
      fetchHealthData: async () => {
        const { settings } = get();
        set(s => ({ ...s, glucose: { ...s.glucose, loading: true, error: null } }));
        try {
          const data = await fetchAllHealthData({
            glucoseSource: settings.glucoseSource,
            libreEmail: settings.libreEmail,
            librePassword: settings.librePassword,
            dexcomUser: settings.dexcomUser,
            dexcomPass: settings.dexcomPass,
            dexcomServer: settings.dexcomServer,
            nightscoutUrl: settings.nightscoutUrl,
            nightscoutToken: settings.nightscoutToken,
          });

          if (data.glucose) {
            const { current, history } = data.glucose;
            set(s => ({
              glucose: {
                current,
                history: history || [],
                lastFetch: new Date().toISOString(),
                loading: false,
                error: null,
              },
            }));
            // Check for alerts
            if (settings.alertsEnabled && current) {
              checkGlucoseAlert(current, settings.thresholds);
            }
          }

          set({ lastSync: new Date().toISOString() });
        } catch (err) {
          set(s => ({ glucose: { ...s.glucose, loading: false, error: err.message } }));
        }
      },

      // ── Initialize ────────────────────────────────────────────────────────
      initializeApp: () => {
        const { fetchHealthData, settings } = get();
        // Initial fetch
        if (settings.glucoseSource && (settings.libreEmail || settings.dexcomUser || settings.nightscoutUrl)) {
          fetchHealthData();
        }
        // Poll every 5 minutes
        const interval = setInterval(() => fetchHealthData(), 5 * 60 * 1000);
        return () => clearInterval(interval);
      },

      // ── Agent conversation history ─────────────────────────────────────
      agentConversations: {}, // { agentId: [{ role, content }] }
      addAgentMessage: (agentId, message) => set(s => ({
        agentConversations: {
          ...s.agentConversations,
          [agentId]: [...(s.agentConversations[agentId] || []), message].slice(-50),
        },
      })),
      clearAgentConversation: (agentId) => set(s => ({
        agentConversations: { ...s.agentConversations, [agentId]: [] },
      })),
    }),
    {
      name: 'open-health-monitor',
      // Don't persist passwords in plain text in a real app — use secure storage
      partialize: (state) => ({
        theme: state.theme,
        dyslexicFont: state.dyslexicFont,
        settings: state.settings,
        metrics: state.metrics,
        agentConversations: state.agentConversations,
      }),
    }
  )
);
