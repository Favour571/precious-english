const { SYSTEM_PROMPT, MAX_MESSAGE_LENGTH, sanitizeHistory } = require('../school-context');

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 15;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  rateLimitMap.set(ip, entry);
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) { res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY is not set.'); res.status(500).json({ error: 'Server is not configured correctly.' }); return; }

  const { message, history } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) { res.status(400).json({ error: 'A non-empty "message" string is required.' }); return; }
  if (message.length > MAX_MESSAGE_LENGTH) { res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` }); return; }

  const cleanHistory = sanitizeHistory(history);
  const messages = [...cleanHistory, { role: 'user', content: message.slice(0, MAX_MESSAGE_LENGTH) }];

  try {
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 500, system: SYSTEM_PROMPT, messages }),
    });

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text();
      console.error('Anthropic API error:', anthropicResponse.status, errText);
      res.status(502).json({ error: 'The assistant is temporarily unavailable. Please try again shortly.' });
      return;
    }

    const data = await anthropicResponse.json();
    const reply = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    res.status(200).json({ reply: reply || "Sorry, I couldn't come up with a reply. Please try rephrasing." });
  } catch (err) {
    console.error('Chat handler error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again shortly.' });
  }
};
