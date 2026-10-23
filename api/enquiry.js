/* ------------------------------------------------------------------
   POST /api/enquiry  —  Vercel serverless function

   Receives the contact-form submission and forwards it to a
   GoHighLevel inbound webhook (Automation → Workflows → trigger
   "Inbound Webhook"). The workflow creates/updates the contact and
   does whatever follows — tags, notes, notifications, emails.

   The webhook URL lives only on the server, never in the browser.
   GHL_WEBHOOK_URL (Vercel → Project → Settings → Environment
   Variables) overrides the default below.
   ------------------------------------------------------------------ */

const DEFAULT_WEBHOOK =
  'https://services.leadconnectorhq.com/hooks/mTUp81zdfn1xEMBjZyp0/webhook-trigger/388665c0-b45d-4fd4-ab12-01b33812de1d';

const SOURCE  = 'Website — Contact Form';
const COUNTRY = 'GB';
const TIMEOUT_MS = 10000;

const MAX_LEN = 5000;

function clean(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_LEN);
}

/* UK numbers arrive as 07912 615229 — GHL wants E.164. */
function normalisePhone(raw) {
  const v = clean(raw).replace(/[^\d+]/g, '');
  if (!v) return '';
  if (v.startsWith('+'))   return v;
  if (v.startsWith('00'))  return '+' + v.slice(2);
  if (v.startsWith('44'))  return '+' + v;
  if (v.startsWith('0'))   return '+44' + v.slice(1);
  return '+44' + v;
}

/* The whole enquiry as one readable block, so the workflow can drop
   it straight into a contact note or a notification email. */
const NOTE_ROWS = [
  ['Service',          'service'],
  ['Dog\'s name',      'dog_name'],
  ['Breed',            'breed'],
  ['Arrival',          'from_date'],
  ['Departure',        'to_date'],
  ['Returning client', 'returning']
];

function buildNote(data, stamp) {
  const lines = ['Website enquiry — ' + stamp, ''];

  for (const [label, field] of NOTE_ROWS) {
    const value = clean(data[field]);
    if (value) lines.push(label + ': ' + value);
  }

  const notes = clean(data.notes);
  if (notes) lines.push('', 'Anything we should know:', notes);

  return lines.join('\n');
}

/* Flat keys: each one appears as {{inboundWebhookRequest.<key>}}
   when mapping fields in the GHL workflow. Empty fields are sent as
   '' so the mapping sample always shows every key. */
function buildPayload(data, page) {
  const now = new Date();
  const stamp = now.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London'
  });

  const firstName = clean(data.first_name);
  const lastName  = clean(data.surname);

  return {
    first_name:       firstName,
    last_name:        lastName,
    full_name:        (firstName + ' ' + lastName).trim(),
    email:            clean(data.email),
    phone:            normalisePhone(data.phone),
    dog_name:         clean(data.dog_name),
    dog_breed:        clean(data.breed),
    service:          clean(data.service),
    arrival_date:     clean(data.from_date),
    departure_date:   clean(data.to_date),
    notes:            clean(data.notes),
    returning_client: clean(data.returning),
    enquiry_summary:  buildNote(data, stamp),
    source:           SOURCE,
    country:          COUNTRY,
    page:             page,
    submitted_at:     now.toISOString()
  };
}

async function sendToWebhook(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  let body = '';
  try { body = await res.text(); } catch (_) { /* empty */ }

  return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookUrl = process.env.GHL_WEBHOOK_URL || DEFAULT_WEBHOOK;

  let data;
  try {
    data = typeof req.body === 'string'
      ? JSON.parse(req.body || '{}')
      : (req.body || {});
  } catch (_) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  /* Honeypot: bots fill the hidden field, humans never see it.
     Answer 200 so the bot believes it succeeded. */
  if (clean(data.company)) return res.status(200).json({ ok: true });

  const firstName = clean(data.first_name);
  const surname   = clean(data.surname);
  const email     = clean(data.email);

  if (!firstName || !surname || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide your name and a valid email address.' });
  }

  const page = clean(req.headers && req.headers.referer);
  const payload = buildPayload(data, page);

  try {
    const result = await sendToWebhook(webhookUrl, payload);

    if (!result.ok) {
      /* Log the detail server-side; keep it out of the browser response. */
      console.error('[GHL] Webhook failed:', result.status, result.body);
      return res.status(502).json({ error: 'We could not save your enquiry.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[GHL] Webhook request error:', err);
    return res.status(502).json({ error: 'We could not save your enquiry.' });
  }
};
