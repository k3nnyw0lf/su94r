import React, { useEffect, useMemo, useState } from 'react';
import {
  loadCatalog, loadSteps, filterExercises, facets,
  EQUIPMENT_CLASS_LABEL, MODALITY_LABEL, GLUCOSE_TENDENCY_NOTE,
} from '../lib/fitness/catalog.js';
import { useTranslation } from '../lib/i18n.jsx';

/** Browse and search the 1,324-exercise catalog. */
export default function ExerciseLibrary({ onPick }) {
  const { locale } = useTranslation();
  const [index, setIndex] = useState(null);
  const [steps, setSteps] = useState({});
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [bodyPart, setBodyPart] = useState('');
  const [eqClass, setEqClass] = useState('');
  const [deskOnly, setDeskOnly] = useState(false);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let alive = true;
    loadCatalog()
      .then(data => { if (alive) setIndex(data); })
      .catch(() => { if (alive) setError('Could not load the exercise catalog.'); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    loadSteps(locale).then(s => { if (alive) setSteps(s); }).catch(() => {});
    return () => { alive = false; };
  }, [locale]);

  const f = useMemo(() => (index ? facets(index) : null), [index]);

  const results = useMemo(() => {
    if (!index) return [];
    return filterExercises(index, {
      query,
      bodyParts: bodyPart ? [bodyPart] : undefined,
      equipmentClass: eqClass ? [eqClass] : undefined,
      deskRelevant: deskOnly || undefined,
    }).slice(0, 120);
  }, [index, query, bodyPart, eqClass, deskOnly]);

  if (error) return <div className="info-card">{error}</div>;
  if (!index) return <div className="info-card">Loading exercise catalog…</div>;

  return (
    <div>
      <input
        className="device-search"
        placeholder="Search 1,324 exercises — name, muscle, equipment"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />

      <div className="fit-filters">
        <select value={bodyPart} onChange={e => setBodyPart(e.target.value)}>
          <option value="">All body parts</option>
          {f.bodyParts.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={eqClass} onChange={e => setEqClass(e.target.value)}>
          <option value="">Any equipment</option>
          {f.equipmentClasses.map(c => (
            <option key={c} value={c}>{EQUIPMENT_CLASS_LABEL[c] || c}</option>
          ))}
        </select>
        <button
          className={`fit-chip ${deskOnly ? 'active' : ''}`}
          onClick={() => setDeskOnly(v => !v)}
        >
          Desk-worker focus
        </button>
      </div>

      <div className="fit-result-count">{results.length} shown</div>

      {results.map(ex => (
        <div key={ex.id} className="device-card">
          <div className="device-top">
            <div className="device-name">{ex.name}</div>
            <span className={`device-badge ${ex.equipmentClass === 'none' ? 'badge-best' : 'badge-coming'}`}>
              {EQUIPMENT_CLASS_LABEL[ex.equipmentClass]}
            </span>
          </div>
          <div className="device-sub">
            {ex.target} · {ex.bodyPart} · {MODALITY_LABEL[ex.modality]}
          </div>
          <div className="device-note">{GLUCOSE_TENDENCY_NOTE[ex.glucoseTendency]}</div>

          {open === ex.id && (
            <div className="fit-detail">
              <img className="fit-gif" src={ex.gif} alt={ex.name} loading="lazy" />
              <a className="fit-credit" href="https://gymvisual.com/" target="_blank" rel="noopener noreferrer">© Gym visual — https://gymvisual.com/</a>
              <ol className="fit-steps">
                {(steps[ex.id] || ['Instructions unavailable for this language.']).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}

          <div className="fit-card-actions">
            <button className="fit-btn-ghost" onClick={() => setOpen(open === ex.id ? null : ex.id)}>
              {open === ex.id ? 'Hide' : 'How to'}
            </button>
            {onPick && (
              <button className="fit-btn" onClick={() => onPick(ex)}>Add</button>
            )}
          </div>

          <div className="device-tags">
            {ex.secondary.slice(0, 4).map((m, i) => <span key={i} className="device-tag">{m}</span>)}
          </div>
        </div>
      ))}
    </div>
  );
}
