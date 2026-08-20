/* ------------------------------------------------------------------
   POST /api/enquiry  —  Vercel serverless function

   Receives the contact-form submission, then creates/updates the
   contact in the GoHighLevel sub-account. The location ID and token
   are read from environment variables and never leave the server, so
   nothing sensitive ships to the browser.

   Required env vars (Vercel → Project → Settings → Environment Variables):
     GHL_LOCATION_ID   sub-account / location ID
     GHL_TOKEN         Private Integration Token (contacts.write)
   ------------------------------------------------------------------ */

const GHL_ENDPOINT = 'https://services.leadconnectorhq.com/contacts/upsert';
const GHL_VERSION  = '2021-07-28';

const SOURCE  = 'Website — Contact Form';
const COUNTRY = 'GB';

/* Form field → GHL custom field Unique Key.
   Swap a value for { id: 'abc123' } if you'd rather match on field ID. */
const CUSTOM_FIELDS = {
  pet:       'pet_name_and_breed',
  service:   'service_enquired',
  from_date: 'arrival_date',
  to_date:   'departure_date',
  notes:     'enquiry_notes',
  returning: 'returning_client'
};

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

function buildPayload(data, locationId) {
  const service = clean(data.service);

  const payload = {
    locationId,
    firstName: clean(data.first_name),
    lastName:  clean(data.surname),
    email:     clean(data.email),
    source:    SOURCE,
    country:   COUNTRY,
    tags:      ['website-enquiry'].concat(service ? [service.toLowerCase()] : [])
  };

  const phone = normalisePhone(data.phone);
  if (phone) payload.phone = phone;

  const customFields = [];
  for (const [field, target] of Object.entries(CUSTOM_FIELDS)) {
    const value = clean(data[field]);
    if (!value) continue;
    customFields.push(
      typeof target === 'string'
        ? { key: target, field_value: value }
        : { id: target.id, field_value: value }
    );
  }
  if (customFields.length) payload.customFields = customFields;

  return payload;
}

async function sendToGhl(payload, token) {
  const res = await fetch(GHL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version':       GHL_VERSION,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    body: JSON.stringify(payload)
  });

  let body = {};
  try { body = await res.json(); } catch (_) { /* empty or non-JSON */ }

  return { ok: res.ok, status: res.status, body };
}

/* GHL silently drops custom fields whose key does not exist in the
   location, so the substance of the enquiry — pet, dates, notes —
   is also written as a note on the contact. That always lands. */
const NOTE_ROWS = [
  ['Service',          'service'],
  ['Pet',              'pet'],
  ['Arrival',          'from_date'],
  ['Departure',        'to_date'],
  ['Returning client', 'returning']
];

function buildNote(data) {
  const stamp = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London'
  });
  const lines = ['Website enquiry — ' + stamp, ''];

  for (const [label, field] of NOTE_ROWS) {
    const value = clean(data[field]);
    if (value) lines.push(label + ': ' + value);
  }

  const notes = clean(data.notes);
  if (notes) lines.push('', 'Anything we should know:', notes);

  return lines.join('\n');
}

async function addNote(contactId, body, token) {
  const res = await fetch(
    `https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version':       GHL_VERSION,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      body: JSON.stringify({ body })
    });

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch (_) { /* non-JSON */ }
    throw new Error(res.status + ' ' + detail);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const locationId = process.env.GHL_LOCATION_ID;
  const token      = process.env.GHL_TOKEN;

  if (!locationId || !token) {
    console.error('[GHL] Missing GHL_LOCATION_ID or GHL_TOKEN env var');
    return res.status(500).json({ error: 'Form is not configured' });
  }

  const data = typeof req.body === 'string'
    ? JSON.parse(req.body || '{}')
    : (req.body || {});

  /* Honeypot: bots fill the hidden field, humans never see it.
     Answer 200 so the bot believes it succeeded. */
  if (clean(data.company)) return res.status(200).json({ ok: true });

  const firstName = clean(data.first_name);
  const surname   = clean(data.surname);
  const email     = clean(data.email);

  if (!firstName || !surname || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide your name and a valid email address.' });
  }

  const payload = buildPayload(data, locationId);

  try {
    let result = await sendToGhl(payload, token);

    /* A wrong custom-field key rejects the whole request. Rather than
       lose the enquiry, retry once with just the standard fields. */
    if (!result.ok && result.status === 400 && payload.customFields &&
        /custom/i.test(JSON.stringify(result.body))) {
      console.warn('[GHL] Custom fields rejected, retrying without them:', result.body);
      delete payload.customFields;
      result = await sendToGhl(payload, token);
    }

    if (!result.ok) {
      /* Log the detail server-side; keep it out of the browser response. */
      console.error('[GHL] Upsert failed:', result.status, result.body);
      return res.status(502).json({ error: 'We could not save your enquiry.' });
    }

    const contactId = result.body && result.body.contact && result.body.contact.id;

    if (contactId) {
      try {
        await addNote(contactId, buildNote(data), token);
      } catch (err) {
        /* The enquiry is safely in GHL. A missing note is a reception
           inconvenience, not a reason to tell the visitor it failed. */
        console.error('[GHL] Note failed for contact', contactId, err);
      }
    } else {
      console.error('[GHL] Upsert returned no contact id; note skipped');
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[GHL] Request error:', err);
    return res.status(502).json({ error: 'We could not save your enquiry.' });
  }
};
