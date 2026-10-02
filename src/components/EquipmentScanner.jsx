import React, { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useHealthStore } from '../store/healthStore';
import { detectEquipment, fileToBase64, inventorySummary } from '../lib/fitness/equipment.js';

/**
 * Photograph your gear, get a plan built around it.
 *
 * Photos are sent to Gemini for identification; su94r keeps no copy — not in
 * the app, not in Supabase. Only the resulting list of equipment names is kept.
 * Google's terms decide what Gemini keeps (the free tier may retain and review).
 */
export default function EquipmentScanner({ catalog }) {
  const { settings, updateSettings } = useHealthStore();
  const fitness = settings.fitness || {};
  const owned = fitness.ownedEquipment || [];

  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState(null);

  const summary = catalog ? inventorySummary(owned, catalog) : null;

  const handleFiles = async (event) => {
    const files = [...(event.target.files || [])].slice(0, 6);
    if (!files.length) return;

    const tooBig = files.find(f => f.size > 8 * 1024 * 1024);
    if (tooBig) {
      toast.error(`${tooBig.name} is over 8MB. Take a smaller photo.`);
      return;
    }

    setBusy(true);
    try {
      const images = await Promise.all(files.map(fileToBase64));
      const result = await detectEquipment(images, settings.geminiKey);

      if (!result.equipment.length) {
        toast('No equipment spotted. Your plan will stay bodyweight-only.');
      } else {
        toast.success(`Found ${result.equipment.length} item${result.equipment.length === 1 ? '' : 's'}`);
      }

      setItems(result.items);
      updateSettings({
        fitness: {
          ...fitness,
          ownedEquipment: result.equipment,
          equipmentScannedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
      // Allow re-picking the same file after a failure.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = (name) => {
    updateSettings({
      fitness: { ...fitness, ownedEquipment: owned.filter(e => e !== name) },
    });
    setItems(prev => prev?.filter(i => i.equipment !== name) ?? null);
  };

  const clearAll = () => {
    updateSettings({ fitness: { ...fitness, ownedEquipment: [], equipmentScannedAt: null } });
    setItems(null);
    toast('Inventory cleared — back to bodyweight defaults.');
  };

  return (
    <div className="device-card">
      <div className="device-top">
        <div className="device-name">📷 Scan your equipment</div>
        {owned.length > 0 && <span className="device-badge badge-connected">{owned.length} ITEMS</span>}
      </div>

      <div className="device-note">
        Photograph the corner you train in — a few angles is enough. su94r identifies what you
        own and builds the plan around it. su94r keeps no copy of the photos; they go to
        Google Gemini for identification, and on the free tier Google may keep and review them.
      </div>

      {!settings.geminiKey && (
        <div className="fit-gate fit-gate-caution">
          <div className="fit-gate-title">Gemini key needed</div>
          <div className="fit-gate-detail">
            Add a free Gemini API key under Settings → AI Models. Identification runs on the free tier.
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        style={{ display: 'none' }}
        onChange={handleFiles}
      />

      <div className="fit-card-actions">
        <button
          className="fit-btn"
          disabled={busy || !settings.geminiKey}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Identifying…' : owned.length ? 'Re-scan' : 'Take photos'}
        </button>
        {owned.length > 0 && (
          <button className="fit-btn-ghost" onClick={clearAll}>Clear</button>
        )}
      </div>

      {owned.length > 0 && (
        <>
          <div className="device-tags">
            {owned.map(name => {
              const detected = items?.find(i => i.equipment === name);
              return (
                <span key={name} className="device-tag" title={detected?.detail || ''}>
                  {name}
                  {detected?.detail ? ` · ${detected.detail}` : ''}
                  <button
                    className="fit-tag-remove"
                    onClick={() => remove(name)}
                    aria-label={`Remove ${name}`}
                  >
                    ✕
                  </button>
                </span>
              );
            })}
          </div>
          {summary && <div className="fit-result-count">{summary.note}</div>}
          {fitness.equipmentScannedAt && (
            <div className="device-howto">
              ▶ Scanned {new Date(fitness.equipmentScannedAt).toLocaleDateString()} · your weekly plan now uses only this kit
            </div>
          )}
        </>
      )}
    </div>
  );
}
