import React, { useState, useEffect, useMemo } from 'react';
import { useHealthStore } from '../store/healthStore';
import { LineChart, Line, XAxis, YAxis, ReferenceLine, ReferenceArea, ResponsiveContainer, Tooltip } from 'recharts';

const TREND = {
  1: { sym: '⬇', label: 'Dropping Fast', rot: 90 },
  2: { sym: '↘', label: 'Dropping', rot: 45 },
  3: { sym: '→', label: 'Stable', rot: 0 },
  4: { sym: '↗', label: 'Rising', rot: -45 },
  5: { sym: '⬆', label: 'Rising Fast', rot: -90 },
};

function gColor(v) {
  if (!v) return { c: 'var(--muted)', lbl: '—', e: '·', cls: '' };
  if (v < 55)  return { c: 'var(--red)',   lbl: 'CRITICAL LOW',  e: '🚨', cls: 'critical' };
  if (v < 70)  return { c: 'var(--amber)', lbl: 'LOW',           e: '⚠️', cls: 'low' };
  if (v > 250) return { c: 'var(--red)',   lbl: 'CRITICAL HIGH', e: '🚨', cls: 'critical' };
  if (v > 180) return { c: 'var(--amber)', lbl: 'HIGH',          e: '📈', cls: 'high' };
  return { c: 'var(--green)', lbl: 'IN RANGE', e: '✓', cls: 'inrange' };
}

// ── Time in Range Calculator ─────────────────────────────────────────────
function calcTIR(history) {
  if (!history || history.length < 2) return null;
  const vals = history.map(r => r.value || r.glucose_mgdl).filter(v => v > 0);
  if (vals.length === 0) return null;
  const total = vals.length;
  const veryLow = vals.filter(v => v < 54).length;
  const low = vals.filter(v => v >= 54 && v < 70).length;
  const inRange = vals.filter(v => v >= 70 && v <= 180).length;
  const high = vals.filter(v => v > 180 && v <= 250).length;
  const veryHigh = vals.filter(v => v > 250).length;
  const avg = vals.reduce((a, b) => a + b, 0) / total;
  const gmi = 3.31 + 0.02392 * avg; // Glucose Management Indicator
  const sd = Math.sqrt(vals.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / total);
  const cv = (sd / avg) * 100;
  return {
    veryLow: (veryLow / total * 100).toFixed(1),
    low: (low / total * 100).toFixed(1),
    inRange: (inRange / total * 100).toFixed(1),
    high: (high / total * 100).toFixed(1),
    veryHigh: (veryHigh / total * 100).toFixed(1),
    avg: Math.round(avg),
    gmi: gmi.toFixed(1),
    cv: cv.toFixed(1),
    sd: Math.round(sd),
    readings: total,
  };
}

// ── TIR Bar ──────────────────────────────────────────────────────────────
function TIRBar({ tir }) {
  if (!tir) return null;
  const segments = [
    { pct: parseFloat(tir.veryLow), color: '#dc2626', label: '<54' },
    { pct: parseFloat(tir.low), color: '#f59e0b', label: '54-69' },
    { pct: parseFloat(tir.inRange), color: '#22c55e', label: '70-180' },
    { pct: parseFloat(tir.high), color: '#f59e0b', label: '181-250' },
    { pct: parseFloat(tir.veryHigh), color: '#dc2626', label: '>250' },
  ];
  return (
    <div className="tir-container">
      <div className="tir-bar">
        {segments.map((s, i) => s.pct > 0 && (
          <div key={i} className="tir-segment" style={{ width: `${s.pct}%`, background: s.color }} title={`${s.label}: ${s.pct}%`} />
        ))}
      </div>
      <div className="tir-labels">
        {segments.map((s, i) => s.pct > 0 && (
          <span key={i} style={{ color: s.color }}>{s.pct}%</span>
        ))}
      </div>
    </div>
  );
}

