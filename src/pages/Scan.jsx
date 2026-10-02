import React, { useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useHealthStore } from '../store/healthStore';
import {
  estimateMealCarbs, fileToBase64, confidenceLabel, MEAL_DISCLAIMER,
} from '../lib/nutrition/mealScan';
import {
  assessPosture, correctiveWork, POSTURE_DISCLAIMER, FAT_LOSS_NOTE, T1D_WEIGHT_LOSS_NOTE,
} from '../lib/fitness/postureScan';
import { loadCatalog } from '../lib/fitness/catalog';

const MODES = [
  { id: 'meal', label: 'Meal' },
  { id: 'posture', label: 'Posture' },
];

/**
 * Camera input. `capture="environment"` opens the rear camera directly on
 * mobile; on desktop the same control falls back to a file picker, so one
 * component covers both without branching.
 */
function PhotoPicker({ onPick, busy, multiple = false, label = 'Take photo' }) {
  const ref = useRef(null);
  return (
    <>
      <label className={`fit-btn fit-btn-lg prog-upload ${busy ? 'is-busy' : ''}`}>
        {busy ? 'Reading…' : label}
        <input
          ref={ref}
          type="file"
          accept="image/*"
          capture="environment"
          multiple={multiple}
          hidden
          disabled={busy}
          onChange={e => {
            const files = [...(e.target.files || [])];
            e.target.value = '';
            if (files.length) onPick(files);
          }}
        />
      </label>
      <button
        className="fit-btn-ghost scan-alt"
        disabled={busy}
        onClick={() => {
          // Same input without `capture` so an existing photo can be chosen.
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.multiple = multiple;
          input.onchange = () => { const f = [...(input.files || [])]; if (f.length) onPick(f); };
          input.click();
        }}
      >
        Choose an existing photo
      </button>
    </>
  );
}

