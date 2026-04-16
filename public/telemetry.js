'use strict';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmt  = n  => usd.format(n ?? 0);
const esc  = s  => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function timeAgo(unixSec) {
  if (!unixSec) return '';
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60)  return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function statusBadge(payStatus, shipStatus) {
  if (payStatus === 'PAID' || payStatus === 'PARTIALLY_REFUNDED') {
    if (shipStatus === 'SHIPPED' || shipStatus === 'DELIVERED') return '<span class="badge badge-shipped">Shipped</span>';
    return '<span class="badge badge-paid">Paid</span>';
  }
  if (payStatus === 'AWAITING_PAYMENT') return '<span class="badge badge-pend">Pending</span>';
  return `<span class="badge badge-proc">${esc(payStatus)}</span>`;
}

function iconClass(payStatus) {
  if (payStatus === 'PAID' || payStatus === 'PARTIALLY_REFUNDED') return 'paid';
  if (payStatus === 'AWAITING_PAYMENT') return 'pend';
  return 'proc';
}

// ---------------------------------------------------------------------------
// Animated counter
// ---------------------------------------------------------------------------

// Tracks current "displayed" values so we can animate from them
const _counterState = {};

/**
 * Animates an element's text content from its current displayed value to `targetNum`.
 * - `id`        : element id
 * - `targetNum` : the new numeric value to count to
 * - `formatter` : function(n) → string  (e.g. fmt for currency, n => n for integers)
 * - `durationMs`: animation length (default 700ms)
 */
function animateValue(id, targetNum, formatter = (n) => n, durationMs = 700) {
  const el = document.getElementById(id);
  if (!el) return;

  const from = _counterState[id] ?? targetNum;
  _counterState[id] = targetNum;

  // If value didn't change, just ensure display is correct
  if (from === targetNum) {
    el.textContent = formatter(targetNum);
    return;
  }

  const start    = performance.now();
  const delta    = targetNum - from;
  const isUp     = delta > 0;

  // Briefly flash direction hint
  el.classList.remove('counter-up', 'counter-down');
  void el.offsetWidth; // force reflow to retrigger CSS transition
  el.classList.add(isUp ? 'counter-up' : 'counter-down');

  function step(now) {
    const elapsed  = now - start;
    const progress = Math.min(elapsed / durationMs, 1);
    // Ease-out cubic
    const eased    = 1 - Math.pow(1 - progress, 3);
    const current  = from + delta * eased;
    el.textContent = formatter(
      // For integers, show whole numbers; for currency, allow decimals during animation
      Number.isInteger(from) && Number.isInteger(targetNum)
        ? Math.round(current)
        : current
    );
    if (progress < 1) requestAnimationFrame(step);
    else {
      el.textContent = formatter(targetNum);
      el.classList.remove('counter-up', 'counter-down');
    }
  }

  requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Alert system
// ---------------------------------------------------------------------------

const seenOrderIds = new Set(
  JSON.parse(localStorage.getItem('seen_order_ids') || '[]')
);

const seenCartIds = new Set(
  JSON.parse(localStorage.getItem('seen_cart_ids') || '[]')
);

let alertTimer    = null;
let alertBarTimer = null;
const ALERT_DURATION_MS = 60_000;

let cartAlertTimer = null;
const CART_ALERT_MS = 30_000;

const _cartAlertQueue = [];
let _cartAlertActive = false;

function persistSeen() {
  const arr = [...seenOrderIds].slice(-200); // keep last 200
  localStorage.setItem('seen_order_ids', JSON.stringify(arr));
}

function persistSeenCarts() {
  const arr = [...seenCartIds].slice(-500);
  localStorage.setItem('seen_cart_ids', JSON.stringify(arr));
}

// ---------------------------------------------------------------------------
// Shared AudioContext — unlocked on first user gesture
// ---------------------------------------------------------------------------

let _audioCtx = null;

function getAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume();
  }
  return _audioCtx;
}

// Unlock on first click anywhere on the page
document.addEventListener('click', () => {
  try { getAudioCtx(); } catch (e) {}
}, { once: true });

function playAlertSound() {
  try {
    const ctx  = getAudioCtx();
    const t    = ctx.currentTime;

    // Three ascending "ding" tones
    [[880, 0], [1100, 0.18], [1320, 0.36]].forEach(([freq, delay]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);
      gain.gain.setValueAtTime(0, t + delay);
      gain.gain.linearRampToValueAtTime(0.7, t + delay + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.9);
      osc.start(t + delay);
      osc.stop(t + delay + 0.9);
    });
  } catch (e) {
    console.warn('Audio unavailable:', e.message);
  }
}

// Speak a short text after an optional delay (ms).
// Cancels any current speech (summary or previous alert) first.
function speakText(text, delayMs) {
  if (!('speechSynthesis' in window)) return;
  const _doSpeak = () => {
    window.speechSynthesis.cancel();
    _updateVoiceBtn(false); // reset Listen button if summary was active
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate   = 0.95;
    utt.pitch  = 1.05;
    utt.volume = 1.0;
    const trySpeak = () => {
      const voice = _getBestVoice();
      if (voice) utt.voice = voice;
      window.speechSynthesis.speak(utt);
    };
    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.addEventListener('voiceschanged', trySpeak, { once: true });
    } else {
      trySpeak();
    }
  };
  if (delayMs > 0) setTimeout(_doSpeak, delayMs);
  else _doSpeak();
}

