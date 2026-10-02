// ═══════════════════════════════════════════════════════════════════════════
// Progress photo album.
//
// STORAGE: ON THIS DEVICE ONLY. NEVER UPLOADED.
//
// Body photos are the most sensitive thing this app will ever hold. They live
// in IndexedDB on the device that took them and are never sent to Supabase, to
// Cloudflare, or to any model. The only way one leaves is if the user exports
// it themselves, deliberately.
//
// This is a different promise from postureScan.js, and the difference is
// intentional: a posture scan SENDS a photo to a vision model for one
// assessment and keeps nothing. The album KEEPS photos and sends nothing. Both
// promises hold; neither is weakened by the other.
//
// EXIF IS STRIPPED, AND THAT MATTERS
//
// Phone photos embed GPS coordinates, device serials and timestamps. A progress
// album quietly accumulating the exact location of someone's bedroom is a
// privacy failure waiting to happen. Every image is re-encoded through a canvas
// before storage, which drops all metadata as a side effect of redrawing pixels.
//
// WHY CAPTURE CONSISTENCY IS THE WHOLE FEATURE
//
// Two photos taken at different distances, angles or lighting are not
// comparable, and comparing them produces a confident answer that is wrong in
// both directions — people see progress that is a camera angle, or miss real
// progress hidden by one. The ghost overlay exists so each new photo can be
// aligned to the previous one before it is taken.
// ═══════════════════════════════════════════════════════════════════════════

import { openDB } from 'idb';

const DB_NAME = 'su94r-progress';
const STORE = 'photos';
const DB_VERSION = 1;

export const POSE = {
  FRONT: 'front',
  SIDE: 'side',
  BACK: 'back',
};

/**
 * Same three poses every time. Relaxed, not flexed — a flexed photo compared
 * against a relaxed one manufactures progress that is not there, and the point
 * of this is to be able to trust it.
 */
export const POSE_GUIDE = {
  front: {
    label: 'Front',
    instruction: 'Face the camera square on. Arms relaxed at your sides, not flexed. Feet shoulder-width.',
    shows: 'Shoulder level, side-to-side balance, overall width.',
  },
  side: {
    label: 'Side',
    instruction: 'Turn 90°, look straight ahead — not at the camera. Arms hanging naturally.',
    shows: 'The most informative view: posture, forward head, pelvic tilt.',
  },
  back: {
    label: 'Back',
    instruction: 'Face away, arms relaxed. Same distance as the others.',
    shows: 'Upper-back development, hip level.',
  },
};

export const CAPTURE_RULES = [
  'Same time of day — body water shifts noticeably between morning and night.',
  'Same lighting and same spot. Shadows change shape more than bodies do.',
  'Same distance. Mark the floor if you can; a step closer looks like a change.',
  'Fitted clothing or none, but be consistent between shots.',
  'Relaxed, never flexed. Consistency beats a flattering photo.',
];

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          const store = d.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('takenAt', 'takenAt');
          store.createIndex('pose', 'pose');
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Re-encodes an image through a canvas, which strips every EXIF field including
 * GPS, and downscales to keep the album from consuming the device's storage.
 *
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
export function normaliseImage(file, { maxEdge = 1400, quality = 0.85 } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Could not process the image'));
      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob(
        blob => (blob ? resolve({ blob, width: w, height: h }) : reject(new Error('Could not encode the image'))),
        'image/jpeg',
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the image'));
    };
    img.src = url;
  });
}

/**
 * Stores a photo locally. `metrics` is a snapshot of measured values at the
 * time, so a photo is never shown without the numbers that accompanied it —
 * a photo alone invites reading whatever you already believe into it.
 */
export async function addPhoto(file, { pose = POSE.SIDE, takenAt = Date.now(), metrics = null } = {}) {
  if (!Object.values(POSE).includes(pose)) throw new Error(`Unknown pose: ${pose}`);
  const { blob, width, height } = await normaliseImage(file);

  const entry = {
    id: `p_${takenAt}_${pose}`,
    pose,
    takenAt: new Date(takenAt).toISOString(),
    blob,
    width,
    height,
    metrics,
  };

  await (await db()).put(STORE, entry);
  return { ...entry, blob: undefined };
}

export async function listPhotos(pose = null) {
  const all = await (await db()).getAll(STORE);
  return all
    .filter(p => !pose || p.pose === pose)
    .sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt));
}

export async function getPhoto(id) {
  return (await db()).get(STORE, id);
}

export async function deletePhoto(id) {
  return (await db()).delete(STORE, id);
}

/** Deletes everything. Offered plainly — it is the user's body. */
export async function clearAlbum() {
  return (await db()).clear(STORE);
}

/**
 * The earliest and latest photo of a pose, which is the comparison that means
 * something. Consecutive weeks look identical and reading them as "no progress"
 * is how people quit at week three.
 */
export async function comparisonPair(pose = POSE.SIDE) {
  const photos = (await listPhotos(pose)).sort((a, b) => new Date(a.takenAt) - new Date(b.takenAt));
  if (photos.length < 2) {
    return { ready: false, count: photos.length, note: 'Two photos of the same pose are needed to compare.' };
  }

  const first = photos[0];
  const latest = photos[photos.length - 1];
  const days = Math.round((new Date(latest.takenAt) - new Date(first.takenAt)) / 86_400_000);

  return {
    ready: true,
    first,
    latest,
    days,
    count: photos.length,
    // Under a month, honest expectation-setting beats false encouragement.
    meaningful: days >= 28,
    note: days >= 28
      ? `${days} days between these.`
      : `Only ${days} days apart — visible change usually takes six to eight weeks. The numbers move sooner.`,
  };
}

/**
 * The previous photo of a pose, to show as a faint overlay while framing the
 * next one. This is what makes the series comparable.
 */
export async function ghostOverlay(pose = POSE.SIDE) {
  const photos = await listPhotos(pose);
  if (!photos.length) return null;
  return { photo: photos[0], opacity: 0.35, hint: 'Line yourself up with the outline before taking the shot.' };
}

/** Rough album size, so storage pressure is visible rather than surprising. */
export async function albumSize() {
  const all = await (await db()).getAll(STORE);
  const bytes = all.reduce((n, p) => n + (p.blob?.size || 0), 0);
  return { count: all.length, bytes, mb: Math.round((bytes / 1048576) * 10) / 10 };
}

export const ALBUM_PRIVACY_NOTE =
  'Progress photos are stored only on this device and are never uploaded — not ' +
  'to su94r, not to any model. Location and camera metadata are stripped before ' +
  'saving. Clearing your browser data deletes them, so export any you want to ' +
  'keep. You can delete the whole album at any time.';

export const ALBUM_HONESTY_NOTE =
  'Compare the earliest photo with the newest, never last week with this week — ' +
  'consecutive weeks look identical even when things are working, and reading ' +
  'that as failure is how people stop at week three. Visible change usually ' +
  'takes six to eight weeks. Strength and body composition move long before it.';
