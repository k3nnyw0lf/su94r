// ═══════════════════════════════════════════════════════════════════════════
// Posture assessment from photos.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not tell you which exercises will burn fat from a particular area,
// because nothing does. Spot reduction is not a real effect: training a muscle
// does not preferentially mobilise the fat sitting on top of it. Fat loss is
// systemic and driven by energy balance. An app that scanned someone's stomach
// and prescribed crunches "for that area" would be selling a falsehood, and it
// would waste the effort of a person who deserves better.
//
// It also does not estimate body fat from a photo. That is guesswork, and the
// user already owns a scale that measures it by bioimpedance — a flawed method,
// but a consistent one, which is what matters for tracking a trend.
//
// WHAT IT ACTUALLY DOES
//
// Assesses POSTURE, which photographs genuinely reveal, is caused directly by
// sitting all day, and is correctable with specific exercise. Forward head,
// rounded shoulders and anterior pelvic tilt are the desk-worker triad, and
// they map cleanly onto what to stretch and what to strengthen.
//
// This is the honest version of "look at me and tell me what to work on".
//
// PRIVACY: body photos are among the most sensitive things a person can upload.
// su94r sends them to the vision model for a single assessment and keeps no
// copy — not in the database, not in localStorage, not in the app's state after
// the result comes back. The model provider's own terms decide what it keeps:
// on Gemini's free tier Google may retain and review what is sent.
// ═══════════════════════════════════════════════════════════════════════════

import { fileToBase64 } from './equipment.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash';

export { fileToBase64 };

/**
 * The desk-worker triad plus two common asymmetries.
 *
 * Each marker names what is SHORT (needs lengthening) and what is LONG AND WEAK
 * (needs strengthening). Stretching an already-overstretched muscle is the
 * classic mistake — rounded shoulders do not improve by stretching the upper
 * back, they improve by stretching the chest and strengthening the upper back.
 */
export const POSTURE_MARKERS = {
  forwardHead: {
    label: 'Forward head',
    cause: 'Looking down at a screen for hours. The head drifts ahead of the shoulders and the neck carries it.',
    tight: ['neck extensors', 'upper trapezius', 'levator scapulae'],
    weak: ['deep neck flexors', 'lower trapezius'],
    stretch: /chin tuck|neck stretch|upper trap stretch|levator/i,
    strengthen: /chin tuck|face pull|\brow\b|y raise|prone cobra/i,
  },
  roundedShoulders: {
    label: 'Rounded shoulders',
    cause: 'Reaching forward to a keyboard all day. The chest shortens and the mid-back lengthens and weakens.',
    tight: ['pectorals', 'anterior deltoid', 'latissimus dorsi'],
    weak: ['rhomboids', 'middle and lower trapezius', 'external rotators'],
    stretch: /chest stretch|doorway|pec stretch|lat stretch/i,
    strengthen: /face pull|reverse fly|\brow\b|rear delt|external rotation|y raise/i,
  },
  anteriorPelvicTilt: {
    label: 'Anterior pelvic tilt',
    cause: 'Hips held in flexion for eight hours. Hip flexors shorten, glutes go quiet, the lower back compensates.',
    tight: ['hip flexors', 'erector spinae', 'rectus femoris'],
    weak: ['glutes', 'hamstrings', 'deep core'],
    stretch: /hip flexor stretch|kneeling.*stretch|quad stretch|psoas/i,
    strengthen: /glute bridge|hip thrust|dead bug|plank|romanian|hip extension/i,
  },
  lateralShift: {
    label: 'Side-to-side imbalance',
    cause: 'Often a carried bag, a crossed leg habit, or an old injury. One side does more work than the other.',
    tight: ['quadratus lumborum on the high side'],
    weak: ['gluteus medius on the low side'],
    stretch: /side bend|side stretch|\bqL\b/i,
    strengthen: /side plank|clam|abduction|single leg|suitcase carry/i,
  },
  thoracicStiffness: {
    label: 'Stiff upper back',
    cause: 'A spine held in one shape for hours stops moving in the shapes it is not held in.',
    tight: ['thoracic extensors'],
    weak: ['thoracic rotators'],
    stretch: /thoracic|cat cow|foam roll|extension over/i,
    strengthen: /rotation|woodchop|bird dog/i,
  },
};