function showAlert(order) {
  const overlay  = document.getElementById('alertOverlay');
  const barFill  = document.getElementById('alertBarFill');

  const name    = order.name || order.email || 'Customer';
  const product = order.products?.[0]?.name ?? 'Product';
  const extra   = order.itemCount > 1 ? ` + ${order.itemCount - 1} item(s)` : '';

  document.getElementById('alertName').textContent    = name;
  document.getElementById('alertOrder').textContent   = `Order #${order.id}`;
  document.getElementById('alertProduct').textContent = product + extra;
  document.getElementById('alertItems').textContent   = `${order.itemCount} item${order.itemCount !== 1 ? 's' : ''} ordered`;
  document.getElementById('alertTotal').textContent   = fmt(order.total);

  // Reset bar
  barFill.style.transition = 'none';
  barFill.style.width = '100%';

  overlay.classList.add('visible');
  playAlertSound();

  // Speak after the 3-tone sound finishes (~1.3 s)
  if (_a11y.orderVoice) {
    const _orderName  = order.name || order.email || 'Customer';
    const _orderTotal = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(order.total ?? 0);
    speakText(`New order confirmed! ${_orderName}. Order number ${order.id}. ${_orderTotal}.`, 1350);
  }

  // Animate bar countdown
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      barFill.style.transition = `width ${ALERT_DURATION_MS}ms linear`;
      barFill.style.width = '0%';
    });
  });

  // Auto-close
  clearTimeout(alertTimer);
  alertTimer = setTimeout(closeAlert, ALERT_DURATION_MS);
}

function closeAlert() {
  document.getElementById('alertOverlay').classList.remove('visible');
  clearTimeout(alertTimer);
}

document.getElementById('alertClose').addEventListener('click', closeAlert);

// ---------------------------------------------------------------------------
// Cart alert system
// ---------------------------------------------------------------------------

function playCartAlertSound() {
  try {
    const ctx = getAudioCtx();
    const t   = ctx.currentTime;
    // Two quick ascending notes (C5 → E5 → G5) — distinct from order alert
    [[523, 0], [659, 0.10], [784, 0.20]].forEach(([freq, delay]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + delay);
      gain.gain.setValueAtTime(0, t + delay);
      gain.gain.linearRampToValueAtTime(0.6, t + delay + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.55);
      osc.start(t + delay);
      osc.stop(t + delay + 0.55);
    });
  } catch (e) {
    console.warn('Audio unavailable:', e.message);
  }
}

function showCartAlert(cart) {
  const overlay = document.getElementById('cartAlertOverlay');
  const barFill = document.getElementById('cartAlertBarFill');

  const name    = cart.name || '';
  const email   = cart.email || '';
  const product = cart.products?.[0]?.name ?? 'Product';
  const extra   = cart.itemCount > 1 ? ` + ${cart.itemCount - 1} item(s)` : '';

  document.getElementById('cartAlertName').textContent    = name || email || 'Visitor';
  document.getElementById('cartAlertEmail').textContent   = name && email ? email : '';
  document.getElementById('cartAlertProduct').textContent = product + extra;
  document.getElementById('cartAlertItems').textContent   = `${cart.itemCount} item${cart.itemCount !== 1 ? 's' : ''} in cart`;
  document.getElementById('cartAlertTotal').textContent   = fmt(cart.total);

  barFill.style.transition = 'none';
  barFill.style.width = '100%';

  overlay.classList.add('visible');
  playCartAlertSound();

  // Speak after the 3-note cart sound finishes (~0.8 s)
  if (_a11y.cartVoice) {
    const _cartDisplay = cart.name || cart.email || 'Visitor';
    const _cartTotal   = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cart.total ?? 0);
    speakText(`New cart opened! ${_cartDisplay}. ${cart.itemCount} item${cart.itemCount !== 1 ? 's' : ''}. ${_cartTotal}.`, 850);
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      barFill.style.transition = `width ${CART_ALERT_MS}ms linear`;
      barFill.style.width = '0%';
    });
  });

  clearTimeout(cartAlertTimer);
  cartAlertTimer = setTimeout(closeCartAlert, CART_ALERT_MS);
}

function closeCartAlert() {
  document.getElementById('cartAlertOverlay').classList.remove('visible');
  clearTimeout(cartAlertTimer);
  _cartAlertActive = false;
  // show next queued cart after a brief pause
  if (_cartAlertQueue.length > 0) {
    setTimeout(_drainCartQueue, 600);
  }
}

function _drainCartQueue() {
  if (_cartAlertActive || _cartAlertQueue.length === 0) return;
  _cartAlertActive = true;
  showCartAlert(_cartAlertQueue.shift());
}

document.getElementById('cartAlertClose').addEventListener('click', closeCartAlert);

// ---------------------------------------------------------------------------
// Render functions
// ---------------------------------------------------------------------------

function renderKPIs(data) {
  animateValue('kpiActiveCarts',  data.carts.active,           n => n);
  animateValue('kpiCartsValue',   data.carts.totalValue,       fmt);
  animateValue('kpiOrdersTotal',  data.orders30min.total,      n => n);
  animateValue('kpiRevenue30',    data.orders30min.revenue,    fmt);
  // Sub-labels (plain text, no animation)
  document.getElementById('kpiCartsTotal').textContent = `of ${data.carts.total} total in store`;
  document.getElementById('kpiOrdersPaid').textContent  = `${data.orders30min.paid} paid`;
}

