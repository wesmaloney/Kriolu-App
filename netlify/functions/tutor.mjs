// Netlify function: Sôr António's brain.
//
// The page used to call Anthropic straight from the browser with the learner's own
// API key sitting in local storage. This function holds the key on the server
// instead (ANTHROPIC_API_KEY), picks the model, and only accepts what the tutor
// actually needs, so the key never reaches a browser and the endpoint cannot be
// turned into a general-purpose Claude proxy.
//
// Netlify → Site settings → Environment variables:
//   ANTHROPIC_API_KEY   (required, mark as secret; scope: Functions)
//   TUTOR_MODEL         (optional) model for conversation and feedback
//   TUTOR_MODEL_LIGHT   (optional) model for small background jobs (memory notes)
//   TUTOR_EFFORT        (optional) low | medium | high, default low (faster replies)
//   ALLOWED_ORIGINS     (optional) extra sites allowed to call this, comma separated
//
// Without ANTHROPIC_API_KEY the page falls back to the learner's own key, as before.

import Anthropic from '@anthropic-ai/sdk';

const env = (k) => (typeof Netlify !== 'undefined' ? Netlify.env.get(k) : process.env[k]);

const MODELS = {
  chat: () => env('TUTOR_MODEL') || 'claude-sonnet-5-5',
  light: () => env('TUTOR_MODEL_LIGHT') || 'claude-haiku-5-5',
};
const EFFORTS = ['low', 'medium', 'high'];

// What the tutor is allowed to send. Generous for a real conversation, small
// enough that one request cannot cost much.
const LIMITS = {
  bodyBytes: 120 * 1024,
  system: 30000,        // characters
  messages: 40,
  message: 8000,        // characters per message
  total: 70000,         // characters over all messages
  maxTokens: 1200,      // what a caller may ask for
  headroom: 500,        // extra tokens on top, because thinking counts toward max_tokens
};
const HOURLY_PER_IP = 400;   // a second, per-instance cap on top of the platform rate limit
const hits = new Map();
function overHourlyCap(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k);
  return recent.length > HOURLY_PER_IP;
}

const json = (status, body, extra) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(extra || {}) },
  });
const fail = (status, type, message, extra) => json(status, { type: 'error', error: { type, message } }, extra);

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

// The request, reduced to the few fields the tutor uses. Anything else is dropped.
function parseRequest(raw) {
  let b;
  try { b = JSON.parse(raw); } catch (e) { return { error: 'Invalid JSON' }; }
  if (!b || typeof b !== 'object') return { error: 'Invalid request' };
  if (typeof b.system !== 'string' || !b.system.trim() || b.system.length > LIMITS.system) return { error: 'Invalid system prompt' };
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > LIMITS.messages) return { error: 'Invalid messages' };
  let total = 0;
  const messages = [];
  for (const m of b.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim() || m.content.length > LIMITS.message) return { error: 'Invalid message' };
    total += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (total > LIMITS.total) return { error: 'Conversation too long' };
  if (messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') return { error: 'Conversation must start and end with the learner' };
  const asked = Number.isFinite(b.max_tokens) ? Math.floor(b.max_tokens) : 400;
  const tier = b.tier === 'light' ? 'light' : 'chat';
  return { tier, system: b.system, messages, max_tokens: Math.min(Math.max(asked, 1), LIMITS.maxTokens) + LIMITS.headroom };
}

export default async (req, context) => {
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!originAllowed(req)) return fail(403, 'permission_error', 'Not allowed from this site');

  // The page asks once whether the app provides the tutor itself
  if (req.method === 'GET') return json(200, { configured: !!apiKey });
  if (req.method !== 'POST') return fail(405, 'invalid_request_error', 'Method not allowed', { Allow: 'GET, POST' });
  if (!apiKey) return fail(503, 'api_error', 'The tutor is not set up on this site');

  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (overHourlyCap(ip)) return fail(429, 'rate_limit_error', 'Too many requests, please slow down', { 'Retry-After': '120' });

  const raw = await req.text();
  if (raw.length > LIMITS.bodyBytes) return fail(413, 'invalid_request_error', 'Request too large');
  const r = parseRequest(raw);
  if (r.error) return fail(400, 'invalid_request_error', r.error);

  const effort = EFFORTS.includes(env('TUTOR_EFFORT')) ? env('TUTOR_EFFORT') : 'low';
  try {
    const client = new Anthropic({ apiKey, timeout: 50000, maxRetries: 1 });
    const msg = await client.messages.create({
      model: MODELS[r.tier](),
      max_tokens: r.max_tokens,
      system: r.system,
      messages: r.messages,
      output_config: { effort },     // how hard the model thinks: low keeps replies quick
    });
    // Hand the page only the text (it reads content[0].text); thinking blocks stay here
    const content = (msg.content || []).filter((b) => b.type === 'text').map((b) => ({ type: 'text', text: b.text }));
    if (!content.length) return fail(502, 'api_error', msg.stop_reason === 'refusal' ? 'The tutor declined that request' : 'The tutor sent no reply, please try again');
    return json(200, { id: msg.id, type: 'message', role: 'assistant', content, stop_reason: msg.stop_reason, usage: msg.usage });
  } catch (e) {
    const status = e && e.status;
    // Detail goes to the function log, never to the browser
    console.error('Tutor request failed', status || '', String((e && e.message) || e).slice(0, 400));
    if (status === 429) return fail(429, 'rate_limit_error', 'The tutor is busy, please try again in a moment', { 'Retry-After': '10' });
    if (status === 529 || (status >= 500 && status < 600) || (e && /timeout|timed out/i.test(String(e.message || '')))) return fail(503, 'api_error', 'The tutor is busy, please try again in a moment');
    return fail(502, 'api_error', 'The tutor is not available right now');
  }
};

export const config = {
  path: '/api/tutor',
  // The platform limits each visitor before the function runs
  rateLimit: { action: 'rate_limit', aggregateBy: ['ip', 'domain'], windowSize: 60, windowLimit: 40 },
};
