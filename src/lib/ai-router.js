// ═══════════════════════════════════════════════════════════════════════════
// Open Health Monitor — AI Router
// Routes requests to the best available AI model based on configured keys.
// Free-first: Groq → Gemini → Mistral → HuggingFace → Ollama
// Paid fallback: Claude → GPT-4 → Cohere
// ═══════════════════════════════════════════════════════════════════════════

const ENV = import.meta.env;

// ── Model registry ─────────────────────────────────────────────────────────
export const MODELS = {
  groq: {
    name: 'Groq (Llama 3.1 70B)',
    provider: 'groq',
    model: 'llama-3.1-70b-versatile',
    free: true,
    speed: 'ultra-fast',
    contextWindow: 128000,
    keyEnv: 'VITE_GROQ_API_KEY',
    bestFor: ['glucose', 'meal', 'activity', 'sleep', 'mental', 'trend'],
  },
  groqMixtral: {
    name: 'Groq (Mixtral 8x7B)',
    provider: 'groq',
    model: 'mixtral-8x7b-32768',
    free: true,
    speed: 'ultra-fast',
    contextWindow: 32768,
    keyEnv: 'VITE_GROQ_API_KEY',
    bestFor: ['nutrition', 'medication'],
  },
  geminiFlash: {
    name: 'Gemini 1.5 Flash',
    provider: 'gemini',
    model: 'gemini-1.5-flash',
    free: true,
    speed: 'fast',
    contextWindow: 1000000,
    keyEnv: 'VITE_GEMINI_API_KEY',
    bestFor: ['nutrition', 'research', 'lab'],
  },
  mistral: {
    name: 'Mistral 7B Instruct',
    provider: 'mistral',
    model: 'mistral-small-latest',
    free: true,
    speed: 'fast',
    contextWindow: 32000,
    keyEnv: 'VITE_MISTRAL_API_KEY',
    bestFor: ['general'],
  },
  hf: {
    name: 'HuggingFace (Llama 3)',
    provider: 'huggingface',
    model: 'meta-llama/Llama-3-8b-chat-hf',
    free: true,
    speed: 'slow',
    keyEnv: 'VITE_HF_API_KEY',
    bestFor: ['fallback'],
  },
  ollama: {
    name: 'Ollama (Local)',
    provider: 'ollama',
    model: ENV.VITE_OLLAMA_MODEL || 'llama3',
    free: true,
    speed: 'local',
    keyEnv: null, // no key needed
    bestFor: ['privacy', 'offline'],
  },
  claudeHaiku: {
    name: 'Claude Haiku (Paid)',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    free: false,
    speed: 'fast',
    contextWindow: 200000,
    keyEnv: 'VITE_CLAUDE_API_KEY',
    bestFor: ['emergency', 'lab', 'complex'],
  },
  claudeSonnet: {
    name: 'Claude Sonnet (Paid)',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    free: false,
    speed: 'medium',
    contextWindow: 200000,
    keyEnv: 'VITE_CLAUDE_API_KEY',
    bestFor: ['emergency', 'complex', 'lab'],
  },
  gpt4oMini: {
    name: 'GPT-4o Mini (Paid)',
    provider: 'openai',
    model: 'gpt-4o-mini',
    free: false,
    speed: 'fast',
    contextWindow: 128000,
    keyEnv: 'VITE_OPENAI_API_KEY',
    bestFor: ['general'],
  },
};

// ── Key availability ───────────────────────────────────────────────────────
function hasKey(keyEnv) {
  if (!keyEnv) return true; // No key needed (Ollama)
  return !!(ENV[keyEnv] && ENV[keyEnv].length > 5);
}

function getAvailableModels(bestFor = null) {
  return Object.entries(MODELS)
    .filter(([, m]) => hasKey(m.keyEnv))
    .filter(([, m]) => !bestFor || m.bestFor.includes(bestFor))
    .sort((a, b) => {
      // Prioritize: free + fast > free + slow > paid
      const scoreA = (a[1].free ? 10 : 0) + (a[1].speed === 'ultra-fast' ? 3 : a[1].speed === 'fast' ? 2 : a[1].speed === 'local' ? 1 : 0);
      const scoreB = (b[1].free ? 10 : 0) + (b[1].speed === 'ultra-fast' ? 3 : b[1].speed === 'fast' ? 2 : b[1].speed === 'local' ? 1 : 0);
      return scoreB - scoreA;
    });
}

