import React, { useState, useEffect, useCallback } from 'react';
import { useHealthStore } from '../store/healthStore';

const TREND = {
  1: { sym: '⬇', label: 'Dropping Fast', rot: 90 },
  2: { sym: '↘', label: 'Dropping', rot: 45 },
  3: { sym: '→', label: 'Stable', rot: 0 },
  4: { sym: '↗', label: 'Rising', rot: -45 },
  5: { sym: '⬆', label: 'Rising Fast', rot: -90 },
};

function gColor(v) {
  if (!v) return { c: 'var(--muted)', lbl: '—', e: '·' };
  if (v < 55)  return { c: 'var(--red)',   lbl: 'CRITICAL LOW',  e: '🚨' };
  if (v < 70)  return { c: 'var(--amber)', lbl: 'LOW',           e: '⚠️' };
  if (v > 250) return { c: 'var(--red)',   lbl: 'CRITICAL HIGH', e: '🚨' };
  if (v > 180) return { c: 'var(--amber)', lbl: 'HIGH',          e: '📈' };
  return { c: 'var(--green)', lbl: 'IN RANGE', e: '✓' };
}

// ── SVG Glucose Chart ──────────────────────────────────────────────────────
function GlucoseChart({ readings }) {
  if (!readings || readings.length < 2) {
    return (
      <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12, fontFamily: 'var(--mono)' }}>
        Collecting readings…
      </div>
    );
  }
  const W = 560, H = 100, P = 14;
  const vals = readings.map(r => r.value || r.glucose_mgdl || 0);
  const minV = Math.min(...vals, 58) - 6, maxV = Math.max(...vals, 200) + 8;
  const rng = maxV - minV;
  const pts = readings.map((r, i) => [
    P + (i / (readings.length - 1)) * (W - P * 2),
    H - P - ((( r.value || r.glucose_mgdl || 0) - minV) / rng) * (H - P * 2)
  ]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = d + ` L${pts[pts.length-1][0]},${H} L${pts[0][0]},${H} Z`;
  const lastVal = vals[vals.length - 1];
  const col = gColor(lastVal).c;
  const lowY = H - P - ((70 - minV) / rng) * (H - P * 2);
  const highY = H - P - ((180 - minV) / rng) * (H - P * 2);
  const [lx, ly] = pts[pts.length - 1];

  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <linearGradient id="ggrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.3" />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      {lowY > P && lowY < H && <line x1={P} y1={lowY.toFixed(1)} x2={W-P} y2={lowY.toFixed(1)} stroke="var(--amber)" strokeWidth="1" strokeDasharray="3,4" opacity="0.5" />}
      {highY > P && highY < H && <line x1={P} y1={highY.toFixed(1)} x2={W-P} y2={highY.toFixed(1)} stroke="var(--amber)" strokeWidth="1" strokeDasharray="3,4" opacity="0.5" />}
      <path d={area} fill="url(#ggrad)" />
      <path d={d} fill="none" stroke={col} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx.toFixed(1)} cy={ly.toFixed(1)} r="5" fill={col} />
      <circle cx={lx.toFixed(1)} cy={ly.toFixed(1)} r="5" fill={col} opacity="0.35">
        <animate attributeName="r" values="5;14;5" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0;0.4" dur="2s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

// ── Metric Tile ────────────────────────────────────────────────────────────
function MetricTile({ icon, name, value, unit, time, color }) {
  return (
    <div className="metric-tile" style={{ borderTop: `2px solid ${color || 'transparent'}` }}>
      <div className="metric-icon">{icon}</div>
      <div className="metric-name">{name}</div>
      {value !== null && value !== undefined ? (
        <>
          <div className="metric-val" style={{ color: color || 'var(--text)' }}>{value}</div>
          <div className="metric-unit">{unit}</div>
          {time && <div className="metric-time">{time}</div>}
        </>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>No data yet</div>
      )}
    </div>
  );
}

