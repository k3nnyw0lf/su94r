import React, { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useHealthStore } from '../store/healthStore';
import ExerciseLibrary from '../components/ExerciseLibrary.jsx';
import EquipmentScanner from '../components/EquipmentScanner.jsx';
import { loadCatalog } from '../lib/fitness/catalog.js';
import { movementSnacks, weeklyPlan, planSummary } from '../lib/fitness/program.js';
import {
  preWorkoutCheck, intraWorkoutCheck, postWorkoutWatch,
  checkIntervalMinutes, VERDICT, DISCLAIMER,
} from '../lib/fitness/safety.js';
import { analyzeAll, summarizeByModality, insights } from '../lib/fitness/correlate.js';

const VIEWS = [
  { id: 'today', label: 'Today' },
  { id: 'plan', label: 'Week' },
  { id: 'gear', label: 'Gear' },
  { id: 'library', label: 'Library' },
  { id: 'insights', label: 'Insights' },
];

const VERDICT_CLASS = {
  [VERDICT.CLEAR]: 'fit-gate-clear',
  [VERDICT.CAUTION]: 'fit-gate-caution',
  [VERDICT.BLOCK]: 'fit-gate-block',
  [VERDICT.UNKNOWN]: 'fit-gate-unknown',
};

/** Pre-workout glucose gate. This is the component that can say "no". */
function GateCard({ check, unit }) {
  return (
    <div className={`fit-gate ${VERDICT_CLASS[check.verdict]}`}>
      <div className="fit-gate-title">{check.title}</div>
      <div className="fit-gate-detail">{check.detail}</div>
      <ul className="fit-gate-actions">
        {check.actions.map((a, i) => <li key={i}>{a}</li>)}
      </ul>
    </div>
  );
}