export function getActiveModel(bestFor = null) {
  const available = getAvailableModels(bestFor);
  return available[0]?.[1] || null;
}

export function listAvailableModels() {
  return getAvailableModels().map(([id, m]) => ({
    id,
    name: m.name,
    free: m.free,
    speed: m.speed,
  }));
}

// ── Provider callers ───────────────────────────────────────────────────────
async function callGroq(model, messages, system) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ENV.VITE_GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: model.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Groq error');
  return data.choices[0].message.content;
}

async function callGemini(model, messages, system) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model.model}:generateContent?key=${ENV.VITE_GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Gemini error');
  return data.candidates[0].content.parts[0].text;
}

async function callMistral(model, messages, system) {
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ENV.VITE_MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: model.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Mistral error');
  return data.choices[0].message.content;
}

async function callHuggingFace(model, messages, system) {
  const prompt = [
    system ? `<|system|>\n${system}<|end|>` : '',
    ...messages.map(m => `<|${m.role}|>\n${m.content}<|end|>`),
    '<|assistant|>\n',
  ].join('\n');

  const res = await fetch(`https://api-inference.huggingface.co/models/${model.model}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ENV.VITE_HF_API_KEY}`,
    },
    body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 512 } }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'HuggingFace error');
  return Array.isArray(data) ? data[0].generated_text?.split('<|assistant|>').pop()?.trim() : data.generated_text;
}

async function callOllama(model, messages, system) {
  const endpoint = ENV.VITE_OLLAMA_ENDPOINT || 'http://localhost:11434';
  const res = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
      stream: false,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ollama error');
  return data.message.content;
}

async function callAnthropic(model, messages, system) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ENV.VITE_CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model.model,
      max_tokens: 1024,
      system,
      messages,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Claude error');
  return data.content[0].text;
}

async function callOpenAI(model, messages, system) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ENV.VITE_OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: model.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI error');
  return data.choices[0].message.content;
}

// ── Router ─────────────────────────────────────────────────────────────────
const CALLERS = {
  groq: callGroq,
  gemini: callGemini,
  mistral: callMistral,
  huggingface: callHuggingFace,
  ollama: callOllama,
  anthropic: callAnthropic,
  openai: callOpenAI,
};

export async function chat({ messages, system, preferFor = null, forceModel = null }) {
  // Determine which models to try
  let modelsToTry;
  if (forceModel && MODELS[forceModel] && hasKey(MODELS[forceModel].keyEnv)) {
    modelsToTry = [[forceModel, MODELS[forceModel]]];
  } else {
    modelsToTry = getAvailableModels(preferFor);
    if (!modelsToTry.length) {
      return {
        text: '⚠️ No AI provider configured. Add a free API key in Settings → AI Models. Groq and Google Gemini are free to start.',
        model: null,
        error: 'no_provider',
      };
    }
  }

  // Try each model in priority order
  for (const [id, model] of modelsToTry) {
    const caller = CALLERS[model.provider];
    if (!caller) continue;
    try {
      const text = await caller(model, messages, system);
      return { text, model: { id, ...model }, error: null };
    } catch (err) {
      console.warn(`[AI Router] ${model.name} failed:`, err.message, '— trying next...');
    }
  }

  return {
    text: 'All AI providers failed. Check your API keys in Settings or try again.',
    model: null,
    error: 'all_failed',
  };
}

// ── Quick summarize (for background insights) ─────────────────────────────
export async function summarizeHealthData(data, type = 'glucose') {
  const prompts = {
    glucose: `Analyze this glucose data and give a 2-sentence insight: ${JSON.stringify(data)}`,
    sleep: `Analyze this sleep data and give a 2-sentence insight: ${JSON.stringify(data)}`,
    activity: `Analyze this activity data and give a 2-sentence insight: ${JSON.stringify(data)}`,
  };
  return chat({
    messages: [{ role: 'user', content: prompts[type] || prompts.glucose }],
    preferFor: type,
  });
}
