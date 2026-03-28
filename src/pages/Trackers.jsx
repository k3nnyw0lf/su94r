import React, { useState } from 'react';
import { useHealthStore } from '../store/healthStore';
import toast from 'react-hot-toast';

const TRACKERS = [
  { id: 'glucose',       icon: '🩸', name: 'Glucose',        unit: 'mg/dL',  field: 'value',     type: 'number', placeholder: '120', color: 'var(--green)' },
  { id: 'heartRate',     icon: '❤️', name: 'Heart Rate',     unit: 'bpm',    field: 'bpm',       type: 'number', placeholder: '72',  color: 'var(--red)' },
  { id: 'sleep',         icon: '💤', name: 'Sleep',          unit: 'hours',  field: 'duration',  type: 'number', placeholder: '7.5', color: 'var(--purple)' },
  { id: 'bloodPressure', icon: '🫀', name: 'Blood Pressure', unit: 'mmHg',   field: 'systolic',  type: 'text',   placeholder: '120/80', color: 'var(--amber)' },
  { id: 'weight',        icon: '⚖️', name: 'Weight',         unit: 'lbs',    field: 'value',     type: 'number', placeholder: '175', color: 'var(--cyan)' },
  { id: 'steps',         icon: '👟', name: 'Steps',          unit: 'steps',  field: 'count',     type: 'number', placeholder: '8000', color: 'var(--green)' },
  { id: 'spo2',          icon: '🫁', name: 'SpO2',           unit: '%',      field: 'value',     type: 'number', placeholder: '98',  color: 'var(--cyan)' },
  { id: 'ketones',       icon: '🔥', name: 'Ketones',        unit: 'mmol/L', field: 'value',     type: 'number', placeholder: '0.3', color: 'var(--amber)' },
  { id: 'temperature',   icon: '🌡️', name: 'Temperature',   unit: '°F',     field: 'value',     type: 'number', placeholder: '98.6', color: 'var(--red)' },
  { id: 'medications',   icon: '💊', name: 'Medication',     unit: '',       field: 'name',      type: 'text',   placeholder: 'Humalog 4u', color: 'var(--purple)' },
  { id: 'nutrition',     icon: '🍽️', name: 'Meal / Carbs',  unit: 'g carbs', field: 'carbs',    type: 'number', placeholder: '45',  color: 'var(--amber)' },
  { id: 'mood',          icon: '🧠', name: 'Mood',           unit: '/10',    field: 'score',     type: 'number', placeholder: '7',   color: 'var(--cyan)' },
];