function renderCarts(carts) {
  const list = document.getElementById('cartsList');
  const cnt  = document.getElementById('cartsCount');
  cnt.textContent = `${carts.length} active`;

  if (!carts.length) {
    const win = _refreshSec < 60 ? `${_refreshSec}s` : `${Math.round(_refreshSec / 60)} min`;
    list.innerHTML = `<div class="empty-state">&#128722; No active carts in the last ${win}</div>`;
    return;
  }

  const slots = Math.max(carts.length, 5);
  const items = [...carts];
  while (items.length < slots) items.push(null);

  list.innerHTML = items.map(c => {
    if (!c) return '<div class="row-item" style="opacity:0;pointer-events:none"><div class="row-icon cart"></div><div class="row-main"></div></div>';
    const product = c.products?.[0]?.name ?? 'Produto';
    const nameStr = c.name ? `${esc(c.name)} &bull; ` : '';
    return `
      <div class="row-item">
        <div class="row-icon cart">&#128722;</div>
        <div class="row-main">
          <div class="row-title" title="${esc(product)}">${esc(product)}</div>
          <div class="row-sub">${nameStr}${esc(c.email)} &bull; ${c.itemCount} item(s)</div>
        </div>
        <div class="row-right">
          <div class="row-total">${fmt(c.total)}</div>
          <div class="row-time">${timeAgo(c.updatedTs)}</div>
        </div>
      </div>`;
  }).join('');
}