function ActiveSession({ session, glucose, unit, gates, onFinish, onCancel }) {
  const { logSet, logWorkoutGlucose } = useHealthStore();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = new Date(session.startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - started) / 60000));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [session.startedAt]);

  const interval = checkIntervalMinutes(session.modality, session.safety?.verdict);
  const checksDone = session.glucoseChecks.length;
  const checkDue = elapsed >= interval * (checksDone + 1);

  const intra = glucose.current ? intraWorkoutCheck(glucose.current, { gates, unit }) : null;

  return (
    <div className="fit-active">
      <div className="fit-active-head">
        <div>
          <div className="fit-active-title">{session.title}</div>
          <div className="fit-active-time">{elapsed} min elapsed</div>
        </div>
        <div className="fit-active-glucose">
          {glucose.current ? `${glucose.current.value} ${unit === 'mmol' ? 'mmol/L' : 'mg/dL'}` : '— no reading'}
        </div>
      </div>

      {intra && <GateCard check={intra} unit={unit} />}

      {checkDue && !intra && (
        <div className="fit-gate fit-gate-caution">
          <div className="fit-gate-title">Time for a glucose check</div>
          <div className="fit-gate-detail">{interval} minutes since the last one.</div>
          <button
            className="fit-btn"
            onClick={() => {
              if (!glucose.current) return toast.error('No reading available');
              logWorkoutGlucose(glucose.current);
              toast.success('Check logged');
            }}
          >
            Log current reading
          </button>
        </div>
      )}

      {session.blocks.map((b, i) => (
        <div key={i} className="fit-block">
          <div className="fit-block-head">
            <span className="fit-block-slot">{b.slot}</span>
            <span className="fit-block-scheme">{b.sets ? `${b.sets} × ${b.reps}` : b.prescription}</span>
          </div>
          <div className="fit-block-name">{b.exercise?.name || b.prescription}</div>
          <div className="fit-set-row">
            {Array.from({ length: b.sets || 0 }).map((_, si) => {
              const done = (session.completed[i] || []).length > si;
              return (
                <button
                  key={si}
                  className={`fit-set ${done ? 'done' : ''}`}
                  disabled={done}
                  onClick={() => logSet(i, { set: si + 1, at: new Date().toISOString() })}
                >
                  {si + 1}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="fit-active-footer">
        <button className="fit-btn-ghost" onClick={onCancel}>Discard</button>
        <button className="fit-btn" onClick={onFinish}>Finish session</button>
      </div>
    </div>
  );
}

export default function Fitness() {
  const {
    settings, glucose, metrics, activeSession,
    startWorkout, finishWorkout, cancelWorkout,
  } = useHealthStore();

  const [view, setView] = useState('today');
  const [index, setIndex] = useState(null);
  const [watch, setWatch] = useState(null);

  const unit = settings.glucoseUnit || 'mgdl';
  const gates = settings.exerciseGates;
  const fit = settings.fitness || {};

  useEffect(() => {
    let alive = true;
    loadCatalog().then(d => { if (alive) setIndex(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const plan = useMemo(
    () => (index ? weeklyPlan(index, {
      equipmentClass: fit.equipmentClass,
      ownedEquipment: fit.ownedEquipment,
      resistanceDays: fit.resistanceDays,
    }) : []),
    [index, fit.equipmentClass, fit.ownedEquipment, fit.resistanceDays]
  );

  const today = useMemo(() => {
    const key = new Date().toISOString().slice(0, 10);
    return plan.find(d => d.date === key) || plan[0] || null;
  }, [plan]);

  const snacks = useMemo(
    () => (index && fit.snacksEnabled ? movementSnacks(index, { workStart: fit.workStart, workEnd: fit.workEnd }) : []),
    [index, fit.snacksEnabled, fit.workStart, fit.workEnd]
  );

  const gate = useMemo(
    () => preWorkoutCheck(glucose.current, today?.modality || 'resistance', { gates, unit }),
    [glucose.current, today?.modality, gates, unit]
  );

  const analysis = useMemo(() => {
    const rows = analyzeAll(metrics.workouts || [], glucose.history || [], {
      unit,
      lowThreshold: settings.thresholds?.low ?? 70,
    });
    return { rows, summaries: summarizeByModality(rows) };
  }, [metrics.workouts, glucose.history, unit, settings.thresholds]);

  const handleStart = () => {
    if (!today || today.kind === 'rest') return;
    if (gate.verdict === VERDICT.BLOCK) {
      toast.error('Glucose gate is blocking this session.');
      return;
    }
    startWorkout({
      modality: today.modality,
      title: today.title,
      blocks: today.blocks,
      glucosePre: glucose.current,
      safety: gate,
    });
    toast.success('Session started');
  };

  const handleFinish = () => {
    const done = finishWorkout(glucose.current);
    if (done) {
      setWatch(postWorkoutWatch(done));
      toast.success('Session logged');
    }
  };

  return (
    <div className="page fade-up">
      <div className="page-header">
        <div>
          <h1>Fitness</h1>
          <div className="page-subtitle">Desk job · Type 1</div>
        </div>
      </div>

      <div className="info-card">{DISCLAIMER}</div>

      {activeSession ? (
        <ActiveSession
          session={activeSession}
          glucose={glucose}
          unit={unit}
          gates={gates}
          onFinish={handleFinish}
          onCancel={() => { cancelWorkout(); toast('Session discarded'); }}
        />
      ) : (
        <>
          {watch && (
            <div className="fit-gate fit-gate-caution">
              <div className="fit-gate-title">
                {watch.overnightRisk ? 'Overnight low risk' : 'Post-session watch window'}
              </div>
              <div className="fit-gate-detail">{watch.note}</div>
              <ul className="fit-gate-actions">
                {watch.checkpoints.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
              <button className="fit-btn-ghost" onClick={() => setWatch(null)}>Dismiss</button>
            </div>
          )}

          <div className="fit-tabs">
            {VIEWS.map(v => (
              <button
                key={v.id}
                className={`fit-tab ${view === v.id ? 'active' : ''}`}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>

          {view === 'today' && (
            <>
              <GateCard check={gate} unit={unit} />

              {today && today.kind !== 'rest' ? (
                <div className="fit-session-card">
                  <div className="fit-session-title">{today.title}</div>
                  <div className="fit-session-meta">~{today.estimatedMin} min · {today.blocks.length} blocks</div>
                  <div className="device-note">{today.glucoseNote}</div>
                  {today.blocks.map((b, i) => (
                    <div key={i} className="fit-block-line">
                      <span className="fit-block-slot">{b.slot}</span>
                      <span>{b.exercise?.name || b.prescription}</span>
                    </div>
                  ))}
                  <button
                    className="fit-btn fit-btn-lg"
                    onClick={handleStart}
                    disabled={gate.verdict === VERDICT.BLOCK}
                  >
                    {gate.verdict === VERDICT.BLOCK ? 'Blocked — resolve glucose first' : 'Start session'}
                  </button>
                </div>
              ) : (
                <div className="info-card">Rest day. A walk still counts.</div>
              )}

              {snacks.length > 0 && (
                <>
                  <div className="device-section-title">Movement snacks</div>
                  {snacks.map((s, i) => (
                    <div key={i} className="fit-snack">
                      <span className="fit-snack-time">{s.label}</span>
                      <div>
                        <div className="fit-snack-name">{s.exercise.name}</div>
                        <div className="fit-snack-why">{s.durationMin} min · {s.why}</div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          {view === 'plan' && index && (
            <>
              {(() => {
                const sum = planSummary(plan);
                return (
                  <div className="info-card">
                    {sum.resistanceDays} strength days · {sum.cardioMinutes} min cardio. {sum.note}
                  </div>
                );
              })()}
              {plan.map(d => (
                <div key={d.date} className={`fit-day ${d.kind === 'rest' ? 'rest' : ''}`}>
                  <span className="fit-day-name">{d.weekday}</span>
                  <div>
                    <div className="fit-day-title">{d.title}</div>
                    {d.estimatedMin > 0 && <div className="fit-day-meta">~{d.estimatedMin} min</div>}
                  </div>
                </div>
              ))}
            </>
          )}

          {view === 'gear' && <EquipmentScanner catalog={index} />}

          {view === 'library' && <ExerciseLibrary />}

          {view === 'insights' && (
            <>
              {analysis.rows.length === 0 ? (
                <div className="info-card">
                  No sessions with glucose coverage yet. Log a few workouts and su94r will start
                  reporting how exercise actually moves your glucose.
                </div>
              ) : (
                <>
                  {insights(analysis.summaries, { unit }).map((ins, i) => (
                    <div key={i} className={`fit-insight ${ins.level}`}>{ins.text}</div>
                  ))}
                  <div className="device-section-title">Sessions</div>
                  {analysis.rows.slice(0, 20).map(r => (
                    <div key={r.sessionId} className="fit-row">
                      <span>{new Date(r.startedAt).toLocaleDateString()}</span>
                      <span>{r.modality}</span>
                      <span>{r.durationMin}m</span>
                      <span className={r.deltaDuring > 0 ? 'up' : 'down'}>
                        {r.deltaDuring == null ? '—' : `${r.deltaDuring > 0 ? '+' : ''}${r.deltaDuring}`}
                      </span>
                      {(r.hypoDuring || r.hypoAfter2h) && <span className="fit-flag">low</span>}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </>
      )}

      <div style={{ height: 16 }} />
    </div>
  );
}
