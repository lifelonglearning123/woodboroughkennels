/* ------------------------------------------------------------------
   Woodborough Gardens Kennels — contact form

   Posts the enquiry to /api/enquiry, which forwards it to the
   GoHighLevel sub-account. No credentials live in this file: the
   location ID and token are environment variables read server-side
   by api/enquiry.js.
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var ENDPOINT = '/api/enquiry';

  var FIELDS = [
    'first_name', 'surname', 'email', 'phone', 'pet',
    'service', 'from_date', 'to_date', 'notes', 'returning', 'company'
  ];

  var FALLBACK = 'Sorry, that didn\u2019t send. Please email woodborough@yahoo.co.uk or call 07782 220 076.';

  var form = document.querySelector('[data-ghl-form]');
  if (!form) return;

  var button = form.querySelector('[type="submit"]');
  var status = form.querySelector('[data-ghl-status]');
  var buttonLabel = button ? button.textContent : 'Send enquiry';

  function collect() {
    var data = {};
    FIELDS.forEach(function (name) {
      var el = form.elements[name];
      if (!el) return;
      data[name] = (el.type === 'checkbox') ? el.checked : (el.value || '').trim();
    });
    return data;
  }

  function say(message, tone) {
    if (!status) return;
    status.textContent = message;
    status.className = 'form-status is-' + tone;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Sending…';
    }
    say('Sending your enquiry…', 'pending');

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(collect())
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (res) {
        if (res.ok) {
          form.reset();
          say('Thank you — your enquiry is with reception. We reply within 48 hours, often sooner.', 'ok');
          return;
        }
        console.error('[enquiry] Failed:', res.status, res.body);
        say(res.body && res.body.error ? res.body.error : FALLBACK, 'error');
      })
      .catch(function (err) {
        console.error('[enquiry] Network error:', err);
        say(FALLBACK, 'error');
      })
      .then(function () {
        if (button) {
          button.disabled = false;
          button.textContent = buttonLabel;
        }
      });
  });
})();
