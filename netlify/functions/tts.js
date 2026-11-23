// Netlify serverless function: ElevenLabs Text-to-Speech proxy
// Keeps your API key secret on the server and avoids browser CORS blocks.
//
// Set these in Netlify → Site settings → Environment variables:
//   ELEVENLABS_API_KEY  = your ElevenLabs key
//   ELEVENLABS_VOICE_ID = (optional) a backup voice ID, tried if Sôr António's voice
//                         (Mateus, below) is refused
//   ELEVENLABS_MODEL    = (optional) override the speech model
//   ALLOWED_ORIGINS     = (optional) extra sites allowed to call this function,
//                         comma separated, e.g. https://my-other-site.example
//
// Every call spends ElevenLabs credits, so this endpoint is not open to the world:
// it answers only the site that serves it (and any ALLOWED_ORIGINS), and it limits
// how often one visitor can call it.

let goodVoice = null;

const MAX_BODY = 4096;                 // bytes of request body
const RATE_LIMIT = 90;                 // requests per visitor per minute (per warm instance)
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
  return recent.length > RATE_LIMIT;
}

// The page that called us: its Origin, or the origin of its Referer
function callerOrigin(h) {
  if (h.origin && h.origin !== 'null') return h.origin;
  try { return h.referer ? new URL(h.referer).origin : ''; } catch (e) { return ''; }
}
function originAllowed(origin, h) {
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host; } catch (e) { return false; }
  // Same site: the page and this function are served from the same host
  if ([h.host, h['x-forwarded-host'], h['x-nf-forwarded-host']].filter(Boolean).some((x) => x.split(',')[0].trim() === host)) return true;
  // The site's own addresses as Netlify reports them (production, this deploy, this branch)
  const own = [process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL].filter(Boolean).map((x) => x.replace(/\/$/, ''));
  if (own.includes(origin)) return true;
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
  return extra.includes(origin);
}
const reply = (statusCode, obj, extra) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(extra || {}) },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  const h = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const origin = callerOrigin(h);
  const allowed = originAllowed(origin, h);
  // CORS headers only for a caller that is allowed AND on another origin
  const cors = allowed ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : { 'Vary': 'Origin' };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    if (!allowed) return { statusCode: 403, headers: cors, body: '' };
    return {
      statusCode: 204,
      headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { Allow: 'POST, OPTIONS' }, body: 'Method Not Allowed' };
  }
  if (!allowed) return reply(403, { error: 'Not allowed from this site' }, cors);
  const ip = (h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
  if (rateLimited(ip)) return reply(429, { error: 'Too many requests, slow down' }, { ...cors, 'Retry-After': '30' });
  if ((event.body || '').length > MAX_BODY) return reply(413, { error: 'Request too large' }, cors);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return reply(500, { error: 'Voice service is not configured' }, cors);
  }

  // Voice fallback chain. Free ElevenLabs accounts can only use PREMADE voices
  // via the API — Voice Library voices return 402 "paid_plan_required". So we
  // try the configured voice first, then fall back to premade voices that are
  // always free-eligible ("Sarah", then "George").
  // Sôr António's voice is "Mateus" (a Voice Library voice). It always comes first,
  // whatever ELEVENLABS_VOICE_ID holds; that variable is now the backup.
  const SOR_ANTONIO_VOICE = 'ybSQXXKaA88uXOUGaM03';
  const PREMADE_FALLBACKS = ['EXAVITQu4vr4xnSDxMaL', 'JBFqnCBsd6RMkjVDRZzb'];
  const configured = process.env.ELEVENLABS_VOICE_ID;
  const voiceChain = [...new Set([SOR_ANTONIO_VOICE, configured, ...PREMADE_FALLBACKS].filter(Boolean))];

  let text = '';
  try {
    const t = JSON.parse(event.body || '{}').text;
    text = (typeof t === 'string' ? t : '').slice(0, 500);
  } catch {
    return reply(400, { error: 'Invalid JSON body' }, cors);
  }
  if (!text.trim()) {
    return reply(400, { error: 'No text provided' }, cors);
  }

  // Model: a low-latency one by default so playback starts quickly. Set
  // ELEVENLABS_MODEL (e.g. eleven_multilingual_v2) to trade speed for the older,
  // slower voice model. If the chosen model is refused, the older one is tried.
  const modelChain = [...new Set([process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5', 'eleven_multilingual_v2'])];
  // A voice that worked is remembered while this function stays warm, so a
  // voice the plan can't use is not retried on every request.
  if (goodVoice && voiceChain.includes(goodVoice)) { voiceChain.splice(voiceChain.indexOf(goodVoice), 1); voiceChain.unshift(goodVoice); }

  let lastStatus = 500, lastDetail = '';
  try {
    voices: for (const voiceId of voiceChain) {
      for (const modelId of modelChain) {
        // 32 kbps mono speech: a third of the default size, so it arrives sooner
        const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_22050_32`, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
          },
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        });

        if (resp.ok) {
          goodVoice = voiceId;
          const arrayBuffer = await resp.arrayBuffer();
          const base64Audio = Buffer.from(arrayBuffer).toString('base64');
          return reply(200, { audio: base64Audio, voice: voiceId, model: modelId }, cors);
        }

        lastStatus = resp.status;
        lastDetail = (await resp.text()).slice(0, 300);
        // Voice-specific rejections → try the next voice in the chain.
        // 402 = library voice on a free plan, 404 = voice ID not found.
        const voiceProblem = resp.status === 402 || resp.status === 404
          || /paid_plan_required|voice_not_found|payment_required/i.test(lastDetail);
        if (voiceProblem) continue voices;
        // 400/422 without a voice problem may be the model: try the older one
        if (resp.status === 400 || resp.status === 422) continue;
        break voices; // key/quota/server errors won't be fixed by another voice or model
      }
    }

    // Upstream detail goes to the function log, not to the caller
    console.error('ElevenLabs refused the request', lastStatus, lastDetail);
    return reply(lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502, { error: 'ElevenLabs error' }, cors);
  } catch (e) {
    console.error('TTS request failed', String(e).slice(0, 300));
    return reply(500, { error: 'Request failed' }, cors);
  }
};
