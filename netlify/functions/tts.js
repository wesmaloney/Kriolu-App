// Netlify serverless function: ElevenLabs Text-to-Speech proxy
// Keeps your API key secret on the server and avoids browser CORS blocks.
//
// Set these in Netlify → Site settings → Environment variables:
//   ELEVENLABS_API_KEY  = your ElevenLabs key
//   ELEVENLABS_VOICE_ID = (optional) a voice ID; defaults to a clear multilingual voice

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server missing ELEVENLABS_API_KEY' }) };
  }

  // Voice fallback chain. Free ElevenLabs accounts can only use PREMADE voices
  // via the API — Voice Library voices return 402 "paid_plan_required". So we
  // try the configured voice first, then fall back to premade voices that are
  // always free-eligible ("Sarah", then "George").
  const PREMADE_FALLBACKS = ['EXAVITQu4vr4xnSDxMaL', 'JBFqnCBsd6RMkjVDRZzb'];
  const configured = process.env.ELEVENLABS_VOICE_ID;
  const voiceChain = [...new Set([configured, ...PREMADE_FALLBACKS].filter(Boolean))];

  let text = '';
  try {
    text = (JSON.parse(event.body || '{}').text || '').slice(0, 500);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!text.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };
  }

  let lastStatus = 500, lastDetail = '';
  try {
    for (const voiceId of voiceChain) {
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });

      if (resp.ok) {
        const arrayBuffer = await resp.arrayBuffer();
        const base64Audio = Buffer.from(arrayBuffer).toString('base64');
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({ audio: base64Audio, voice: voiceId }),
        };
      }

      lastStatus = resp.status;
      lastDetail = (await resp.text()).slice(0, 300);
      // Voice-specific rejections → try the next voice in the chain.
      // 402 = library voice on a free plan, 404/422 = voice ID not found.
      const voiceProblem = resp.status === 402 || resp.status === 404 || resp.status === 422
        || /paid_plan_required|voice_not_found|payment_required/i.test(lastDetail);
      if (!voiceProblem) break; // key/quota/server errors won't be fixed by another voice
    }

    return {
      statusCode: lastStatus,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'ElevenLabs error', detail: lastDetail.slice(0, 200) }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Request failed', detail: String(e).slice(0, 200) }),
    };
  }
};
