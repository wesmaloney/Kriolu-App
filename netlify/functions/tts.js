// Netlify serverless function: ElevenLabs Text-to-Speech proxy
// Keeps your API key secret on the server and avoids browser CORS blocks.
//
// Set these in Netlify → Site settings → Environment variables:
//   ELEVENLABS_API_KEY  = your ElevenLabs key
//   ELEVENLABS_VOICE_ID = (optional) a backup voice ID, tried if Sôr António's voice
//                         (Mateus, below) is refused
//   ELEVENLABS_MODEL    = (optional) override the speech model

let goodVoice = null;

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
  // Sôr António's voice is "Mateus" (a Voice Library voice). It always comes first,
  // whatever ELEVENLABS_VOICE_ID holds; that variable is now the backup.
  const SOR_ANTONIO_VOICE = 'ybSQXXKaA88uXOUGaM03';
  const PREMADE_FALLBACKS = ['EXAVITQu4vr4xnSDxMaL', 'JBFqnCBsd6RMkjVDRZzb'];
  const configured = process.env.ELEVENLABS_VOICE_ID;
  const voiceChain = [...new Set([SOR_ANTONIO_VOICE, configured, ...PREMADE_FALLBACKS].filter(Boolean))];

  let text = '';
  try {
    text = (JSON.parse(event.body || '{}').text || '').slice(0, 500);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!text.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };
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
          return {
            statusCode: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify({ audio: base64Audio, voice: voiceId, model: modelId }),
          };
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
