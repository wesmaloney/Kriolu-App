// Netlify function: hearing Kriolu.
//
// The browser's built-in recognizer only knows Portuguese, so Kriolu comes back as Portuguese-sounding
// words cut in the wrong places. ElevenLabs Scribe is trained on Kabuverdianu (language code "kea"), so
// the page records a short clip of the learner's voice and sends it here; this function passes it to
// Scribe and returns the text. The ElevenLabs key never reaches a browser, and the endpoint only accepts
// short audio clips from this site, so it cannot be turned into a general transcription service.
//
// Netlify → Site settings → Environment variables:
//   ELEVENLABS_API_KEY   (the key used for Sôr António's voice; scope: Functions). If the key is restricted in
//                        ElevenLabs, its permissions must include Speech to Text as well as Text to Speech.
//   STT_MODEL            (optional) Scribe model, default scribe_v2
//   ALLOWED_ORIGINS      (optional) extra sites allowed to call this, comma separated
//
// Recordings are forwarded and not stored by this app.

const env = (k) => (typeof Netlify !== 'undefined' ? Netlify.env.get(k) : process.env[k]);

const LIMITS = {
  maxBytes: 1.5 * 1024 * 1024,   // about 40 seconds of speech as webm/opus; the page stops recording long before that
  minBytes: 800,                 // below this there is no speech to hear
  hourlyPerIp: 240,              // a second, per-instance cap on top of the platform rate limit
};
const LANGUAGE = 'kea';          // Kabuverdianu
const hits = new Map();
function overHourlyCap(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k);
  return recent.length > LIMITS.hourlyPerIp;
}

const json = (status, body, extra) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(extra || {}) },
  });
const fail = (status, message, extra) => json(status, { error: message }, extra);

// Only the site that serves this function may call it (plus ALLOWED_ORIGINS)
function originAllowed(req) {
  let origin = req.headers.get('origin');
  if (!origin || origin === 'null') {
    try { origin = req.headers.get('referer') ? new URL(req.headers.get('referer')).origin : ''; } catch (e) { origin = ''; }
  }
  if (!origin) return false;
  try { if (new URL(origin).host === new URL(req.url).host) return true; } catch (e) { return false; }
  const own = [env('URL'), env('DEPLOY_URL'), env('DEPLOY_PRIME_URL')].filter(Boolean).map((x) => x.replace(/\/$/, ''));
  const extra = (env('ALLOWED_ORIGINS') || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
  return own.includes(origin) || extra.includes(origin);
}

// The audio types a browser's recorder produces, and a file name Scribe can recognise them by
function audioKind(contentType) {
  const t = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (t === 'audio/webm') return { type: contentType, name: 'clip.webm' };
  if (t === 'audio/mp4' || t === 'audio/aac' || t === 'audio/x-m4a') return { type: contentType, name: 'clip.m4a' };
  if (t === 'audio/ogg') return { type: contentType, name: 'clip.ogg' };
  if (t === 'audio/wav' || t === 'audio/x-wav') return { type: contentType, name: 'clip.wav' };
  return null;
}

export default async (req, context) => {
  const apiKey = env('ELEVENLABS_API_KEY');
  if (!originAllowed(req)) return fail(403, 'Not allowed from this site');

  // The page asks once whether the app can understand Kriolu speech itself
  if (req.method === 'GET') return json(200, { configured: !!apiKey });
  if (req.method !== 'POST') return fail(405, 'Method not allowed', { Allow: 'GET, POST' });
  if (!apiKey) return fail(503, 'Kriolu listening is not set up on this site');

  const kind = audioKind(req.headers.get('content-type'));
  if (!kind) return fail(415, 'Send a short audio clip');

  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (overHourlyCap(ip)) return fail(429, 'Too many recordings, please slow down', { 'Retry-After': '120' });

  const declared = Number(req.headers.get('content-length'));
  if (declared > LIMITS.maxBytes) return fail(413, 'That recording is too long');
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > LIMITS.maxBytes) return fail(413, 'That recording is too long');
  if (bytes.byteLength < LIMITS.minBytes) return json(200, { text: '', words: [] });   // nothing recorded

  const form = new FormData();
  form.append('model_id', env('STT_MODEL') || 'scribe_v2');
  form.append('language_code', LANGUAGE);
  form.append('tag_audio_events', 'false');
  form.append('file', new Blob([bytes], { type: kind.type }), kind.name);

  try {
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      // Detail goes to the function log, never to the browser
      console.error('Scribe request failed', r.status, String(await r.text().catch(() => '')).slice(0, 300));
      // The key is missing, or lacks the Speech to Text permission: that will not fix itself, so say "not set up"
      // and the page stops trying until the next visit
      if (r.status === 401 || r.status === 403) return fail(503, 'Kriolu listening is not set up on this site');
      if (r.status === 429) return fail(429, 'Listening is busy, please try again in a moment', { 'Retry-After': '10' });
      return fail(502, 'Listening is not available right now');
    }
    const data = await r.json();
    const text = String(data.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    // Only what the page uses: the text, and how sure the recognizer was about each word
    const words = (Array.isArray(data.words) ? data.words : [])
      .filter((w) => w && w.type === 'word')
      .slice(0, 80)
      .map((w) => ({ text: String(w.text || '').slice(0, 40), logprob: Number.isFinite(w.logprob) ? Math.round(w.logprob * 100) / 100 : 0 }));
    return json(200, { text, words });
  } catch (e) {
    console.error('Scribe request error', String((e && e.message) || e).slice(0, 300));
    return fail(502, 'Listening is not available right now');
  }
};

export const config = {
  path: '/api/stt',
  // The platform limits each visitor before the function runs
  rateLimit: { action: 'rate_limit', aggregateBy: ['ip', 'domain'], windowSize: 60, windowLimit: 30 },
};