function TrackerDetail({ tracker, history, onAdd }) {
  const [val, setVal] = useState('');
  const [note, setNote] = useState('');

  const handleAdd = () => {
    if (!val) return;
    let entry = { timestamp: new Date().toISOString(), note };
    if (tracker.id === 'bloodPressure') {
      const [sys, dia] = val.split('/').map(Number);
      entry = { ...entry, systolic: sys || 120, diastolic: dia || 80 };
    } else if (tracker.id === 'sleep') {
      entry = { ...entry, duration: parseFloat(val) * 3600, date: new Date().toISOString().split('T')[0] };
    } else if (tracker.id === 'steps') {
      entry = { ...entry, count: parseInt(val), date: new Date().toISOString().split('T')[0] };
    } else if (tracker.id === 'weight') {
      entry = { ...entry, value: parseFloat(val), date: new Date().toISOString().split('T')[0] };
    } else if (tracker.id === 'medications') {
      entry = { ...entry, name: val, taken: true };
    } else if (tracker.id === 'nutrition') {
      entry = { ...entry, carbs: parseFloat(val), date: new Date().toISOString().split('T')[0] };
    } else {
      entry = { ...entry, value: parseFloat(val) || val };
    }
    onAdd(tracker.id, entry);
    setVal('');
    setNote('');
    toast.success(`${tracker.name} logged!`);
  };

  const formatVal = (entry) => {
    if (tracker.id === 'bloodPressure') return `${entry.systolic}/${entry.diastolic}`;
    if (tracker.id === 'sleep') return `${(entry.duration / 3600).toFixed(1)}h`;
    if (tracker.id === 'steps') return entry.count?.toLocaleString();
    if (tracker.id === 'medications') return entry.name;
    if (tracker.id === 'nutrition') return `${entry.carbs}g`;
    return entry.value ?? entry.score ?? '—';
  };

  const ketoneSeverity = (v) => {
    if (v < 0.6) return { color: 'var(--green)', label: 'Normal' };
    if (v < 1.5) return { color: 'var(--amber)', label: 'Monitor' };
    if (v < 3.0) return { color: 'var(--red)', label: 'Danger — Call Doctor' };
    return { color: 'var(--red)', label: '🚨 Call 911 — DKA Risk' };
  };

  return (
    <div>
      {/* Ketone alert guide */}
      {tracker.id === 'ketones' && (
        <div className="info-card" style={{ marginBottom: 12 }}>
          <strong>Ketone Guide:</strong><br />
          {'<'}0.6 Normal · 0.6–1.5 Monitor · 1.5–3.0 Call doctor · {'>'}3.0 🚨 Call 911
        </div>
      )}

      {/* Manual entry form */}
      <div className="manual-entry">
        <div className="card-title">{tracker.icon} Log {tracker.name}</div>
        <div className="entry-row">
          <div className="entry-field">
            <label className="entry-label">{tracker.name.toUpperCase()} ({tracker.unit})</label>
            <input
              className="entry-input"
              type={tracker.type}
              value={val}
              onChange={e => setVal(e.target.value)}
              placeholder={tracker.placeholder}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              style={{ color: tracker.color }}
            />
          </div>
          <div className="entry-field" style={{ maxWidth: 120 }}>
            <label className="entry-label">NOTE</label>
            <input className="entry-input" value={note} onChange={e => setNote(e.target.value)} placeholder="optional" />
          </div>
          <button className="entry-btn" onClick={handleAdd} style={{ background: tracker.color, flexShrink: 0, alignSelf: 'flex-end' }}>
            + Log
          </button>
        </div>

        {/* Ketone severity */}
        {tracker.id === 'ketones' && val && !isNaN(val) && (
          <div style={{ marginTop: 10, fontSize: 13, color: ketoneSeverity(parseFloat(val)).color, fontFamily: 'var(--mono)' }}>
            ► {ketoneSeverity(parseFloat(val)).label}
          </div>
        )}
      </div>

      {/* History */}
      <div className="card">
        <div className="card-title">History</div>
        {history && history.length > 0 ? (
          history.slice(0, 20).map((entry, i) => (
            <div key={i} className="history-row" style={{ opacity: Math.max(0.25, 1 - i * 0.05) }}>
              <span className="history-val" style={{ color: tracker.color }}>{formatVal(entry)} <span style={{ fontSize: 11, color: 'var(--muted)' }}>{tracker.unit}</span></span>
              <span className="history-note">{entry.note || ''}</span>
              <span className="history-time">{entry.timestamp ? new Date(entry.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : entry.date || ''}</span>
            </div>
          ))
        ) : (
          <div style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: '16px 0', fontFamily: 'var(--mono)' }}>
            No entries yet. Log your first reading above.
          </div>
        )}
      </div>
    </div>
  );
}

export default function Trackers() {
  const [active, setActive] = useState(TRACKERS[0]);
  const { metrics, addMetric } = useHealthStore();

  return (
    <div className="page fade-up">
      <div className="page-header">
        <h1>Health Trackers</h1>
        <div className="page-subtitle">12 METRICS</div>
      </div>

      {/* Tracker selector tabs */}
      <div className="tracker-tabs">
        {TRACKERS.map(t => (
          <button
            key={t.id}
            className={`tracker-tab ${active.id === t.id ? 'active' : ''}`}
            onClick={() => setActive(t)}
            style={active.id === t.id ? { background: t.color, borderColor: t.color } : {}}
          >
            {t.icon} {t.name}
          </button>
        ))}
      </div>

      <TrackerDetail
        tracker={active}
        history={metrics[active.id] || []}
        onAdd={addMetric}
      />
    </div>
  );
}