const PROMPT = `You are assessing standing posture from photographs, for someone who sits at a desk all day.

Assess ONLY posture and alignment. Do not comment on body fat, weight, attractiveness, or muscle size. Do not estimate body composition.

For each of these markers, judge whether it is present:
- forwardHead: ear sits forward of the shoulder in side view
- roundedShoulders: shoulders roll forward, palms face backward in front view
- anteriorPelvicTilt: pelvis tips forward, exaggerated lower-back curve in side view
- lateralShift: one shoulder or hip visibly higher than the other in front/back view
- thoracicStiffness: flattened or excessively rounded upper back in side view

Return for each:
- present: boolean
- severity: "mild" | "moderate" | "marked"
- observation: one factual sentence describing what you see. Neutral and clinical.
- confidence: 0-1

Also return:
- photoQuality: one sentence on whether the photos allow a reliable judgement (angle, clothing, distance, lighting)
- caveat: the single biggest limitation of this assessment

Rules:
- If a view needed for a marker is missing, set present false and confidence 0, and say so in the observation.
- Loose clothing hides alignment. Say so rather than guessing.
- Never comment on the person's body beyond skeletal alignment.
- Be conservative. A false positive sends someone doing corrective work they do not need.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    markers: {
      type: 'object',
      properties: Object.fromEntries(
        Object.keys(POSTURE_MARKERS).map(k => [
          k,
          {
            type: 'object',
            properties: {
              present: { type: 'boolean' },
              severity: { type: 'string' },
              observation: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['present', 'observation', 'confidence'],
          },
        ])
      ),
    },
    photoQuality: { type: 'string' },
    caveat: { type: 'string' },
  },
  required: ['markers', 'caveat'],
};

/**
 * Assesses posture from one or more photos.
 * A side-on photo is the most informative; front-on adds the asymmetry markers.
 */
export async function assessPosture(images, apiKey) {
  if (!apiKey) throw new Error('Add a Gemini API key in Settings first — it is free.');
  if (!images?.length) throw new Error('No photos provided');

  const parts = [
    { text: PROMPT },
    ...images.map(img => ({ inline_data: { mime_type: img.mimeType, data: img.data } })),
  ];

  const res = await fetch(`${ENDPOINT}/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini rejected the request (${res.status})`);
  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No result returned. Try a clearer side-on photo.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Could not read the response. Try again.');
  }
  return summarisePosture(parsed);
}

/** Folds the model output into findings. Pure, so the logic is testable. */
export function summarisePosture(parsed, { minConfidence = 0.5 } = {}) {
  const findings = Object.entries(POSTURE_MARKERS)
    .map(([key, def]) => {
      const m = parsed?.markers?.[key];
      if (!m?.present) return null;
      const confidence = Math.min(Math.max(Number(m.confidence) || 0, 0), 1);
      // A false positive sends someone doing corrective work they do not need.
      if (confidence < minConfidence) return null;
      return {
        key,
        label: def.label,
        cause: def.cause,
        severity: m.severity || 'mild',
        observation: m.observation || '',
        confidence,
        tight: def.tight,
        weak: def.weak,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);

  return {
    findings,
    photoQuality: parsed?.photoQuality || '',
    caveat: parsed?.caveat || 'A photo assessment is not a clinical examination.',
    clear: findings.length === 0,
  };
}

/**
 * Turns findings into concrete work from the exercise catalog.
 *
 * Stretch what is short, strengthen what is long and weak. Doing the reverse —
 * stretching an already-overstretched upper back because it "feels tight" — is
 * the most common way people make rounded shoulders worse.
 */
export function correctiveWork(findings, catalog = []) {
  return findings.map(f => {
    const def = POSTURE_MARKERS[f.key];
    const match = re => catalog.filter(ex => re.test(ex.name)).slice(0, 4);
    return {
      ...f,
      stretch: match(def.stretch),
      strengthen: match(def.strengthen),
      note: `Lengthen: ${def.tight.join(', ')}. Strengthen: ${def.weak.join(', ')}.`,
    };
  });
}

export const POSTURE_DISCLAIMER =
  'A posture screen from photographs, not a clinical assessment. It cannot see ' +
  'pain, joint structure or old injuries — if anything hurts, that is a ' +
  'physiotherapist question, not an app one. su94r keeps no copy of your photos. ' +
  'They are sent to Google Gemini for this one assessment, and on the free tier ' +
  'Google may keep and review what is sent.';

/**
 * Shown wherever someone asks the app to look at their body. Stated once,
 * plainly, because the alternative is letting them work hard at something that
 * cannot succeed.
 */
export const FAT_LOSS_NOTE =
  'No exercise removes fat from a specific area — spot reduction is not a real ' +
  'effect, and any plan claiming otherwise will waste your effort. Fat loss is ' +
  'whole-body and driven mostly by energy balance; resistance training matters ' +
  'because it protects muscle while that happens, so more of what you lose is ' +
  'fat. Your scale tracks body fat far more usefully than any photo can.';

/**
 * T1D-specific and easy to miss: losing weight lowers insulin requirements,
 * sometimes noticeably, and a dose that was right last month can cause lows.
 */
export const T1D_WEIGHT_LOSS_NOTE =
  'Losing weight generally lowers insulin needs, and doses that were correct ' +
  'before can start causing lows. Tell your care team you are working on this ' +
  'so they can watch your ratios with you — su94r will show the pattern, but ' +
  'the adjustment is theirs to make.';
