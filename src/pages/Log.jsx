import React, { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useHealthStore } from '../store/healthStore';
import { insulinsByCategory, insulinWarnings, findInsulin } from '../lib/insulin/catalog';
import { buildDoseEntry, DOSE_CONTEXT, DOSE_CONTEXT_LABEL } from '../lib/insulin/meds';
import { insulinOnBoard, IOB_DISCLAIMER } from '../lib/insulin/iob';
import { treatmentReview } from '../lib/insulin/treatment';
import {
  shouldCheckKetones, assessKetones, sickDayState, KETONE_DISCLAIMER,
} from '../lib/cgm/ketones';
import { sensorStatus, SENSOR_SPECS, SENSOR_STATE } from '../lib/cgm/sensor';

const TABS = [
  { id: 'insulin', label: 'Insulin' },
  { id: 'ketones', label: 'Ketones' },
  { id: 'treat', label: 'Lows' },
  { id: 'sensor', label: 'Sensor' },
];

function Section({ title, children }) {
  return (
    <>
      <div className="device-section-title">{title}</div>
      {children}
    </>
  );
}

/** Insulin entry. Warnings about concentration appear before saving, not after. */
function InsulinForm({ onSaved }) {
  const { logEntry } = useHealthStore();
  const [units, setUnits] = useState('');
  const [type, setType] = useState('novorapid');
  const [context, setContext] = useState(DOSE_CONTEXT.MEAL);
  const [carbs, setCarbs] = useState('');
  const [busy, setBusy] = useState(false);

  const insulin = findInsulin(type);
  const concentration = insulin?.concentrations?.[0] || 'U-100';
  const warnings = insulinWarnings(type, concentration);

  const submit = e => {
    e.preventDefault();
    setBusy(true);
    try {
      const entry = buildDoseEntry({
        units, insulinType: type, concentration, context,
        carbsGrams: context === DOSE_CONTEXT.MEAL ? carbs : null,
      });
      logEntry('doses', entry);
      setUnits('');
      setCarbs('');
      toast.success(`${entry.units}u logged`);
      onSaved?.();
    } catch (err) {
      // buildDoseEntry throws on typos and implausible amounts. Surface the
      // real reason — "invalid input" teaches nothing.
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="log-form" onSubmit={submit}>
      <div className="log-row">
        <label className="log-field">
          <span>Units</span>
          <input
            className="settings-input" type="number" step="0.5" min="0" inputMode="decimal"
            value={units} onChange={e => setUnits(e.target.value)} placeholder="0" required
          />
        </label>
        <label className="log-field">
          <span>Context</span>
          <select className="settings-input" value={context} onChange={e => setContext(e.target.value)}>
            {Object.entries(DOSE_CONTEXT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>

      <label className="log-field">
        <span>Insulin</span>
        <select className="settings-input" value={type} onChange={e => setType(e.target.value)}>
          {insulinsByCategory().map(g => (
            <optgroup key={g.category} label={g.label}>
              {g.items.map(i => (
                <option key={i.id} value={i.id}>
                  {i.brand} · {i.concentrations.join('/')}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {context === DOSE_CONTEXT.MEAL && (
        <label className="log-field">
          <span>Carbs (g) — optional, enables outcome tracking</span>
          <input
            className="settings-input" type="number" min="0" inputMode="numeric"
            value={carbs} onChange={e => setCarbs(e.target.value)} placeholder="e.g. 45"
          />
        </label>
      )}

      {warnings.map((w, i) => (
        <div key={i} className="fit-gate fit-gate-caution"><div className="fit-gate-detail">{w}</div></div>
      ))}

      <button className="fit-btn fit-btn-lg" type="submit" disabled={busy}>Log dose</button>
    </form>
  );
}

function KetoneForm() {
  const { logEntry, glucose } = useHealthStore();
  const [mmol, setMmol] = useState('');
  const [source, setSource] = useState('blood');
  const [result, setResult] = useState(null);

  const submit = e => {
    e.preventDefault();
    const v = Number(mmol);
    if (!Number.isFinite(v) || v < 0) return toast.error('Enter a ketone reading in mmol/L.');

    const glucoseMgdl = glucose?.current?.value ?? null;
    const assessment = assessKetones({ ketonesMmol: v, glucoseMgdl });
    logEntry('ketones', {
      id: `kt_${Date.now()}`, mmol: v, source,
      timestamp: new Date().toISOString(), glucoseMgdl,
    });
    setResult(assessment);
    setMmol('');
    if (assessment?.emergency) toast.error(assessment.title);
    else toast.success('Ketones logged');
  };

  return (
    <>
      <form className="log-form" onSubmit={submit}>
        <div className="log-row">
          <label className="log-field">
            <span>Ketones (mmol/L)</span>
            <input
              className="settings-input" type="number" step="0.1" min="0" inputMode="decimal"
              value={mmol} onChange={e => setMmol(e.target.value)} placeholder="0.0" required
            />
          </label>
          <label className="log-field">
            <span>Measured by</span>
            <select className="settings-input" value={source} onChange={e => setSource(e.target.value)}>
              <option value="blood">Blood meter</option>
              <option value="urine">Urine strip</option>
            </select>
          </label>
        </div>
        {source === 'urine' && (
          <div className="fit-gate fit-gate-caution">
            <div className="fit-gate-detail">
              Urine strips lag blood by hours and can read positive after ketones have
              already cleared. Use a blood meter if you have one.
            </div>
          </div>
        )}
        <button className="fit-btn fit-btn-lg" type="submit">Log ketones</button>
      </form>

      {result && (
        <div className={`fit-gate ${result.emergency ? 'fit-gate-block' : result.tone === 'caution' ? 'fit-gate-caution' : 'fit-gate-clear'}`}>
          <div className="fit-gate-title">{result.title}</div>
          <div className="fit-gate-detail">{result.detail}</div>
          {result.actions.length > 0 && (
            <ul className="fit-gate-actions">{result.actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
          )}
        </div>
      )}
    </>
  );
}

function TreatmentForm() {
  const { logEntry, metrics, glucose, settings } = useHealthStore();
  const [grams, setGrams] = useState('15');
  const [what, setWhat] = useState('');

  const review = useMemo(
    () => treatmentReview(metrics.treatments || [], glucose.history || [], {
      unit: settings.glucoseUnit || 'mgdl',
    }),
    [metrics.treatments, glucose.history, settings.glucoseUnit]
  );

  const submit = e => {
    e.preventDefault();
    const g = Number(grams);
    if (!Number.isFinite(g) || g <= 0) return toast.error('Enter the carbs you took.');
    logEntry('treatments', {
      id: `tr_${Date.now()}`, carbsGrams: g, what, takenAt: new Date().toISOString(),
    });
    setWhat('');
    toast.success('Treatment logged');
  };

  return (
    <>
      <div className="info-card">
        Logging what you take to treat a low lets su94r measure how far carbohydrate
        actually moves <em>you</em>, rather than the textbook 15g→50 figure.
      </div>

      <form className="log-form" onSubmit={submit}>
        <div className="log-row">
          <label className="log-field">
            <span>Carbs (g)</span>
            <input
              className="settings-input" type="number" min="1" inputMode="numeric"
              value={grams} onChange={e => setGrams(e.target.value)} required
            />
          </label>
          <label className="log-field">
            <span>What (optional)</span>
            <input
              className="settings-input" value={what} onChange={e => setWhat(e.target.value)}
              placeholder="juice, tabs…"
            />
          </label>
        </div>
        <button className="fit-btn fit-btn-lg" type="submit">Log treatment</button>
      </form>

      <div className={`fit-insight ${review.enough ? 'info' : 'info'}`}>{review.text}</div>
      {review.notes?.map((n, i) => (
        <div key={i} className={`fit-insight ${n.tone === 'warn' ? 'warn' : 'info'}`}>{n.text}</div>
      ))}
    </>
  );
}

function SensorPanel() {
  const { metrics, startSensor } = useHealthStore();
  const [type, setType] = useState('libre3');

  const active = (metrics.sensors || []).find(s => !s.endedAt) || null;
  const status = sensorStatus(active);

  const tone =
    status.state === SENSOR_STATE.EXPIRED ? 'fit-gate-block'
    : status.state === SENSOR_STATE.ENDING || status.state === SENSOR_STATE.WARMUP ? 'fit-gate-caution'
    : status.state === SENSOR_STATE.ACTIVE ? 'fit-gate-clear'
    : 'fit-gate-unknown';

  return (
    <>
      <div className={`fit-gate ${tone}`}>
        <div className="fit-gate-title">{status.label}</div>
        {status.detail && <div className="fit-gate-detail">{status.detail}</div>}
        {status.hoursWorn != null && (
          <div className="fit-gate-detail">
            {status.spec?.label} · worn {status.daysWorn}d {Math.round(status.hoursWorn % 24)}h
          </div>
        )}
      </div>

      <div className="log-row">
        <label className="log-field">
          <span>Sensor</span>
          <select className="settings-input" value={type} onChange={e => setType(e.target.value)}>
            {Object.entries(SENSOR_SPECS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
      </div>
      <button
        className="fit-btn fit-btn-lg"
        onClick={() => { startSensor(type); toast.success('Sensor started'); }}
      >
        Start new sensor
      </button>
      <div className="info-card">
        Warm-up readings are often well off. su94r shows them but leaves them out of
        time in range, GMI and the exercise analysis.
      </div>
    </>
  );
}

export default function Log() {
  const { metrics, glucose, settings, setSickDay } = useHealthStore();
  const [tab, setTab] = useState('insulin');

  const openSick = (metrics.sickEpisodes || []).find(e => !e.endedAt) || null;
  const sick = sickDayState({ enabled: !!openSick, startedAt: openSick?.startedAt });

  const iob = useMemo(
    () => insulinOnBoard(metrics.doses || []),
    [metrics.doses]
  );

  const ketonePrompt = useMemo(
    () => shouldCheckKetones({
      history: glucose.history || [],
      unit: settings.glucoseUnit || 'mgdl',
      sickDay: sick.active,
      lastKetoneAt: metrics.ketones?.[0]?.timestamp || null,
    }),
    [glucose.history, settings.glucoseUnit, sick.active, metrics.ketones]
  );

  return (
    <div className="page fade-up">
      <div className="page-header">
        <div>
          <h1>Log</h1>
          <div className="page-subtitle">Insulin · ketones · lows</div>
        </div>
      </div>

      {/* Active insulin is the number that stops people stacking, so it leads. */}
      <div className="log-iob">
        <div>
          <div className="log-iob-value">{iob.units.toFixed(1)}<span>u</span></div>
          <div className="log-iob-label">insulin on board</div>
        </div>
        {iob.contributions.length > 0 && (
          <div className="log-iob-detail">
            {iob.contributions.slice(0, 3).map((c, i) => (
              <div key={i}>{c.remaining}u left of {c.units}u · {c.minutesAgo}m ago</div>
            ))}
          </div>
        )}
      </div>

      {ketonePrompt.check && (
        <div className="fit-gate fit-gate-caution">
          <div className="fit-gate-title">Test for ketones</div>
          <div className="fit-gate-detail">{ketonePrompt.reason}</div>
          <ul className="fit-gate-actions"><li>{ketonePrompt.guidance}</li></ul>
          <button className="fit-btn" onClick={() => setTab('ketones')}>Log a reading</button>
        </div>
      )}

      {sick.active && (
        <div className="fit-gate fit-gate-caution">
          <div className="fit-gate-title">Sick day — hour {sick.hours}</div>
          <ul className="fit-gate-actions">{sick.guidance.map((g, i) => <li key={i}>{g}</li>)}</ul>
          <div className="fit-gate-detail">{sick.escalate}</div>
          <button className="fit-btn-ghost" onClick={() => { setSickDay(false); toast('Sick day ended'); }}>
            I'm feeling better
          </button>
        </div>
      )}

      <div className="fit-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`fit-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'insulin' && (
        <>
          <InsulinForm />
          <div className="info-card">{IOB_DISCLAIMER}</div>
          <Section title="Recent doses">
            {(metrics.doses || []).slice(0, 8).map(d => (
              <div key={d.id} className="fit-row">
                <span>{new Date(d.takenAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <span>{d.units}u</span>
                <span>{findInsulin(d.insulinType)?.brand || d.insulinType}</span>
                <span>{DOSE_CONTEXT_LABEL[d.context] || d.context}</span>
              </div>
            ))}
            {!(metrics.doses || []).length && <div className="info-card">Nothing logged yet.</div>}
          </Section>
        </>
      )}

      {tab === 'ketones' && (
        <>
          <KetoneForm />
          <div className="info-card">{KETONE_DISCLAIMER}</div>
        </>
      )}

      {tab === 'treat' && <TreatmentForm />}
      {tab === 'sensor' && <SensorPanel />}

      {!sick.active && (
        <button
          className="fit-btn-ghost log-sick-toggle"
          onClick={() => { setSickDay(true); toast('Sick day on — training prompts paused'); }}
        >
          I'm unwell — turn on sick-day mode
        </button>
      )}

      <div style={{ height: 16 }} />
    </div>
  );
}
