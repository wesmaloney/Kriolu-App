const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Missing ELEVENLABS_API_KEY' }) };
  }
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

  let text = '';
  try { text = (JSON.parse(event.body || '{}').text || '').slice(0, 500); }
  catch (e) { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Bad JSON' }) }; }
  if (!text.trim()) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'No text' }) };
  }

  const payload = JSON.stringify({
    text: text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 }
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: '/v1/text-to-speech/' + voiceId,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          resolve({ statusCode: res.statusCode, headers: cors(), body: JSON.stringify({ error: 'ElevenLabs error', detail: buf.toString().slice(0, 200) }) });
        } else {
          resolve({ statusCode: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, cors()), body: JSON.stringify({ audio: buf.toString('base64') }) });
        }
      });
    });
    req.on('error', (e) => {
      resolve({ statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Request failed', detail: String(e) }) });
    });
    req.write(payload);
    req.end();
  });
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