function renderOrders(orders) {
  const list = document.getElementById('ordersList');
  const cnt  = document.getElementById('ordersCount');
  cnt.textContent = `${orders.length} order${orders.length !== 1 ? 's' : ''}`;

  if (!orders.length) {
    list.innerHTML = '<div class="empty-state">&#128336; No orders today</div>';
    return;
  }

  const slots = Math.max(orders.length, 5);
  const items = [...orders];
  while (items.length < slots) items.push(null);

  list.innerHTML = items.map(o => {
    if (!o) return '<div class="row-item" style="opacity:0;pointer-events:none"><div class="row-icon paid"></div><div class="row-main"></div></div>';
    const product = o.products?.[0]?.name ?? 'Produto';
    const nameStr = o.name ? `${esc(o.name)} &bull; ` : '';
    return `
      <div class="row-item">
        <div class="row-icon ${iconClass(o.payStatus)}">&#128220;</div>
        <div class="row-main">
          <div class="row-title" title="${esc(product)}">${esc(product)}</div>
          <div class="row-sub">${nameStr}${esc(o.email)} &bull; #${esc(o.id)}</div>
        </div>
        <div class="row-right">
          <div class="row-total">${fmt(o.total)}</div>
          <div style="margin-top:3px">${statusBadge(o.payStatus, o.shipStatus)}</div>
          <div class="row-time">${timeAgo(o.createdTs)}</div>
        </div>
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Poll logic — detect new paid orders
// ---------------------------------------------------------------------------

function detectNewOrders(orders) {
  const newPaid = orders.filter(o => {
    const isPaid = o.payStatus === 'PAID' || o.payStatus === 'PARTIALLY_REFUNDED';
    return isPaid && !seenOrderIds.has(String(o.id));
  });

  // Mark all current orders as seen
  orders.forEach(o => seenOrderIds.add(String(o.id)));
  persistSeen();

  // Alert for the most recent new paid order
  if (newPaid.length > 0) {
    showAlert(newPaid[0]);
  }
}

// ---------------------------------------------------------------------------
// Cart detection
// ---------------------------------------------------------------------------

function detectNewCarts(carts) {
  const newCarts = carts.filter(c => !seenCartIds.has(String(c.id)));
  carts.forEach(c => seenCartIds.add(String(c.id)));
  persistSeenCarts();
  if (newCarts.length > 0) {
    _cartAlertQueue.push(...newCarts);
    _drainCartQueue();
  }
}

// On first load, seed seen IDs silently (no alert for historical data)
let firstLoad = true;

// ---------------------------------------------------------------------------
// GA4 render
// ---------------------------------------------------------------------------

// Country centroids [lat, lng] for Leaflet map bubbles
const COUNTRY_COORDS = {
  'United States':          [ 37.09,  -95.71],
  'Canada':                 [ 56.13, -106.35],
  'United Kingdom':         [ 55.38,   -3.44],
  'Australia':              [-25.27,  133.78],
  'Germany':                [ 51.17,   10.45],
  'France':                 [ 46.23,    2.21],
  'Brazil':                 [-14.24,  -51.93],
  'Mexico':                 [ 23.63, -102.55],
  'Japan':                  [ 36.20,  138.25],
  'China':                  [ 35.86,  104.20],
  'India':                  [ 20.59,   78.96],
  'Italy':                  [ 41.87,   12.57],
  'Spain':                  [ 40.46,   -3.75],
  'Netherlands':            [ 52.13,    5.29],
  'Sweden':                 [ 60.13,   18.64],
  'Norway':                 [ 60.47,    8.47],
  'Denmark':                [ 56.26,    9.50],
  'Finland':                [ 61.92,   25.75],
  'Portugal':               [ 39.40,   -8.22],
  'Belgium':                [ 50.50,    4.47],
  'Switzerland':            [ 46.82,    8.23],
  'Austria':                [ 47.52,   14.55],
  'Poland':                 [ 51.92,   19.15],
  'Czech Republic':         [ 49.82,   15.47],
  'Hungary':                [ 47.16,   19.50],
  'Romania':                [ 45.94,   24.97],
  'Greece':                 [ 39.07,   21.82],
  'Turkey':                 [ 38.96,   35.24],
  'Russia':                 [ 61.52,  105.32],
  'Ukraine':                [ 48.38,   31.17],
  'South Korea':            [ 35.91,  127.77],
  'Taiwan':                 [ 23.70,  121.00],
  'Singapore':              [  1.35,  103.82],
  'Hong Kong':              [ 22.40,  114.11],
  'New Zealand':            [-40.90,  174.89],
  'South Africa':           [-30.56,   22.94],
  'Argentina':              [-38.42,  -63.62],
  'Colombia':               [  4.57,  -74.30],
  'Chile':                  [-35.68,  -71.54],
  'Peru':                   [ -9.19,  -75.02],
  'Indonesia':              [ -0.79,  113.92],
  'Thailand':               [ 15.87,  100.99],
  'Vietnam':                [ 14.06,  108.28],
  'Philippines':            [ 12.88,  121.77],
  'Malaysia':               [  4.21,  108.96],
  'Pakistan':               [ 30.38,   69.35],
  'Egypt':                  [ 26.82,   30.80],
  'Nigeria':                [  9.08,    8.68],
  'Saudi Arabia':           [ 23.89,   45.08],
  'United Arab Emirates':   [ 23.42,   53.85],
  'Israel':                 [ 31.05,   34.85],
  'Ireland':                [ 53.41,   -8.24],
  'Croatia':                [ 45.10,   16.45],
  'Dominican Republic':     [ 18.74,  -70.16],
  'Venezuela':              [  6.42,  -66.59],
  'Ecuador':                [ -1.83,  -78.18],
  'Guatemala':              [ 15.78,  -90.23],
  'Costa Rica':             [  9.75,  -83.75],
  'Panama':                 [  8.54,  -80.78],
  'Bolivia':                [-16.29,  -63.59],
  'Paraguay':               [-23.44,  -58.44],
  'Uruguay':                [-32.52,  -55.77],
  'Cuba':                   [ 21.52,  -77.78],
  'Puerto Rico':            [ 18.22,  -66.59],
  'Morocco':                [ 31.79,   -7.09],
  'Algeria':                [ 28.03,    1.66],
  'Tunisia':                [ 33.89,    9.54],
  'Kenya':                  [ -0.02,   37.91],
  'Ethiopia':               [  9.14,   40.49],
  'Ghana':                  [  7.95,   -1.02],
  'Tanzania':               [ -6.37,   34.89],
  'Iraq':                   [ 33.22,   43.68],
  'Iran':                   [ 32.43,   53.69],
  'Bangladesh':             [ 23.68,   90.36],
  'Sri Lanka':              [  7.87,   80.77],
  'Nepal':                  [ 28.39,   84.12],
  'Burma':                  [ 16.87,   96.19],
  'Cambodia':               [ 12.57,  104.99],
  'Jordan':                 [ 30.59,   36.24],
  'Kuwait':                 [ 29.31,   47.48],
  'Qatar':                  [ 25.35,   51.18],
  'Bahrain':                [ 25.93,   50.64],
  'Oman':                   [ 21.51,   55.92],
  'Lebanon':                [ 33.85,   35.86],
  'Libya':                  [ 26.34,   17.23],
  'Kazakhstan':             [ 48.02,   66.92],
  'Serbia':                 [ 44.02,   21.01],
  'Bulgaria':               [ 42.73,   25.49],
  'Slovakia':               [ 48.67,   19.70],
  'Slovenia':               [ 46.15,   14.99],
  'Lithuania':              [ 55.17,   23.88],
  'Latvia':                 [ 56.88,   24.60],
  'Estonia':                [ 58.60,   25.01],
  'Belarus':                [ 53.71,   27.95],
  'Luxembourg':             [ 49.82,    6.13],
};

// ISO 3166-1 alpha-2 codes — keyed by country name (GA4 returns country names)
const COUNTRY_CODES = {
  'United States':'US', 'Canada':'CA', 'United Kingdom':'GB', 'Australia':'AU',
  'Germany':'DE', 'France':'FR', 'Brazil':'BR', 'Mexico':'MX', 'Japan':'JP',
  'China':'CN', 'India':'IN', 'Italy':'IT', 'Spain':'ES', 'Netherlands':'NL',
  'Sweden':'SE', 'Norway':'NO', 'Denmark':'DK', 'Finland':'FI', 'Portugal':'PT',
  'Belgium':'BE', 'Switzerland':'CH', 'Austria':'AT', 'Poland':'PL',
  'Czech Republic':'CZ', 'Hungary':'HU', 'Romania':'RO', 'Greece':'GR',
  'Turkey':'TR', 'Russia':'RU', 'Ukraine':'UA', 'South Korea':'KR',
  'Taiwan':'TW', 'Singapore':'SG', 'Hong Kong':'HK', 'New Zealand':'NZ',
  'South Africa':'ZA', 'Argentina':'AR', 'Colombia':'CO', 'Chile':'CL',
  'Peru':'PE', 'Indonesia':'ID', 'Thailand':'TH', 'Vietnam':'VN',
  'Philippines':'PH', 'Malaysia':'MY', 'Pakistan':'PK', 'Egypt':'EG',
  'Nigeria':'NG', 'Saudi Arabia':'SA', 'United Arab Emirates':'AE',
  'Israel':'IL', 'Ireland':'IE', 'Croatia':'HR',
};

function flagEmoji(countryName) {
  const code = COUNTRY_CODES[countryName];
  if (!code) return '🌍';
  return code.split('').map(c => String.fromCodePoint(c.charCodeAt(0) + 127397)).join('');
}

// ---------------------------------------------------------------------------
// Leaflet world map
// ---------------------------------------------------------------------------

let _gaMap     = null;
let _gaMarkers = [];

function initGaMap() {
  if (_gaMap) return;
  const el = document.getElementById('gaMap');
  if (!el || typeof L === 'undefined') return;

  _gaMap = L.map('gaMap', {
    zoomControl:       false,
    scrollWheelZoom:   false,
    doubleClickZoom:   false,
    touchZoom:         false,
    dragging:          false,
    keyboard:          false,
    attributionControl: false,
    center: [20, 0],
    zoom: 1,
  });

  // CartoDB DarkMatter — dark tiles, will be tinted via CSS filter
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    maxZoom: 4,
    subdomains: 'abcd',
  }).addTo(_gaMap);

  // Tint tile pane to a mid-dark navy (not pitch black)
  el.style.background = '#060d1a';
  _gaMap.once('layeradd', () => {
    const tp = _gaMap.getPane('tilePane');
    if (tp) tp.style.filter = 'brightness(6) saturate(0.5) hue-rotate(195deg)';
  });
}

function renderGaMap(countries) {
  initGaMap();
  if (!_gaMap) return;

  // Remove old markers
  _gaMarkers.forEach(m => m.remove());
  _gaMarkers = [];

  if (!countries || !countries.length) return;

  const maxUsers = countries[0].users || 1;

  countries.forEach(c => {
    const coords = COUNTRY_COORDS[c.name];
    if (!coords) return;

    const radius = 6 + Math.round((c.users / maxUsers) * 22);
    const marker = L.circleMarker(coords, {
      radius,
      fillColor:   '#60a5fa',
      fillOpacity: 0.65,
      color:       '#93c5fd',
      weight:      1.5,
    }).addTo(_gaMap);

    marker.bindTooltip(
      `📍 ${c.name}: <strong>${c.users}</strong> user${c.users !== 1 ? 's' : ''}`,      { sticky: true, direction: 'top', opacity: 1 }
    );

    _gaMarkers.push(marker);
  });
}
function renderSparkline(history) {
  const el = document.getElementById('gaSparkline');
  if (!el) return;
  if (!history || history.length < 2) {
    el.innerHTML = '<span style="font-size:11px;color:var(--muted);align-self:center">Collecting history…</span>';
    return;
  }
  const maxUsers = Math.max(...history.map(h => h.users), 1);
  const recent   = history.length - 1; // last bar = most recent
  el.innerHTML = history.map((h, i) => {
    const pct = Math.round((h.users / maxUsers) * 100);
    const cls = i === recent ? 'ga-spark-bar recent' : 'ga-spark-bar';
    return `<div class="${cls}" style="height:${Math.max(pct, 5)}%" title="${h.users} users"></div>`;
  }).join('');
}

function renderGaCountries(countries) {
  const el = document.getElementById('gaCountriesList');
  if (!el) return;
  if (!countries || !countries.length) {
    el.innerHTML = '<div style="padding:6px 16px;font-size:12px;color:var(--muted)">No country data</div>';
    return;
  }
  const maxUsers = countries[0]?.users || 1;
  el.innerHTML = countries.map(c => {
    const name = c.name || '(unknown)';
    const pct  = Math.round((c.users / maxUsers) * 100);
    return `
      <div class="ga-country-row">
        <span class="ga-country-name">${esc(name)}</span>
        <div class="ga-country-bar-wrap">
          <div class="ga-bar-track"><div class="ga-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <span class="ga-country-count">${c.users}</span>
      </div>`;
  }).join('');
}

function renderGaDevices(devices) {
  const total = (devices ?? []).reduce((s, d) => s + d.users, 0);
  const get = type => (devices ?? []).find(d => d.type.toLowerCase() === type)?.users ?? 0;
  const mobile  = get('mobile');
  const desktop = get('desktop');
  const tablet  = get('tablet');
  const fmt2 = (n) => total > 0 ? `${n} (${Math.round(n / total * 100)}%)` : `${n}`;
  const mEl = document.getElementById('gaMobileBadge');
  const dEl = document.getElementById('gaDesktopBadge');
  const tEl = document.getElementById('gaTabletBadge');
  if (mEl) mEl.innerHTML = `&#128241; Mobile <strong>${fmt2(mobile)}</strong>`;
  if (dEl) dEl.innerHTML = `&#128187; Desktop <strong>${fmt2(desktop)}</strong>`;
  if (tEl) tEl.innerHTML = `&#128203; Tablet <strong>${fmt2(tablet)}</strong>`;
}

function renderGA(data) {
  const kpiEl   = document.getElementById('kpiGaUsers');
  const kpi5El  = document.getElementById('kpiGaUsers5');
  const subEl   = document.getElementById('kpiGaSub');
  const cntEl   = document.getElementById('gaCount');
  const list    = document.getElementById('gaPagesList');

  if (!data || !data.configured) {
    kpiEl.textContent  = '—';
    kpi5El && (kpi5El.textContent = '—');
    subEl.textContent  = 'GA4 not configured';
    cntEl.textContent  = 'n/a';
    list.innerHTML     = `<div class="ga-not-configured">
      <span style="font-size:28px">&#128202;</span>
      <strong>Google Analytics not configured</strong>
      <span>Add the <code>ga4-credentials.json</code> file and restart the server.</span>
      <a href="https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart-client-libraries" target="_blank" rel="noopener">Setup guide ↗</a>
    </div>`;
    return;
  }

  const n = data.activeUsers;
  const n5 = data.activeUsers5 ?? 0;
  animateValue('kpiGaUsers',  n,  v => v);
  if (kpi5El) animateValue('kpiGaUsers5', n5, v => v);
  subEl.textContent  = `user${n !== 1 ? 's' : ''} active`;
  cntEl.textContent  = `${n} online`;

  renderSparkline(data.history);
  renderGaMap(data.countries);
  renderGaCountries(data.countries);
  renderGaDevices(data.devices);

  if (!data.pages || !data.pages.length) {
    list.innerHTML = '<div class="empty-state" style="flex:1">&#128203; No active users right now</div>';
    return;
  }

  const maxUsers = data.pages[0]?.users || 1;
  const slots    = Math.max(data.pages.length, 6);
  const pages    = [...data.pages];
  while (pages.length < slots) pages.push(null);

  list.innerHTML = pages.map((p, i) => {
    if (!p) return '<div class="ga-page-row" style="opacity:0;pointer-events:none;flex:1"></div>';
    const pct   = Math.round((p.users / maxUsers) * 100);
    // Strip " - Outdoor Patio Supplies" suffix for brevity
    const title = p.title.replace(/ [-–] Outdoor Patio Supplies$/i, '') || p.title;
    const isHot = /cart|checkout/i.test(p.title);
    return `
      <div class="ga-page-row${isHot ? ' ga-page-hot' : ''}" style="flex:1">
        <div class="ga-page-rank">#${i + 1}</div>
        <div class="ga-page-info">
          <div class="ga-page-title" title="${esc(p.title)}">${esc(title)}</div>
          <div class="ga-bar-track"><div class="ga-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="ga-page-count">${p.users}</div>
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Main fetch loop
// ---------------------------------------------------------------------------

async function fetchTelemetry() {
  try {
    const [telRes, gaRes] = await Promise.all([
      fetch('/api/telemetry'),
      fetch('/api/analytics'),
    ]);

    if (!telRes.ok) throw new Error(`HTTP ${telRes.status}`);
    const data = await telRes.json();

    renderKPIs(data);
    _lastTelData = data;
    renderCarts(data.carts.items);

    if (firstLoad) {
      // Seed seen IDs on first load — no alerts for existing data
      data.orders30min.items.forEach(o => seenOrderIds.add(String(o.id)));
      data.carts.items.forEach(c => seenCartIds.add(String(c.id)));
      persistSeen();
      persistSeenCarts();
      // Apply accessibility config from server (runs once)
      applyA11yConfig(data.accessibility);
      firstLoad = false;
    } else {
      detectNewCarts(data.carts.items);
      detectNewOrders(data.orders30min.items);
    }

    renderOrders(data.orders30min.items);

    // GA4 — non-fatal if unavailable
    try {
      if (gaRes.ok) {
        const gaData = await gaRes.json();
        _lastGaData = gaData;
        renderGA(gaData);
      } else {
        renderGA(null);
      }
    } catch {
      renderGA(null);
    }

    const d = new Date(data.fetchedAt);
    document.getElementById('lastUpdated').textContent =
      `Updated: ${d.toLocaleTimeString()}`;

    return data;

  } catch (err) {
    console.error('Telemetry fetch error:', err);
    document.getElementById('lastUpdated').textContent = 'Error fetching data';
    return null;
  }
}

// Initial fetch + dynamic interval driven by server config
let _refreshTimer    = null;
let _refreshSec      = 60;
let _lastTelData     = null;
let _lastGaData      = null;
let _summaryAutoTimer = null;

// Accessibility config — defaults match .env defaults (all enabled, auto off)
let _a11y = {
  cartVoice:      true,
  orderVoice:     true,
  summaryButton:  true,
  summaryAutoMin: 0,
};

function applyA11yConfig(cfg) {
  if (!cfg) return;
  _a11y = {
    cartVoice:       cfg.cartVoice      !== false,
    orderVoice:      cfg.orderVoice     !== false,
    summaryButton:   cfg.summaryButton  !== false,
    summaryAutoMin:  cfg.summaryAutoMin ?? 0,
    autoZoom:        cfg.autoZoom       === true,
    zoomIntervalMin: cfg.zoomIntervalMin ?? 30,
  };

  // Show / hide the Listen button
  const btn = document.getElementById('voiceBtn');
  if (btn) btn.style.display = _a11y.summaryButton ? '' : 'none';

  // Set up (or clear) the auto-speak timer
  if (_summaryAutoTimer) { clearInterval(_summaryAutoTimer); _summaryAutoTimer = null; }
  if (_a11y.summaryAutoMin > 0) {
    _summaryAutoTimer = setInterval(() => {
      if ('speechSynthesis' in window && !window.speechSynthesis.speaking) {
        speakSummary();
      }
    }, _a11y.summaryAutoMin * 60_000);
  }

  // Set up (or clear) the auto-zoom tour
  initAutoZoom();
}

// ---------------------------------------------------------------------------
// Auto-zoom tour — pan & zoom into key dashboard sections periodically
// ---------------------------------------------------------------------------

const _ZOOM_STOPS = [
  // [selector, scale, label]
  // KPI row — zoom into all 4 cards at once
  { sel: '.kpi-grid',     scale: 1.55, label: 'KPI Overview' },
  // GA panel
  { sel: '.ga-panel',     scale: 1.70, label: 'Analytics' },
  // Carts panel
  { sel: '.panel-carts',  scale: 1.70, label: 'Active Carts' },
  // Orders panel
  { sel: '.panel-orders', scale: 1.70, label: 'Recent Orders' },
  // Map
  { sel: '#gaMap',        scale: 1.80, label: 'Visitor Map' },
];

// Duration each stop is held (ms) — total tour ~= HOLD + TRANSITION per stop
const ZOOM_HOLD_MS       = 7_000;
const ZOOM_TRANSITION_MS = 800;

let _zoomTimer    = null;  // interval between tour cycles
let _zoomTourIdx  = 0;
let _zoomActive   = false;
let _zoomInFlight = false; // prevent overlapping tours

function _htmlElement() {
  return document.documentElement;
}

function _zoomTo(el, scale) {
  const rect   = el.getBoundingClientRect();
  const vw     = window.innerWidth;
  const vh     = window.innerHeight;
  const cx     = rect.left + rect.width  / 2;
  const cy     = rect.top  + rect.height / 2;
  const html   = _htmlElement();

  html.style.transformOrigin = `${cx}px ${cy}px`;
  html.style.transform       = `scale(${scale})`;
  html.classList.add('zoom-active');
}

function _zoomReset() {
  const html = _htmlElement();
  html.style.transform       = 'scale(1)';
  html.style.transformOrigin = '50% 50%';
  html.classList.remove('zoom-active');
}

async function _runZoomTour() {
  if (_zoomInFlight) return;
  _zoomInFlight = true;

  const label = document.getElementById('zoomStopLabel');

  for (let i = 0; i < _ZOOM_STOPS.length; i++) {
    if (!_zoomActive) break;

    const stop = _ZOOM_STOPS[(_zoomTourIdx + i) % _ZOOM_STOPS.length];
    const el   = document.querySelector(stop.sel);

    if (!el) continue;

    // Show label
    if (label) {
      label.textContent = stop.label;
      label.classList.add('visible');
    }

    _zoomTo(el, stop.scale);

    await new Promise(r => setTimeout(r, ZOOM_HOLD_MS));

    if (label) label.classList.remove('visible');

    _zoomReset();

    await new Promise(r => setTimeout(r, ZOOM_TRANSITION_MS));
  }

  _zoomTourIdx = (_zoomTourIdx + _ZOOM_STOPS.length) % _ZOOM_STOPS.length;
  _zoomInFlight = false;
}

function initAutoZoom() {
  // Clear any previous timer
  if (_zoomTimer) { clearInterval(_zoomTimer); _zoomTimer = null; }
  _zoomActive = false;
  _zoomReset();

  if (!_a11y.autoZoom) return;

  _zoomActive = true;
  const intervalMs = _a11y.zoomIntervalMin * 60_000;

  // Run first tour at interval, then repeat
  _zoomTimer = setInterval(() => {
    _runZoomTour();
  }, intervalMs);
}

async function scheduledFetch() {
  const data = await fetchTelemetry();
  _refreshSec = (data && data.refreshIntervalSec) || 60;
  const intervalMs = _refreshSec * 1000;
  _refreshTimer = setTimeout(scheduledFetch, intervalMs);
}

scheduledFetch();

// ---------------------------------------------------------------------------
// Voice summary — Web Speech API
// ---------------------------------------------------------------------------

function _getBestVoice() {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find(v => /en[-_]US/i.test(v.lang) && /samantha|alex|google us english/i.test(v.name)) ||
    voices.find(v => /en[-_]US/i.test(v.lang) && !v.localService) ||
    voices.find(v => /en[-_]US/i.test(v.lang)) ||
    voices.find(v => /^en/i.test(v.lang)) ||
    null
  );
}

function buildSummaryText() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const parts = [`${greeting}. Here's your live store update as of ${time}.`];

  if (_lastTelData) {
    const c = _lastTelData.carts;
    const o = _lastTelData.orders30min;
    const cartFmt = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v ?? 0);

    // Carts
    if (c.active === 0) {
      parts.push('There are no active shopping carts right now.');
    } else {
      parts.push(
        `There ${c.active === 1 ? 'is' : 'are'} ${c.active} active shopping cart${c.active !== 1 ? 's' : ''} right now,` +
        ` with a combined value of ${cartFmt(c.totalValue)}.`
      );
      if (c.total > c.active) {
        parts.push(`${c.total} carts are open in total across the store.`);
      }
    }

    // Orders
    if (o.total === 0) {
      parts.push('No orders have been placed today yet.');
    } else {
      parts.push(
        `Today, ${o.total} order${o.total !== 1 ? 's have' : ' has'} been placed,` +
        ` with ${o.paid} paid, generating ${cartFmt(o.revenue)} in revenue.`
      );
    }
  }

  if (_lastGaData && _lastGaData.configured) {
    const g = _lastGaData;
    const n  = g.activeUsers;
    const n5 = g.activeUsers5;
    parts.push(
      `Google Analytics shows ${n} user${n !== 1 ? 's' : ''} online right now` +
      (n5 != null ? `, with ${n5} active in the last 5 minutes.` : '.')
    );
    if (g.countries && g.countries.length > 0) {
      const top = g.countries.slice(0, 3)
        .map(c => `${c.name} with ${c.users} user${c.users !== 1 ? 's' : ''}`)
        .join(', ');
      parts.push(`Top countries: ${top}.`);
    }
    if (g.pages && g.pages.length > 0) {
      const title = g.pages[0].title.replace(/ [-–] Outdoor Patio Supplies$/i, '') || g.pages[0].title;
      parts.push(`Most visited page: "${title}" with ${g.pages[0].users} user${g.pages[0].users !== 1 ? 's' : ''}.`);
    }
  } else if (!_lastGaData || !_lastGaData.configured) {
    parts.push('Google Analytics data is not available.');
  }

  if (!_lastTelData) {
    parts.push('Store data has not loaded yet. Please wait a moment and try again.');
  }

  parts.push('End of summary.');
  return parts.join(' ');
}

function _updateVoiceBtn(speaking) {
  const btn = document.getElementById('voiceBtn');
  if (!btn) return;
  btn.innerHTML = speaking ? '&#9209;&nbsp;Stop' : '&#128266;&nbsp;Listen';
  btn.classList.toggle('voice-btn--speaking', speaking);
}

function speakSummary() {
  if (!('speechSynthesis' in window)) {
    alert('Text-to-speech is not supported in this browser.');
    return;
  }
  // Toggle: if already speaking, stop
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    _updateVoiceBtn(false);
    return;
  }

  const text = buildSummaryText();
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 0.95;
  utt.pitch  = 1.05;
  utt.volume = 1.0;

  // Voice selection — async voices may not be ready yet; retry once
  const trySpeak = () => {
    const voice = _getBestVoice();
    if (voice) utt.voice = voice;
    utt.onstart = () => _updateVoiceBtn(true);
    utt.onend   = () => _updateVoiceBtn(false);
    utt.onerror = () => _updateVoiceBtn(false);
    window.speechSynthesis.speak(utt);
  };

  if (window.speechSynthesis.getVoices().length === 0) {
    // Voices not loaded yet — wait for the event
    window.speechSynthesis.addEventListener('voiceschanged', trySpeak, { once: true });
  } else {
    trySpeak();
  }
}

document.getElementById('voiceBtn').addEventListener('click', speakSummary);

// ---------------------------------------------------------------------------
// Mock alert triggers — for testing without real data
// ---------------------------------------------------------------------------

const _MOCK_CARTS = [
  { id: 'mock-c1', email: 'sarah.johnson@gmail.com', name: 'Sarah Johnson',
    total: 348.99, itemCount: 2,
    products: [{ name: 'Pride Swivel Rocker — Taupe Sling', qty: 2, price: 174.49 }],
    updatedTs: Math.floor(Date.now() / 1000) },
  { id: 'mock-c2', email: 'mike.torres@yahoo.com',   name: 'Mike Torres',
    total: 895.00, itemCount: 4,
    products: [{ name: 'Woodard Aluminum Dining Set', qty: 1, price: 895.00 }],
    updatedTs: Math.floor(Date.now() / 1000) },
  { id: 'mock-c3', email: 'guest@example.com', name: null,
    total: 129.00, itemCount: 1,
    products: [{ name: 'Tropitone Chaise Lounge Sling', qty: 1, price: 129.00 }],
    updatedTs: Math.floor(Date.now() / 1000) },
];

const _MOCK_ORDERS = [
  { id: 39700, email: 'david.lee@gmail.com',       name: 'David Lee',
    total: 524.00, itemCount: 2, payStatus: 'PAID', shipStatus: 'AWAITING_PROCESSING',
    products: [{ name: 'Winston Outdoor Sofa — Sunbrella', qty: 1, price: 524.00 }],
    createdTs: Math.floor(Date.now() / 1000) },
  { id: 39701, email: 'amanda.clark@hotmail.com',  name: 'Amanda Clark',
    total: 1250.00, itemCount: 1, payStatus: 'PAID', shipStatus: 'SHIPPED',
    products: [{ name: 'Brown Jordan 5-Piece Dining Set', qty: 1, price: 1250.00 }],
    createdTs: Math.floor(Date.now() / 1000) },
  { id: 39702, email: 'robert.white@icloud.com',   name: 'Robert White',
    total: 76.50, itemCount: 3, payStatus: 'PAID', shipStatus: 'AWAITING_PROCESSING',
    products: [{ name: 'Outdoor Cushion Cover — Peacock', qty: 3, price: 25.50 }],
    createdTs: Math.floor(Date.now() / 1000) },
];

let _mockCartIdx  = 0;
let _mockOrderIdx = 0;

document.getElementById('mockCartBtn').addEventListener('click', () => {
  const cart = { ..._MOCK_CARTS[_mockCartIdx % _MOCK_CARTS.length],
    id: `mock-c${Date.now()}`, updatedTs: Math.floor(Date.now() / 1000) };
  _mockCartIdx++;
  _cartAlertQueue.push(cart);
  _drainCartQueue();
  // Always speak for mock testing — bypasses _a11y.cartVoice flag
  if (!_a11y.cartVoice) {
    const display = cart.name || cart.email || 'Visitor';
    const total   = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cart.total ?? 0);
    speakText(`New cart opened! ${display}. ${cart.itemCount} item${cart.itemCount !== 1 ? 's' : ''}. ${total}.`, 850);
  }
});

document.getElementById('mockOrderBtn').addEventListener('click', () => {
  const order = { ..._MOCK_ORDERS[_mockOrderIdx % _MOCK_ORDERS.length],
    id: 39700 + _mockOrderIdx, createdTs: Math.floor(Date.now() / 1000) };
  _mockOrderIdx++;
  showAlert(order);
  // Always speak for mock testing — bypasses _a11y.orderVoice flag
  if (!_a11y.orderVoice) {
    const name  = order.name || order.email || 'Customer';
    const total = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(order.total ?? 0);
    speakText(`New order confirmed! ${name}. Order number ${order.id}. ${total}.`, 1350);
  }
});