// ── Recharts Glucose Chart ───────────────────────────────────────────────
function GlucoseChart({ readings }) {
  if (!readings || readings.length < 2) {
    return (
      <div className="chart-empty">
        <span className="chart-empty-icon">📉</span>
        <span>Collecting readings…</span>
      </div>
    );
  }

  const data = readings.map(r => ({
    time: new Date(r.timestamp).getTime(),
    value: r.value || r.glucose_mgdl || 0,
    label: new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  })).reverse();

  const lastVal = data[data.length - 1]?.value;
  const strokeColor = lastVal < 70 ? '#f59e0b' : lastVal > 250 ? '#ef4444' : lastVal > 180 ? '#f59e0b' : '#22c55e';

  return (
    <ResponsiveContainer width="100%" height={140}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -20 }}>
        <defs>
          <linearGradient id="glucoseGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={strokeColor} stopOpacity={0.2} />
            <stop offset="95%" stopColor={strokeColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        <ReferenceArea y1={70} y2={180} fill="#22c55e" fillOpacity={0.04} />
        <ReferenceLine y={70} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.4} />
        <ReferenceLine y={180} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.4} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: '#64748b', fontFamily: 'Share Tech Mono' }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={40}
        />
        <YAxis
          domain={['dataMin - 10', 'dataMax + 10']}
          tick={{ fontSize: 10, fill: '#64748b', fontFamily: 'Share Tech Mono' }}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip
          contentStyle={{ background: '#0a1020', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, fontSize: 12, fontFamily: 'Share Tech Mono' }}
          labelStyle={{ color: '#64748b' }}
          formatter={(val) => [`${val} mg/dL`, 'Glucose']}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke={strokeColor}
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 4, fill: strokeColor, stroke: '#0a1020', strokeWidth: 2 }}
          fill="url(#glucoseGrad)"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Stats Card ───────────────────────────────────────────────────────────
function StatsCard({ tir }) {
  if (!tir) return null;
  return (
    <div className="stats-grid">
      <div className="stat-item">
        <div className="stat-value" style={{ color: 'var(--cyan)' }}>{tir.avg}</div>
        <div className="stat-label">AVG mg/dL</div>
      </div>
      <div className="stat-item">
        <div className="stat-value" style={{ color: parseFloat(tir.gmi) < 7 ? 'var(--green)' : parseFloat(tir.gmi) < 8 ? 'var(--amber)' : 'var(--red)' }}>{tir.gmi}%</div>
        <div className="stat-label">GMI (est. A1c)</div>
      </div>
      <div className="stat-item">
        <div className="stat-value" style={{ color: parseFloat(tir.cv) < 36 ? 'var(--green)' : 'var(--amber)' }}>{tir.cv}%</div>
        <div className="stat-label">CV</div>
      </div>
      <div className="stat-item">
        <div className="stat-value" style={{ color: 'var(--green)' }}>{tir.inRange}%</div>
        <div className="stat-label">TIME IN RANGE</div>
      </div>
    </div>
  );
}

// ── Metric Tile ──────────────────────────────────────────────────────────
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
        <div className="metric-empty">No data</div>
      )}
    </div>
  );
}

// ── Time ago hook ────────────────────────────────────────────────────────
function useTimeAgo(ts) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!ts) return;
    const calc = () => {
      const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
      if (s < 60) setLabel(`${s}s ago`);
      else if (s < 3600) setLabel(`${Math.floor(s / 60)}m ago`);
      else setLabel(`${Math.floor(s / 3600)}h ago`);
    };
    calc();
    const t = setInterval(calc, 15000);
    return () => clearInterval(t);
  }, [ts]);
  return label;
}

// ── Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard({ onRequestNotifications, notifStatus }) {
  const { glucose, metrics, settings, fetchHealthData, lastSync } = useHealthStore();
  const timeAgo = useTimeAgo(glucose.current?.timestamp);
  const [showNotifBanner, setShowNotifBanner] = useState(false);

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      setTimeout(() => setShowNotifBanner(true), 3000);
    }
  }, []);

  const cur = glucose.current;
  const col = gColor(cur?.value);
  const trend = TREND[cur?.trend] || TREND[3];
  const mmol = cur?.value ? (cur.value / 18.0182).toFixed(1) : '—';
  const tir = useMemo(() => calcTIR(glucose.history), [glucose.history]);

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
            <span className="brand-logo">su94r</span>
          </div>
          {settings.userName && (
            <div className="brand-user">{settings.userName}</div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="sync-status">
            {lastSync ? `synced ${new Date(lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'not synced'}
          </div>
          {glucose.error && (
            <div className="sync-error">⚠ {glucose.error}</div>
          )}
        </div>
      </div>

      {/* Notification prompt */}
      {showNotifBanner && (
        <div className="info-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span>🔔 Enable alerts for critical glucose notifications</span>
          <button className="btn-notif-enable" onClick={() => { onRequestNotifications(); setShowNotifBanner(false); }}>Enable</button>
          <button className="btn-dismiss" onClick={() => setShowNotifBanner(false)}>✕</button>
        </div>
      )}

      {/* No CGM configured */}
      {!hasGlucoseConfig && (
        <div className="warning-card">
          <strong>No CGM configured.</strong> Go to Settings → CGM to connect Libre, Dexcom, or Nightscout.
        </div>
      )}

      {/* Main glucose card */}
      <div className={`card glucose-card ${col.cls}`}>
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
            <div className="glucose-trend" style={{ color: col.c, transform: `rotate(${trend.rot}deg)` }}>→</div>
            <div className="glucose-trend-label">{trend.label}</div>
          </div>
          <div className={`glucose-badge glucose-badge-${col.cls}`}>
            {col.e} {col.lbl}
          </div>
          <div className="glucose-time">
            {timeAgo ? `${timeAgo} · ` : ''}{cur?.source || 'No data'}
          </div>
        </div>

        {/* Chart */}
        <div>
          <div className="chart-meta">
            <span className="chart-meta-label">3-HOUR TREND</span>
            <span className="chart-meta-label" style={{ color: 'var(--amber)' }}>— 70 / 180</span>
          </div>
          <GlucoseChart readings={glucose.history?.slice(-36)} />
        </div>
      </div>

      {/* TIR + Stats */}
      {tir && (
        <div className="card">
          <div className="card-title">Time in Range · {tir.readings} readings</div>
          <TIRBar tir={tir} />
          <StatsCard tir={tir} />
        </div>
      )}

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
          <div className="empty-state">
            <span className="empty-icon">📉</span>
            <span>No readings yet. Configure your CGM in Settings.</span>
          </div>
        )}
      </div>

      {/* Other metrics grid */}
      <div className="card-title" style={{ marginTop: 4, marginBottom: 10 }}>Health Metrics</div>
      <div className="metrics-grid">
        <MetricTile icon="❤️" name="HEART RATE" value={latestHR?.bpm || null} unit="bpm" color="var(--red)" time={latestHR ? new Date(latestHR.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null} />
        <MetricTile icon="💤" name="SLEEP" value={latestSleep ? `${Math.round(latestSleep.duration / 3600)}h ${Math.round((latestSleep.duration % 3600) / 60)}m` : null} unit={latestSleep ? `${latestSleep.efficiency || '—'}% eff` : ''} color="var(--purple)" time={latestSleep?.date} />
        <MetricTile icon="🫀" name="BLOOD PRESSURE" value={latestBP ? `${latestBP.systolic}/${latestBP.diastolic}` : null} unit="mmHg" color="var(--amber)" time={latestBP ? new Date(latestBP.timestamp).toLocaleDateString() : null} />
        <MetricTile icon="⚖️" name="WEIGHT" value={latestWeight?.value || null} unit={settings.weightUnit || 'lbs'} color="var(--cyan)" time={latestWeight?.date} />
        <MetricTile icon="👟" name="STEPS" value={latestSteps?.count?.toLocaleString() || null} unit="steps" color="var(--green)" time={latestSteps?.date} />
        <MetricTile icon="🫁" name="SpO2" value={latestSpO2?.value || null} unit="%" color={latestSpO2?.value < 94 ? 'var(--red)' : 'var(--cyan)'} time={latestSpO2 ? new Date(latestSpO2.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null} />
      </div>

      {/* Refresh button */}
      <button className="btn-refresh" onClick={fetchHealthData} disabled={glucose.loading}>
        {glucose.loading ? '⟳ Syncing…' : '⟳ Refresh Now'}
      </button>
    </div>
  );
}