function MealScan() {
  const { settings, logEntry, metrics } = useHealthStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [edited, setEdited] = useState(null);

  const key = settings.geminiKey;

  const run = async files => {
    if (!key) return toast.error('Add a Gemini API key in Settings — it is free.');
    setBusy(true);
    try {
      const images = await Promise.all(files.slice(0, 3).map(fileToBase64));
      const r = await estimateMealCarbs(images, key);
      setResult(r);
      setEdited(r.total);
      if (!r.items.length) toast.error('Nothing identifiable in that photo. Try again closer.');
    } catch (err) {
      toast.error(err.message || 'Could not read the photo');
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const total = Number(edited);
    if (!Number.isFinite(total) || total < 0) return toast.error('Enter a carb total.');
    logEntry('meals', {
      id: `m_${Date.now()}`,
      at: new Date().toISOString(),
      total,
      low: result.low,
      high: result.high,
      confidence: result.confidence,
      items: result.items.map(i => ({ name: i.name, carbsGrams: i.carbsGrams })),
      // Flag when the saved figure is the user's, not the model's — it matters
      // when reading back why an outcome looked odd.
      corrected: total !== result.total,
    });
    toast.success(`${total}g logged`);
    setResult(null);
  };

  const conf = result ? confidenceLabel(result.confidence) : null;

  return (
    <>
      <div className="info-card">{MEAL_DISCLAIMER}</div>
      {!key && (
        <div className="fit-gate fit-gate-caution">
          <div className="fit-gate-title">Gemini key needed</div>
          <div className="fit-gate-detail">Settings → Fitness &amp; Wearable APIs. It is free.</div>
        </div>
      )}

      <PhotoPicker onPick={run} busy={busy} multiple label="Photograph the meal" />

      {result && (
        <>
          <div className={`fit-gate ${conf.tone === 'ok' ? 'fit-gate-clear' : conf.tone === 'caution' ? 'fit-gate-caution' : 'fit-gate-block'}`}>
            <div className="fit-gate-title">
              {result.total}g carbohydrate
              <span className="scan-range"> ({result.low}–{result.high}g)</span>
            </div>
            <div className="fit-gate-detail">{conf.label}. {result.caveat}</div>
            {result.glycemicNote && <div className="fit-gate-detail">{result.glycemicNote}</div>}
          </div>

          {/* Portion basis is shown per item so the ASSUMPTION can be corrected,
              which is where nearly all the error lives. */}
          {result.items.map((i, n) => (
            <div key={n} className="scan-item">
              <div className="scan-item-head">
                <strong>{i.name}</strong>
                <span>{i.carbsGrams}g <em>({i.carbsLow}–{i.carbsHigh})</em></span>
              </div>
              <div className="scan-item-basis">{i.portionBasis}</div>
            </div>
          ))}

          <label className="log-field">
            <span>Correct the total if you know better</span>
            <input
              className="settings-input" type="number" min="0" inputMode="numeric"
              value={edited} onChange={e => setEdited(e.target.value)}
            />
          </label>

          <button className="fit-btn fit-btn-lg" onClick={save}>Log this meal</button>
          <button className="fit-btn-ghost scan-alt" onClick={() => setResult(null)}>Discard</button>
        </>
      )}

      {(metrics.meals || []).length > 0 && (
        <>
          <div className="device-section-title">Recent meals</div>
          {(metrics.meals || []).slice(0, 6).map(m => (
            <div key={m.id} className="fit-row">
              <span>{new Date(m.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span>{m.total}g</span>
              <span>{m.items?.map(i => i.name).slice(0, 2).join(', ')}</span>
              {m.corrected && <span className="fit-flag">edited</span>}
            </div>
          ))}
        </>
      )}
    </>
  );
}

function PostureScan() {
  const { settings, logEntry, metrics } = useHealthStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [catalog, setCatalog] = useState([]);

  const key = settings.geminiKey;

  const run = async files => {
    if (!key) return toast.error('Add a Gemini API key in Settings — it is free.');
    setBusy(true);
    try {
      const images = await Promise.all(files.slice(0, 3).map(fileToBase64));
      const [r, cat] = await Promise.all([assessPosture(images, key), loadCatalog()]);
      setCatalog(cat);
      setResult(r);
      // Only the FINDINGS are stored. The photographs are never persisted —
      // see postureScan.js. The album is a separate, opt-in feature.
      logEntry('postureScans', {
        id: `ps_${Date.now()}`,
        assessedAt: new Date().toISOString(),
        findings: r.findings.map(f => ({ key: f.key, severity: f.severity, confidence: f.confidence })),
      });
      toast.success(r.clear ? 'No clear markers found' : `${r.findings.length} marker(s) found`);
    } catch (err) {
      toast.error(err.message || 'Could not assess the photo');
    } finally {
      setBusy(false);
    }
  };

  const work = useMemo(
    () => (result ? correctiveWork(result.findings, catalog) : []),
    [result, catalog]
  );

  return (
    <>
      <div className="info-card">{POSTURE_DISCLAIMER}</div>
      <div className="fit-gate fit-gate-caution">
        <div className="fit-gate-detail">{FAT_LOSS_NOTE}</div>
      </div>

      <div className="info-card">
        <strong>One side-on photo is the most informative.</strong> Stand relaxed, look
        straight ahead rather than at the camera, arms hanging naturally. Add a front-on
        shot to pick up side-to-side imbalance. Fitted clothing — loose clothing hides
        alignment and the assessment will say so rather than guess.
      </div>

      <PhotoPicker onPick={run} busy={busy} multiple label="Photograph your posture" />

      {result && (
        <>
          {result.photoQuality && <div className="fit-insight info">{result.photoQuality}</div>}
          {result.clear && (
            <div className="fit-gate fit-gate-clear">
              <div className="fit-gate-title">No clear markers</div>
              <div className="fit-gate-detail">
                Nothing stood out at a confidence worth acting on. {result.caveat}
              </div>
            </div>
          )}

          {work.map(f => (
            <div key={f.key} className="scan-finding">
              <div className="scan-item-head">
                <strong>{f.label}</strong>
                <span className="admin-pill unset">{f.severity}</span>
              </div>
              <div className="scan-item-basis">{f.cause}</div>
              <div className="scan-item-basis"><em>{f.observation}</em></div>
              <div className="scan-note">{f.note}</div>

              {f.stretch.length > 0 && (
                <div className="scan-work">
                  <span>Lengthen</span>
                  <ul>{f.stretch.map(e => <li key={e.id || e.name}>{e.name}</li>)}</ul>
                </div>
              )}
              {f.strengthen.length > 0 && (
                <div className="scan-work">
                  <span>Strengthen</span>
                  <ul>{f.strengthen.map(e => <li key={e.id || e.name}>{e.name}</li>)}</ul>
                </div>
              )}
            </div>
          ))}

          {result.caveat && <div className="fit-insight warn">{result.caveat}</div>}
        </>
      )}

      <div className="info-card">{T1D_WEIGHT_LOSS_NOTE}</div>

      {(metrics.postureScans || []).length > 1 && (
        <>
          <div className="device-section-title">Previous scans</div>
          {(metrics.postureScans || []).slice(0, 6).map(s => (
            <div key={s.id} className="fit-row">
              <span>{new Date(s.assessedAt).toLocaleDateString()}</span>
              <span>{s.findings.length ? `${s.findings.length} marker(s)` : 'clear'}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

export default function Scan() {
  const [mode, setMode] = useState('meal');

  return (
    <div className="page fade-up">
      <div className="page-header">
        <div>
          <h1>Scan</h1>
          <div className="page-subtitle">Meals · posture</div>
        </div>
      </div>

      <div className="fit-tabs">
        {MODES.map(m => (
          <button key={m.id} className={`fit-tab ${mode === m.id ? 'active' : ''}`} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'meal' ? <MealScan /> : <PostureScan />}

      <div style={{ height: 16 }} />
    </div>
  );
}
