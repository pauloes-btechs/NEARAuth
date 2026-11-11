/* NEARAuth content script (Manifest V3).
 *
 * What it does:  offers a private demo alias on signup email fields, then offers a strong password.
 * What it never does: submit forms, read existing field values, or store / transmit passwords.
 * Everything stays in local demo storage (chrome.storage.local, or localStorage in in-page preview mode).
 */
(function () {
  'use strict';
  if (window.__nearauthLoaded) return;
  window.__nearauthLoaded = true;

  var Gen = globalThis.NEARAuthGen;
  var ACCOUNTS_KEY = 'nearauth_ext_accounts_v1';
  var ENABLED_KEY = 'nearauth_ext_enabled';
  var hasChrome = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
  var PREVIEW = !hasChrome; // loaded directly by the test page, without the extension installed

  var storage = {
    get: function (key, fallback) {
      if (hasChrome) return chrome.storage.local.get(key).then(function (r) { return r[key] === undefined ? fallback : r[key]; });
      try { var v = JSON.parse(localStorage.getItem(key)); return Promise.resolve(v === null ? fallback : v); }
      catch (e) { return Promise.resolve(fallback); }
    },
    set: function (key, value) {
      if (hasChrome) { var o = {}; o[key] = value; return chrome.storage.local.set(o); }
      localStorage.setItem(key, JSON.stringify(value));
      return Promise.resolve();
    }
  };

  // Lets pages (test page, dashboard) know the real extension is present.
  if (!PREVIEW) document.documentElement.dataset.nearauthExtension = chrome.runtime.getManifest().version;

  /* ---------- Dashboard bridge: mirror extension accounts into the dashboard's own storage ---------- */
  var isDashboard = !!document.querySelector('meta[name="nearauth-dashboard"]');
  function syncDashboard() {
    if (!isDashboard || PREVIEW) return;
    storage.get(ACCOUNTS_KEY, []).then(function (accounts) {
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
      window.dispatchEvent(new Event('nearauth:sync'));
    });
  }
  if (isDashboard && !PREVIEW) {
    syncDashboard();
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes[ACCOUNTS_KEY]) syncDashboard();
    });
  }

  /* ---------- Field detection ---------- */
  function looksLikeEmail(el) {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type !== 'email' && type !== 'text') return false;
    if (type !== 'email') {
      var hint = [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label')].join(' ');
      if (!/e-?mail/i.test(hint)) return false;
    }
    // Sign-in forms (existing credentials) are not signups: stay out of the way.
    var scope = el.form || document;
    if (scope.querySelector('input[autocomplete="current-password"]')) return false;
    return true;
  }

  function passwordFields(anchor) {
    var scope = (anchor && anchor.form) || document;
    return Array.prototype.filter.call(scope.querySelectorAll('input[type="password"]'), function (p) {
      return !p.disabled && !p.readOnly && p.autocomplete !== 'current-password';
    });
  }

  // Works with frameworks (React/Vue) that track input values through the native setter.
  function fill(el, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ---------- UI (isolated in a shadow root so site CSS cannot affect it) ---------- */
  var host = document.createElement('div');
  host.id = 'nearauth-extension-root';
  host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;display:none;';
  var shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.card{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#101828;color:#e8eef7;border:1px solid #2b3a55;border-radius:12px;padding:12px;width:290px;box-sizing:border-box;box-shadow:0 12px 32px rgba(0,0,0,.35)}' +
    '.head{display:flex;align-items:center;gap:7px;font-weight:700;font-size:12px;letter-spacing:.3px;margin-bottom:6px}' +
    '.logo{width:18px;height:18px;border-radius:5px;background:#6ce7be;color:#101828;display:grid;place-items:center;font-size:11px;font-weight:800}' +
    '.tag{margin-left:auto;font-weight:600;font-size:9px;letter-spacing:.8px;color:#101828;background:#f5c26b;border-radius:99px;padding:2px 7px}' +
    '.x{background:none;border:0;color:#8fa1bd;cursor:pointer;font-size:15px;padding:0 0 0 6px;line-height:1}' +
    'p{margin:0 0 9px;color:#a9b8d0;font-size:12px}' +
    '.value{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#0b1220;border:1px solid #24324b;border-radius:8px;padding:7px 9px;margin-bottom:9px;word-break:break-all;color:#6ce7be}' +
    '.row{display:flex;gap:7px}' +
    'button.act{flex:1;font:inherit;font-weight:700;font-size:12px;border-radius:8px;padding:8px 10px;cursor:pointer;border:1px solid transparent}' +
    'button.primary{background:#6ce7be;color:#0b1220}button.primary:hover{background:#8af0cf}' +
    'button.ghost{background:transparent;color:#c6d2e6;border-color:#2b3a55}button.ghost:hover{border-color:#52658a}' +
    'button:focus-visible{outline:2px solid #fff;outline-offset:2px}' +
    '.note{font-size:10.5px;color:#8fa1bd;margin:8px 0 0}' +
    '</style><div class="card" role="dialog" aria-label="NEARAuth"></div>';
  var card = shadow.querySelector('.card');
  document.documentElement.appendChild(host);

  var anchor = null;        // input the card is attached to
  var current = null;       // account record created in this page session
  var dismissed = new WeakSet();

  function place() {
    if (!anchor || !anchor.isConnected) return hide();
    var r = anchor.getBoundingClientRect();
    var left = Math.max(8, Math.min(r.left, window.innerWidth - 298));
    var top = r.bottom + 6;
    if (top + 170 > window.innerHeight && r.top > 180) top = Math.max(8, r.top - 6 - card.offsetHeight);
    host.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
  }
  function show(el) { anchor = el; host.style.display = 'block'; place(); }
  function hide() { host.style.display = 'none'; anchor = null; }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function header() {
    return '<div class="head"><span class="logo">N</span>NEARAuth' +
      '<span class="tag">' + (PREVIEW ? 'IN-PAGE PREVIEW' : 'DEMO') + '</span>' +
      '<button class="x" data-act="close" aria-label="Dismiss">×</button></div>';
  }
  function render(html) { card.innerHTML = header() + html; place(); }

  function offerAlias(el) {
    show(el);
    render('<p>Keep your real inbox private on <b>' + esc(location.hostname || 'this page') + '</b>.</p>' +
      '<div class="row"><button class="act primary" data-act="alias">Generate Private Email</button></div>' +
      '<p class="note">Demo alias on the reserved <b>.example</b> domain — it cannot receive email.</p>');
  }

  function offerPassword(el) {
    show(el);
    render('<p>Alias filled. Want a strong, unique password for this site too?</p>' +
      '<div class="row"><button class="act primary" data-act="password">Generate Password</button>' +
      '<button class="act ghost" data-act="close">No thanks</button></div>' +
      '<p class="note">Prototype: the password is filled into the form only. It is not saved or sent anywhere.</p>');
  }

  function done(el, withPassword) {
    show(el);
    render('<p><b>Protected identity created.</b> ' + (withPassword ? 'Alias and password are filled in.' : 'Alias is filled in.') +
      ' Review the form and submit it yourself — NEARAuth never submits for you.</p>' +
      '<div class="value">' + esc(current.alias) + '</div>' +
      '<div class="row"><button class="act ghost" data-act="close">Done</button></div>' +
      '<p class="note">Saved to local demo storage. Open the NEARAuth dashboard to see this account.</p>');
  }

  function saveAccount(patch) {
    return storage.get(ACCOUNTS_KEY, []).then(function (accounts) {
      if (!current) {
        current = {
          id: Gen.id(),
          name: Gen.siteName(location.hostname),
          domain: location.hostname || 'local file',
          alias: patch.alias,
          createdAt: new Date().toISOString(),
          credentials: 'none',
          source: PREVIEW ? 'in-page preview' : 'extension'
        };
        accounts.push(current);
      }
      var rec = accounts.find(function (a) { return a.id === current.id; }) || current;
      Object.assign(rec, patch);
      Object.assign(current, patch);
      return storage.set(ACCOUNTS_KEY, accounts.slice(-200));
    }).then(function () {
      window.dispatchEvent(new CustomEvent('nearauth:account-saved', { detail: { alias: current.alias, domain: current.domain } }));
    });
  }

  card.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus in the page's input
  card.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || !anchor) return;
    var act = btn.dataset.act, el = anchor;
    if (act === 'close') { dismissed.add(el); return hide(); }
    if (act === 'alias') {
      var a = Gen.alias();
      fill(el, a);
      el.dataset.nearauthFilled = '1';
      saveAccount({ alias: a }).then(function () {
        var pw = passwordFields(el);
        if (pw.length) offerPassword(pw[0]); else done(el, false);
      });
    }
    if (act === 'password') {
      var secret = Gen.password(20);
      passwordFields(el).forEach(function (p) { fill(p, secret); }); // also fills "confirm password"
      secret = null;
      saveAccount({ credentials: 'generated-not-stored' }).then(function () { done(el, true); });
    }
  });

  document.addEventListener('focusin', function (e) {
    var el = e.target;
    if (!looksLikeEmail(el) || dismissed.has(el) || el.dataset.nearauthFilled) return;
    storage.get(ENABLED_KEY, true).then(function (enabled) {
      if (enabled && document.activeElement === el) offerAlias(el);
    });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && anchor) { dismissed.add(anchor); hide(); } });
  document.addEventListener('mousedown', function (e) {
    if (anchor && e.target !== anchor && e.target !== host && !(e.target instanceof HTMLInputElement)) hide();
  });
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
})();
