// ═══════════════════════════════════════════════════════════════════════════
// Open Health Monitor — Notification Manager
// Handles VAPID push subscription, alert scheduling, critical notifications
// ═══════════════════════════════════════════════════════════════════════════

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

// ── Push subscription ──────────────────────────────────────────────────────
export async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    return { granted: false, reason: 'Notifications not supported in this browser' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { granted: false, reason: 'Permission denied by user' };
  }

  // Register service worker if not already
  if (!('serviceWorker' in navigator)) {
    return { granted: true, push: false, reason: 'Service Worker not supported — foreground only' };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await subscribeToPush(registration);
    return { granted: true, push: true, subscription };
  } catch (err) {
    console.warn('[Notifications] Push subscription failed:', err);
    return { granted: true, push: false, reason: 'Push subscription failed — foreground only' };
  }
}

async function subscribeToPush(registration) {
  // Check for existing subscription
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) return subscription;

  // Create new subscription
  const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });

  // Send subscription to your server (Supabase/Cloudflare)
  await saveSubscription(subscription);
  return subscription;
}

async function saveSubscription(subscription) {
  const serverUrl = import.meta.env.VITE_PUSH_SERVER_URL;
  if (!serverUrl) {
    // Store locally if no server configured
    localStorage.setItem('push_subscription', JSON.stringify(subscription));
    return;
  }
  try {
    await fetch(`${serverUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription }),
    });
  } catch (e) {
    localStorage.setItem('push_subscription', JSON.stringify(subscription));
  }
}

// ── Foreground notification (no server needed) ─────────────────────────────
export function showLocalNotification(title, options = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  
  const { urgency = 'normal', ...rest } = options;
  const isCritical = urgency === 'critical';

  return new Notification(title, {
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    requireInteraction: isCritical,
    vibrate: isCritical ? [500, 200, 500, 200, 500] : [200],
    tag: rest.tag || 'health',
    renotify: true,
    ...rest,
  });
}

// ── Glucose alert checker ──────────────────────────────────────────────────
let lastAlertTime = {};
const ALERT_COOLDOWN = 5 * 60 * 1000; // 5 min between same-type alerts

export function checkGlucoseAlert(reading, thresholds = {}) {
  const { value, trend } = reading;
  const {
    veryLow = 55, low = 70, high = 180, veryHigh = 250,
    enableLow = true, enableHigh = true, enableTrend = true,
  } = thresholds;

  const TREND_TEXT = ['', '⬇ Dropping Fast', '↘ Dropping', '→ Stable', '↗ Rising', '⬆ Rising Fast'];

  // Determine alert type
  let alertType = null, urgency = 'normal', title = '', body = '';

  if (value < veryLow && enableLow) {
    alertType = 'very_low'; urgency = 'critical';
    title = `🚨 CRITICAL LOW — ${value} mg/dL`;
    body = 'Treat IMMEDIATELY with fast carbs. If unconscious, use glucagon.';
  } else if (value < low && enableLow) {
    alertType = 'low'; urgency = 'warning';
    title = `⚠️ LOW — ${value} mg/dL ${TREND_TEXT[trend] || ''}`;
    body = 'Eat 15g fast carbs. Recheck in 15 minutes.';
  } else if (value > veryHigh && enableHigh) {
    alertType = 'very_high'; urgency = 'critical';
    title = `🚨 CRITICAL HIGH — ${value} mg/dL`;
    body = 'Check ketones. Consider correction. Call doctor if ketones elevated.';
  } else if (value > high && enableHigh) {
    alertType = 'high'; urgency = 'warning';
    title = `📈 HIGH — ${value} mg/dL`;
    body = 'Consider correction dose per your care plan.';
  } else if (trend === 1 && enableTrend && value < 100) {
    alertType = 'dropping_fast'; urgency = 'warning';
    title = `↓ Dropping Fast — ${value} mg/dL`;
    body = 'Glucose falling rapidly. Prepare fast carbs.';
  } else if (trend === 5 && enableTrend) {
    alertType = 'rising_fast'; urgency = 'info';
    title = `↑ Rising Fast — ${value} mg/dL`;
    body = 'Glucose rising quickly. Consider correction if needed.';
  }

  if (!alertType) return null;

  // Check cooldown (don't spam same alert)
  const now = Date.now();
  const cooldown = urgency === 'critical' ? 0 : ALERT_COOLDOWN; // Critical = always show
  if (lastAlertTime[alertType] && now - lastAlertTime[alertType] < cooldown) return null;
  lastAlertTime[alertType] = now;

  // Show notification
  showLocalNotification(title, { body, urgency, tag: alertType });

  return { alertType, urgency, title, body };
}

// ── Scheduled reminders ────────────────────────────────────────────────────
const scheduleTimers = {};

export function scheduleReminder(id, { label, time, days = [0,1,2,3,4,5,6], enabled = true }) {
  clearReminder(id);
  if (!enabled) return;

  function schedule() {
    const [h, m] = time.split(':').map(Number);
    const now = new Date();
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const ms = next.getTime() - now.getTime();
    scheduleTimers[id] = setTimeout(() => {
      const dayOfWeek = new Date().getDay();
      if (days.includes(dayOfWeek)) {
        showLocalNotification(`⏰ ${label}`, {
          body: `Scheduled health reminder`,
          tag: `reminder-${id}`,
        });
      }
      schedule(); // reschedule for next day
    }, ms);
  }

  schedule();
}

export function clearReminder(id) {
  if (scheduleTimers[id]) {
    clearTimeout(scheduleTimers[id]);
    delete scheduleTimers[id];
  }
}

// ── Background Periodic Sync registration ─────────────────────────────────
// Works on Android Chrome to poll glucose even when app is closed
export async function registerPeriodicSync() {
  if (!('serviceWorker' in navigator) || !('periodicSync' in ServiceWorkerRegistration.prototype)) {
    console.log('[Notifications] Periodic Background Sync not supported');
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state !== 'granted') {
      console.log('[Notifications] Periodic sync permission denied');
      return false;
    }

    await registration.periodicSync.register('glucose-sync', {
      minInterval: 5 * 60 * 1000, // 5 minutes
    });
    console.log('[Notifications] Periodic sync registered ✓');
    return true;
  } catch (err) {
    console.warn('[Notifications] Periodic sync registration failed:', err);
    return false;
  }
}

// ── iOS Push notification check ────────────────────────────────────────────
export function getNotificationSupport() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isPWA = window.matchMedia('(display-mode: standalone)').matches;
  const isIOSSafari = isIOS && /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
  const iOSVersion = isIOS ? parseInt((navigator.userAgent.match(/OS (\d+)/) || [])[1] || '0') : 0;

  return {
    isIOS,
    isPWA,
    isIOSSafari,
    iOSVersion,
    pushSupported: 'PushManager' in window,
    notifSupported: 'Notification' in window,
    periodicSyncSupported: 'periodicSync' in ServiceWorkerRegistration.prototype,
    // iOS push only works when installed as PWA (iOS 16.4+)
    iosNeedsInstall: isIOS && !isPWA,
    iosPushSupported: isIOS && isPWA && iOSVersion >= 16,
  };
}

// ── VAPID key helper ───────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// ── Notify family (via server push) ───────────────────────────────────────
export async function notifyFamily(alert, familySubscriptions = []) {
  const serverUrl = import.meta.env.VITE_PUSH_SERVER_URL;
  if (!serverUrl || !familySubscriptions.length) return;

  try {
    await fetch(`${serverUrl}/api/push/notify-family`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert, subscriptions: familySubscriptions }),
    });
  } catch (err) {
    console.warn('[Notifications] Family notification failed:', err);
  }
}