// ── Time ago ───────────────────────────────────────────────────────────────
function useTimeAgo(ts) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!ts) return;
    const calc = () => {
      const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
      if (s < 60) setLabel(`${s}s ago`);
      else if (s < 3600) setLabel(`${Math.floor(s/60)}m ago`);
      else setLabel(`${Math.floor(s/3600)}h ago`);
    };
    calc();
    const t = setInterval(calc, 15000);
    return () => clearInterval(t);
  }, [ts]);
  return label;
}

// ── Dashboard ──────────────────────────────────────────────────────────────
export default function Dashboard({ onRequestNotifications, notifStatus }) {
  const { glucose, metrics, settings, fetchHealthData, lastSync } = useHealthStore();
  const timeAgo = useTimeAgo(glucose.current?.timestamp);
  const [showNotifBanner, setShowNotifBanner] = useState(false);

  useEffect(() => {
    if (Notification.permission === 'default') {
      setTimeout(() => setShowNotifBanner(true), 3000);
    }
  }, []);

  const cur = glucose.current;
  const col = gColor(cur?.value);
  const trend = TREND[cur?.trend] || TREND[3];
  const mmol = cur?.value ? (cur.value / 18.0182).toFixed(1) : '—';

  const latestHR = metrics.heartRate?.[0];
  const latestSleep = metrics.sleep?.[0];
  const latestBP = metrics.bloodPressure?.[0];
  const latestWeight = metrics.weight?.[0];
  const latestSteps = metrics.steps?.[0];
  const latestSpO2 = metrics.spo2?.[0];

  const hasGlucoseConfig = settings.libreEmail || settings.dexcomUser || settings.nightscoutUrl;

  return (
    <div className="page fade-up">
      {/* Header */}
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="live-indicator">
              <div className="live-dot" />
            </div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 400, letterSpacing: 3, color: 'var(--cyan)' }}>
              su94r
            </span>
          </div>
          {settings.userName && (
            <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
              {settings.userName}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
            {lastSync ? `synced ${new Date(lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'not synced'}
          </div>
          {glucose.error && (
            <div style={{ fontSize: 10, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>⚠ {glucose.error}</div>
          )}
        </div>
      </div>

      {/* Notification prompt */}
      {showNotifBanner && (
        <div className="info-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span>🔔 Enable alerts for critical glucose notifications</span>
          <button style={{ background: 'var(--green)', color: '#000', border: 'none', borderRadius: 8, padding: '5px 12px', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' }}
            onClick={() => { onRequestNotifications(); setShowNotifBanner(false); }}>
            Enable
          </button>
          <button style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16 }}
            onClick={() => setShowNotifBanner(false)}>✕</button>
        </div>
      )}

      {/* No CGM configured */}
      {!hasGlucoseConfig && (
        <div className="warning-card">
          No CGM configured. Go to <strong>Settings → CGM</strong> to connect Libre, Dexcom, or Nightscout.
        </div>
      )}

      {/* Main glucose card */}
      <div className="card" style={{ borderColor: cur ? col.c.replace('var(--', 'rgba(').replace(')', ', 0.3)').replace('rgba(--', 'rgba(') : 'var(--border2)', borderTopWidth: 2 }}>
        <div className="glucose-hero">
          <div className="glucose-source">
            {cur?.source?.toUpperCase() || 'GLUCOSE'} · CGM
          </div>
          <div className="glucose-value" style={{ color: col.c }}>
            {cur?.value || '—'}
          </div>
          <div className="glucose-unit">
            mg/dL · {mmol} mmol/L
          </div>
          <div style={{ marginTop: 10 }}>
            <div
              className="glucose-trend"
              style={{ color: col.c, transform: `rotate(${trend.rot}deg)`, display: 'inline-block' }}
            >→</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 3 }}>
              {trend.label}
            </div>
          </div>
          <div className="glucose-badge" style={{
            background: cur ? col.c.replace('var(--', '').replace(')', '') === 'green' ? 'rgba(34,197,94,0.12)' : col.c.replace('var(--', '').replace(')', '') === 'amber' ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)' : 'transparent',
            color: col.c,
          }}>
            {col.e} {col.lbl}
          </div>
          <div className="glucose-time">
            {timeAgo ? `${timeAgo} · ` : ''}{cur?.source || 'No data'}
          </div>
        </div>

        {/* Chart */}
        <div>
          <div className="chart-meta">
            <span className="chart-meta-label">3-HOUR HISTORY</span>
            <span className="chart-meta-label" style={{ color: 'var(--amber)' }}>— 70 / 180</span>
          </div>
          <GlucoseChart readings={glucose.history?.slice(-36)} />
          <div className="chart-legend">
            <span><span style={{ color: 'var(--red)' }}>●</span> {'<70 / >250'}</span>
            <span><span style={{ color: 'var(--amber)' }}>●</span> Caution</span>
            <span><span style={{ color: 'var(--green)' }}>●</span> In range</span>
          </div>
        </div>
      </div>

      {/* Recent readings */}
      <div className="card">
        <div className="card-title">Recent Readings</div>
        {glucose.history && glucose.history.length > 0 ? (
          glucose.history.slice(0, 8).map((r, i) => {
            const rc = gColor(r.value || r.glucose_mgdl);
            const rt = TREND[r.trend] || TREND[3];
            return (
              <div key={i} className="reading-row" style={{ opacity: Math.max(0.2, 1 - i * 0.1) }}>
                <span className="reading-val" style={{ color: rc.c }}>{r.value || r.glucose_mgdl}</span>
                <span className="reading-label">mg/dL</span>
                <span className="reading-trend" style={{ color: rc.c }}>{rt.label}</span>
                <span className="reading-time">
                  {r.timestamp ? new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                </span>
              </div>
            );
          })
        ) : (
          <div style={{ color: 'var(--muted)', fontSize: 13, padding: '12px 0', textAlign: 'center', fontFamily: 'var(--mono)' }}>
            No readings yet. Configure your CGM in Settings.
          </div>
        )}
      </div>

      {/* Other metrics grid */}
      <div className="card-title" style={{ marginTop: 4, marginBottom: 10 }}>Other Metrics</div>
      <div className="metrics-grid">
        <MetricTile icon="❤️" name="HEART RATE" value={latestHR?.bpm || null} unit="bpm" color="var(--red)" time={latestHR ? new Date(latestHR.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null} />
        <MetricTile icon="💤" name="SLEEP" value={latestSleep ? `${Math.round(latestSleep.duration / 3600)}h ${Math.round((latestSleep.duration % 3600) / 60)}m` : null} unit={latestSleep ? `${latestSleep.efficiency || '—'}% eff` : ''} color="var(--purple)" time={latestSleep?.date} />
        <MetricTile icon="🫀" name="BLOOD PRESSURE" value={latestBP ? `${latestBP.systolic}/${latestBP.diastolic}` : null} unit="mmHg" color="var(--amber)" time={latestBP ? new Date(latestBP.timestamp).toLocaleDateString() : null} />
        <MetricTile icon="⚖️" name="WEIGHT" value={latestWeight?.value || null} unit={settings.weightUnit || 'lbs'} color="var(--cyan)" time={latestWeight?.date} />
        <MetricTile icon="👟" name="STEPS" value={latestSteps?.count?.toLocaleString() || null} unit="steps" color="var(--green)" time={latestSteps?.date} />
        <MetricTile icon="🫁" name="SpO2" value={latestSpO2?.value || null} unit="%" color={latestSpO2?.value < 94 ? 'var(--red)' : 'var(--cyan)'} time={latestSpO2 ? new Date(latestSpO2.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null} />
      </div>

      {/* Refresh button */}
      <button onClick={fetchHealthData} disabled={glucose.loading} style={{ width: '100%', background: 'var(--card)', border: '1px solid var(--border2)', borderRadius: 12, padding: 13, color: glucose.loading ? 'var(--muted)' : 'var(--cyan)', fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 1, cursor: 'pointer', transition: 'all .2s', marginTop: 4 }}>
        {glucose.loading ? '⟳ Syncing…' : '⟳ Refresh Now'}
      </button>
    </div>
  );
}
