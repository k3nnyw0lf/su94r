import React, { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useHealthStore } from '../store/healthStore';
import {
  snapshot, compare, progressNarrative, avatarState, renderAvatarSvg, PROGRESS_NOTE,
} from '../lib/progress/progress';
import {
  addPhoto, listPhotos, deletePhoto, comparisonPair, ghostOverlay, albumSize,
  POSE, POSE_GUIDE, CAPTURE_RULES, ALBUM_PRIVACY_NOTE, ALBUM_HONESTY_NOTE,
} from '../lib/progress/photoAlbum';

const DAY = 86_400_000;

/** Object URLs must be revoked or the page leaks memory as photos are browsed. */
function useObjectUrl(blob) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

function PhotoFrame({ photo, caption }) {
  const url = useObjectUrl(photo?.blob);
  if (!photo) return null;
  return (
    <figure className="prog-frame">
      {url && <img src={url} alt="" loading="lazy" />}
      <figcaption>
        <strong>{new Date(photo.takenAt).toLocaleDateString()}</strong>
        {caption && <span> · {caption}</span>}
      </figcaption>
    </figure>
  );
}

function Album() {
  const { metrics } = useHealthStore();
  const [pose, setPose] = useState(POSE.SIDE);
  const [photos, setPhotos] = useState([]);
  const [pair, setPair] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [size, setSize] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = async p => {
    setPhotos(await listPhotos(p));
    setPair(await comparisonPair(p));
    setGhost(await ghostOverlay(p));
    setSize(await albumSize());
  };

  useEffect(() => { refresh(pose).catch(() => {}); }, [pose]);

  const onPick = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      // Snapshot the numbers alongside the photo — a photo shown without them
      // invites reading whatever you already believe into it.
      await addPhoto(file, {
        pose,
        metrics: {
          weightKg: metrics.weight?.[0]?.value ?? null,
          bodyFatPct: metrics.bodyFat?.[0]?.value ?? null,
        },
      });
      await refresh(pose);
      toast.success('Saved on this device');
    } catch (err) {
      toast.error(err.message || 'Could not save the photo');
    } finally {
      setBusy(false);
    }
  };

  const ghostUrl = useObjectUrl(ghost?.photo?.blob);

  return (
    <>
      <div className="fit-tabs">
        {Object.values(POSE).map(p => (
          <button key={p} className={`fit-tab ${pose === p ? 'active' : ''}`} onClick={() => setPose(p)}>
            {POSE_GUIDE[p].label}
          </button>
        ))}
      </div>

      <div className="info-card">
        <strong>{POSE_GUIDE[pose].instruction}</strong>
        <br />{POSE_GUIDE[pose].shows}
      </div>

      {ghostUrl && (
        <div className="prog-ghost">
          <img src={ghostUrl} alt="" style={{ opacity: ghost.opacity }} />
          <span>{ghost.hint}</span>
        </div>
      )}

      <label className={`fit-btn fit-btn-lg prog-upload ${busy ? 'is-busy' : ''}`}>
        {busy ? 'Saving…' : 'Add photo'}
        <input type="file" accept="image/*" onChange={onPick} hidden disabled={busy} />
      </label>

      {pair?.ready ? (
        <>
          <div className="device-section-title">Then and now</div>
          <div className="prog-compare">
            <PhotoFrame photo={pair.first} caption="first" />
            <PhotoFrame photo={pair.latest} caption="latest" />
          </div>
          <div className={`fit-insight ${pair.meaningful ? 'info' : 'warn'}`}>{pair.note}</div>
        </>
      ) : (
        <div className="info-card">{pair?.note || 'Add a photo to start.'}</div>
      )}

      {photos.length > 0 && (
        <>
          <div className="device-section-title">All {POSE_GUIDE[pose].label.toLowerCase()} photos ({photos.length})</div>
          <div className="prog-grid">
            {photos.map(p => (
              <div key={p.id} className="prog-thumb">
                <PhotoFrame photo={p} />
                <button
                  className="fit-btn-ghost"
                  onClick={async () => { await deletePhoto(p.id); await refresh(pose); toast('Deleted'); }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="info-card">{ALBUM_PRIVACY_NOTE}</div>
      <div className="info-card">{ALBUM_HONESTY_NOTE}</div>
      {size?.count > 0 && (
        <div className="page-subtitle">{size.count} photos · {size.mb} MB on this device</div>
      )}

      <div className="prog-capture-rules">
        <div className="device-section-title">For comparable photos</div>
        <ul>{CAPTURE_RULES.map((r, i) => <li key={i}>{r}</li>)}</ul>
      </div>
    </>
  );
}

export default function Progress() {
  const { metrics, settings } = useHealthStore();
  const [view, setView] = useState('summary');
  const [windowDays, setWindowDays] = useState(60);

  // health_samples arrive from the Worker; the local store keeps the same shape
  // so both paths feed one snapshot function.
  const samples = useMemo(() => {
    const out = [];
    for (const [collection, type] of [['weight', 'bodyMass'], ['bodyFat', 'bodyFatPercentage']]) {
      for (const e of metrics[collection] || []) {
        out.push({ type, value: e.value, recorded_at: e.timestamp || e.date });
      }
    }
    return out;
  }, [metrics.weight, metrics.bodyFat]);

  const now = Date.now();
  const current = useMemo(
    () => snapshot({ samples, workouts: metrics.workouts || [], postureScans: metrics.postureScans || [], at: now }),
    [samples, metrics.workouts, metrics.postureScans, now]
  );
  const earlier = useMemo(
    () => snapshot({ samples, workouts: metrics.workouts || [], postureScans: metrics.postureScans || [], at: now - windowDays * DAY }),
    [samples, metrics.workouts, metrics.postureScans, now, windowDays]
  );

  const diff = useMemo(() => compare(current, earlier), [current, earlier]);
  const lines = useMemo(
    () => progressNarrative(diff, { weightUnit: settings.weightUnit || 'kg' }),
    [diff, settings.weightUnit]
  );

  const avatarNow = avatarState(current);
  const avatarThen = avatarState(earlier);

  return (
    <div className="page fade-up">
      <div className="page-header">
        <div>
          <h1>Progress</h1>
          <div className="page-subtitle">Last {windowDays} days</div>
        </div>
      </div>

      <div className="fit-tabs">
        <button className={`fit-tab ${view === 'summary' ? 'active' : ''}`} onClick={() => setView('summary')}>Summary</button>
        <button className={`fit-tab ${view === 'photos' ? 'active' : ''}`} onClick={() => setView('photos')}>Photos</button>
      </div>

      {view === 'summary' && (
        <>
          {avatarNow.hasData ? (
            <div className="prog-avatars">
              <div>
                <div dangerouslySetInnerHTML={{ __html: renderAvatarSvg(avatarThen, { accent: '#64748b' }) }} />
                <span>{windowDays} days ago</span>
              </div>
              <div>
                <div dangerouslySetInnerHTML={{ __html: renderAvatarSvg(avatarNow) }} />
                <span>now</span>
              </div>
            </div>
          ) : (
            <div className="info-card">
              Run a posture scan or sync your scale and the figure will start reflecting
              your own measurements.
            </div>
          )}

          {/* Ordered by how early each metric responds, not how much attention
              it usually gets. Strength first, scale weight last. */}
          {lines.map((l, i) => (
            <div key={i} className={`fit-insight ${l.tone === 'watch' ? 'warn' : 'info'}`}>{l.text}</div>
          ))}

          <div className="fit-tabs">
            {[30, 60, 90].map(d => (
              <button key={d} className={`fit-tab ${windowDays === d ? 'active' : ''}`} onClick={() => setWindowDays(d)}>
                {d} days
              </button>
            ))}
          </div>

          <div className="info-card">{PROGRESS_NOTE}</div>
        </>
      )}

      {view === 'photos' && <Album />}

      <div style={{ height: 16 }} />
    </div>
  );
}
