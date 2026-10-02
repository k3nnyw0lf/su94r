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
        // Fitness integrations.
        //
        // googleFitToken was removed: the Google Fit API is deprecated and has
        // been closed to new developer signups since May 2024, so that field
        // could never be filled. Google Health API replaces it — its token is
        // held server-side by the Worker and never reaches this store.
        // fitbitToken is retained but the legacy Fitbit Web API is deprecated
        // September 2026; Google Health supersedes it too.
        fitbitToken: '', garminToken: '', ouraToken: '', withingsToken: '',
        googleHealth: { connected: false, lastSync: null },
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
        // Fitness — what kit you own and when you sit at a desk
        fitness: {
          equipmentClass: ['none', 'minimal'], // none | minimal | gym
          // Populated by the photo scanner. When set it overrides
          // equipmentClass, because an actual inventory beats a coarse tier.
          ownedEquipment: [],
          equipmentScannedAt: null,
          workStart: 9,
          workEnd: 17,
          resistanceDays: 3,
          snacksEnabled: true,
        },
        // Pre-workout glucose gates, mg/dL. Overridable — see lib/fitness/safety.js
        exerciseGates: { hardStop: 90, cautionLow: 125, idealHigh: 250, ketoneCheck: 270 },
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
        workouts: [],          // [{ id, startedAt, endedAt, modality, title, blocks, glucosePre, glucoseChecks, glucosePost }]
        doses: [],             // [{ id, units, insulinType, category, context, takenAt, carbsGrams }]
        ketones: [],           // [{ id, mmol, source, timestamp, glucoseMgdl }]
        treatments: [],        // [{ id, carbsGrams, what, takenAt }]
        sensors: [],           // [{ id, type, startedAt, endedAt }]
        meals: [],             // [{ id, at, total, low, high, items, confidence }]
        postureScans: [],      // [{ id, assessedAt, findings }]  — results only, never photos
        sickEpisodes: [],      // [{ id, startedAt, endedAt, note }]
      },
      addMetric: (type, entry) => set(s => ({
        metrics: {
          ...s.metrics,
          [type]: [entry, ...(s.metrics[type] || [])].slice(0, 1000),
        },
      })),

      // ── Workout session ───────────────────────────────────────────────────
      // Exactly one session can be in flight. It is held separately from
      // metrics.workouts and only committed there on finish, so an abandoned
      // session never pollutes the correlation history.
      activeSession: null,

      startWorkout: ({ modality, title, blocks = [], glucosePre = null, safety = null }) => {
        const session = {
          id: `w_${Date.now()}`,
          startedAt: new Date().toISOString(),
          endedAt: null,
          modality,
          title,
          blocks,
          glucosePre,
          safety,           // the preWorkoutCheck verdict at start time
          glucoseChecks: [], // [{ timestamp, value }]
          completed: {},     // { [blockIndex]: [{ reps, weight, rpe }] }
          notes: '',
        };
        set({ activeSession: session });
        return session;
      },

      logSet: (blockIndex, entry) => set(s => {
        if (!s.activeSession) return {};
        const completed = { ...s.activeSession.completed };
        completed[blockIndex] = [...(completed[blockIndex] || []), entry];
        return { activeSession: { ...s.activeSession, completed } };
      }),

      logWorkoutGlucose: (reading) => set(s => {
        if (!s.activeSession || reading?.value == null) return {};
        return {
          activeSession: {
            ...s.activeSession,
            glucoseChecks: [
              ...s.activeSession.glucoseChecks,
              { timestamp: reading.timestamp || new Date().toISOString(), value: reading.value },
            ],
          },
        };
      }),

      setWorkoutNotes: (notes) => set(s =>
        s.activeSession ? { activeSession: { ...s.activeSession, notes } } : {}
      ),

      finishWorkout: (glucosePost = null) => {
        const { activeSession } = get();
        if (!activeSession) return null;
        const finished = {
          ...activeSession,
          endedAt: new Date().toISOString(),
          glucosePost,
        };
        set(s => ({
          activeSession: null,
          metrics: { ...s.metrics, workouts: [finished, ...(s.metrics.workouts || [])].slice(0, 1000) },
        }));
        return finished;
      },

      /** Drops an in-flight session without recording it. */
      cancelWorkout: () => set({ activeSession: null }),

      // ── Log entries ───────────────────────────────────────────────────────
      // One helper rather than six near-identical ones. Newest first, capped,
      // so a long-running install cannot grow localStorage without bound.
      logEntry: (collection, entry, cap = 2000) => set(s => ({
        metrics: {
          ...s.metrics,
          [collection]: [entry, ...(s.metrics[collection] || [])].slice(0, cap),
        },
      })),

      removeEntry: (collection, id) => set(s => ({
        metrics: {
          ...s.metrics,
          [collection]: (s.metrics[collection] || []).filter(e => e.id !== id),
        },
      })),

      /** Starts a sensor and closes any still-open one. */
      startSensor: (type) => set(s => {
        const now = new Date().toISOString();
        const sensors = (s.metrics.sensors || []).map(x =>
          x.endedAt ? x : { ...x, endedAt: now }
        );
        return {
          metrics: {
            ...s.metrics,
            sensors: [{ id: `s_${Date.now()}`, type, startedAt: now, endedAt: null }, ...sensors].slice(0, 200),
          },
        };
      }),

      /** Sick-day toggle. Closes the open episode rather than opening a second. */
      setSickDay: (on, note = '') => set(s => {
        const episodes = s.metrics.sickEpisodes || [];
        const open = episodes.find(e => !e.endedAt);
        const now = new Date().toISOString();

        if (on && !open) {
          return {
            metrics: {
              ...s.metrics,
              sickEpisodes: [{ id: `k_${Date.now()}`, startedAt: now, endedAt: null, note }, ...episodes],
            },
          };
        }
        if (!on && open) {
          return {
            metrics: {
              ...s.metrics,
              sickEpisodes: episodes.map(e => (e.id === open.id ? { ...e, endedAt: now } : e)),
            },
          };
        }
        return {};
      }),

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
