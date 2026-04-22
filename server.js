'use strict';

require('dotenv').config();

const express    = require('express');
const cron       = require('node-cron');
const fs         = require('fs');
const path       = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const app      = express();
const PORT     = process.env.PORT || 3000;
const STORE_ID = process.env.ECWID_STORE_ID;
const TOKEN    = process.env.ECWID_TOKEN;

if (!STORE_ID || !TOKEN) {
  console.error('Missing ECWID_STORE_ID or ECWID_TOKEN in .env');
  process.exit(1);
}

// Google Analytics 4 setup
const GA4_PROPERTY_ID   = process.env.GA4_PROPERTY_ID;
const GA4_CREDS_FILE    = process.env.GA4_CREDENTIALS_FILE
  ? path.resolve(__dirname, process.env.GA4_CREDENTIALS_FILE)
  : null;

let ga4Client = null;
if (GA4_PROPERTY_ID && GA4_CREDS_FILE && fs.existsSync(GA4_CREDS_FILE)) {
  ga4Client = new BetaAnalyticsDataClient({ keyFilename: GA4_CREDS_FILE });
  console.log('GA4 realtime client ready (property', GA4_PROPERTY_ID, ')');
} else {
  console.warn('GA4 credentials not found — /api/analytics will be disabled until ga4-credentials.json is added.');
}

const API_BASE   = `https://app.ecwid.com/api/v3/${STORE_ID}`;
const CACHE_FILE = path.join(__dirname, 'cache', 'ecwid-data.json');
const LOW_STOCK_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Ecwid API helpers
// ---------------------------------------------------------------------------

async function fetchAll(resource, params = {}) {
  const items  = [];
  let   offset = 0;
  const limit  = 100;

  while (true) {
    const qs  = new URLSearchParams({ ...params, limit, offset }).toString();
    const url = `${API_BASE}/${resource}?${qs}`;

    const res = await fetch(url, {
      headers: {
        Accept:        'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`Ecwid API ${res.status} on /${resource}`);
    }

    const data  = await res.json();
    const batch = data.items ?? [];
    items.push(...batch);

    if (items.length >= (data.total ?? 0) || batch.length < limit) break;
    offset += limit;
  }

  return items;
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

const PAID_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED']);

function orderRevenue(orders) {
  return orders
    .filter(o => PAID_STATUSES.has(o.paymentStatus))
    .reduce((sum, o) => sum + (o.total ?? 0), 0);
}

function displayStatus(order) {
  const fs = order.fulfillmentStatus;
  const ps = order.paymentStatus;
  if (fs === 'SHIPPED' || fs === 'DELIVERED') return 'Shipped';
  if (PAID_STATUSES.has(ps))                  return 'Not Shipped';
  if (fs === 'PROCESSING')                    return 'Processing';
  if (ps === 'PAID')                          return 'Paid';
  return 'Pending';
}

// ---------------------------------------------------------------------------
// Period analysis helpers
// ---------------------------------------------------------------------------

function buildRevenueChart(orders, periodDays, now) {
  const points = [];
  if (periodDays <= 30) {
    for (let i = periodDays - 1; i >= 0; i--) {
      const d        = new Date(now - i * 86_400_000);
      const dayStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
      const dayEnd   = dayStart + 86_400;
      const dayOrds  = orders.filter(o => o.createTimestamp >= dayStart && o.createTimestamp < dayEnd);
      const rev      = Math.round(orderRevenue(dayOrds));
      const label    = periodDays <= 7
        ? d.toLocaleDateString('en-US', { weekday: 'short' })
        : (i % 5 === 0 || i === 0 ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
      points.push({ label, revenue: rev, orders: dayOrds.length,
        avgOrder: dayOrds.length > 0 ? Math.round(rev / dayOrds.length) : 0 });
    }
  } else {
    const weeks = Math.ceil(periodDays / 7);
    for (let w = weeks - 1; w >= 0; w--) {
      const weekEnd   = now - w * 7 * 86_400_000;
      const weekStart = weekEnd - 7 * 86_400_000;
      const secStart  = Math.floor(weekStart / 1000);
      const secEnd    = Math.floor(weekEnd   / 1000);
      const d         = new Date(weekEnd);
      const label     = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const weekOrds  = orders.filter(o => o.createTimestamp >= secStart && o.createTimestamp < secEnd);
      const rev       = Math.round(orderRevenue(weekOrds));
      points.push({ label, revenue: rev, orders: weekOrds.length,
        avgOrder: weekOrds.length > 0 ? Math.round(rev / weekOrds.length) : 0 });
    }
  }
  return points;
}

function buildTopProducts(orders, n = Infinity) {
  const map = {};
  for (const order of orders) {
    if (!PAID_STATUSES.has(order.paymentStatus)) continue;
    for (const item of (order.items ?? [])) {
      const key = item.name ?? 'Unknown';
      if (!map[key]) map[key] = { name: key, quantity: 0, revenue: 0 };
      map[key].quantity += item.quantity ?? 1;
      map[key].revenue  += (item.price ?? 0) * (item.quantity ?? 1);
    }
  }
  return Object.values(map)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, n)
    .map(p => ({ name: p.name, quantity: p.quantity, revenue: Math.round(p.revenue * 100) / 100 }));
}

function buildPeriodSlice(allOrders, periodDays, now) {
  const secPeriodAgo  = Math.floor((now - periodDays * 86_400_000) / 1000);
  const secPrevAgo    = Math.floor((now - 2 * periodDays * 86_400_000) / 1000);
  const todaySecStart = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);

  const currentOrders  = allOrders.filter(o => o.createTimestamp >= secPeriodAgo);
  const previousOrders = allOrders.filter(o =>
    o.createTimestamp >= secPrevAgo && o.createTimestamp < secPeriodAgo);

  const currRevenue   = orderRevenue(currentOrders);
  const prevRevenue   = orderRevenue(previousOrders);
  const revenueChange = prevRevenue > 0
    ? Math.round(((currRevenue - prevRevenue) / prevRevenue) * 100) : null;

  const currAvg  = currentOrders.length  > 0 ? currRevenue / currentOrders.length  : 0;
  const prevAvg  = previousOrders.length > 0 ? prevRevenue / previousOrders.length : 0;
  const avgChange = prevAvg > 0
    ? Math.round(((currAvg - prevAvg) / prevAvg) * 100) : null;

  const newToday = currentOrders.filter(o => o.createTimestamp >= todaySecStart).length;

  const paidNeedsShipping = currentOrders.filter(o =>
    PAID_STATUSES.has(o.paymentStatus) &&
    o.fulfillmentStatus !== 'SHIPPED' &&
    o.fulfillmentStatus !== 'DELIVERED'
  ).length;

  const notPaid = currentOrders.filter(o =>
    !PAID_STATUSES.has(o.paymentStatus)
  ).length;

  const ordersByStatus = { 'Not Shipped': 0, Shipped: 0, Processing: 0, Paid: 0, Other: 0 };
  for (const o of currentOrders) {
    const s = displayStatus(o);
    ordersByStatus[s] = (ordersByStatus[s] ?? 0) + 1;
    if (!(s in ordersByStatus)) ordersByStatus.Other += 1;
  }

  const recentOrders = [...currentOrders]
    .sort((a, b) => b.createTimestamp - a.createTimestamp)
    .map(o => {
      const qty  = (o.items ?? []).reduce((s, i) => s + (i.quantity ?? 0), 0);
      const name = (o.items ?? [])[0]?.name ?? 'Order';
      return {
        id:               o.orderNumber,
        description:      qty > 1 ? `${name} (${qty})` : name,
        total:            o.total ?? 0,
        status:           displayStatus(o),
        customer:         o.shippingPerson?.name || o.billingPerson?.name || o.email || 'Unknown',
        email:            o.email ?? '',
        paymentStatus:    o.paymentStatus ?? '',
        fulfillmentStatus: o.fulfillmentStatus ?? '',
        createdAt:        o.createTimestamp,
        items:            (o.items ?? []).map(i => ({ name: i.name ?? 'Item', qty: i.quantity ?? 1, price: i.price ?? 0 })),
      };
    });

  return {
    kpis: {
      totalRevenue:       Math.round(currRevenue * 100) / 100,
      totalOrders:        currentOrders.length,
      avgOrderValue:      Math.round(currAvg    * 100) / 100,
      revenueChange,
      avgChange,
      newToday,
      periodDays,
      paidNeedsShipping,
      notPaid,
    },
    revenueChart: buildRevenueChart(currentOrders, periodDays, now),
    ordersByStatus,
    recentOrders,
    topProducts: buildTopProducts(currentOrders),
  };
}

// ---------------------------------------------------------------------------
// Cache builder
// ---------------------------------------------------------------------------

async function buildCache() {
  const now        = Date.now();
  const sec180dAgo = Math.floor((now - 180 * 86_400_000) / 1000);

  const [allOrders, products] = await Promise.all([
    fetchAll('orders',   { createdFrom: sec180dAgo }),
    fetchAll('products', {}),
  ]);

  // ---- Stock alerts --------------------------------------------------------
  const stockAlerts = [];
  for (const p of products) {
    if (p.unlimited) continue;
    if (p.combinations?.length > 0) {
      for (const v of p.combinations) {
        if (v.unlimited) continue;
        if (v.quantity == null || v.quantity > LOW_STOCK_THRESHOLD) continue;
        const opts = v.options ? Object.values(v.options).join(', ') : '';
        stockAlerts.push({
          name:     opts ? `${p.name} — ${opts}` : p.name,
          quantity: v.quantity,
          status:   v.quantity === 0 ? 'Out' : 'Low',
        });
      }
    } else if (p.quantity != null && p.quantity <= LOW_STOCK_THRESHOLD) {
      stockAlerts.push({
        name:     p.name,
        quantity: p.quantity,
        status:   p.quantity === 0 ? 'Out' : 'Low',
      });
    }
  }
  stockAlerts.sort((a, b) => a.quantity - b.quantity);

  // ---- Assemble payload ----------------------------------------------------
  const d30 = buildPeriodSlice(allOrders, 30, now);

  // Abandoned orders (last 30 days, unpaid) — email recovery opportunity
  const abandonedOrders = allOrders
    .filter(o =>
      o.paymentStatus === 'AWAITING_PAYMENT' &&
      o.createTimestamp >= Math.floor((now - 30 * 86_400_000) / 1000)
    )
    .sort((a, b) => b.createTimestamp - a.createTimestamp)
    .map(o => {
      const items    = o.items ?? [];
      const qty      = items.reduce((s, i) => s + (i.quantity ?? 0), 0);
      const product  = items[0]?.name ?? 'Order';
      const customer = o.shippingPerson?.name || o.billingPerson?.name || o.email || 'Unknown';
      return {
        id:               o.orderNumber,
        customer,
        email:            o.email ?? '',
        product:          qty > 1 ? `${product} (+${qty - 1})` : product,
        total:            o.total ?? 0,
        paymentStatus:    o.paymentStatus ?? '',
        fulfillmentStatus: o.fulfillmentStatus ?? '',
        createdAt:        o.createTimestamp,
        items:            (o.items ?? []).map(i => ({ name: i.name ?? 'Item', qty: i.quantity ?? 1, price: i.price ?? 0 })),
      };
    });

  // Processing orders — orders that need to be prepared
  const processingOrders = allOrders
    .filter(o => o.fulfillmentStatus === 'PROCESSING')
    .sort((a, b) => b.createTimestamp - a.createTimestamp)
    .map(o => {
      const items    = o.items ?? [];
      const qty      = items.reduce((s, i) => s + (i.quantity ?? 0), 0);
      const product  = items[0]?.name ?? 'Order';
      const customer = o.shippingPerson?.name || o.billingPerson?.name || o.email || 'Unknown';
      return {
        id:               o.orderNumber,
        customer,
        email:            o.email ?? '',
        product:          qty > 1 ? `${product} (+${qty - 1})` : product,
        total:            o.total ?? 0,
        paymentStatus:    o.paymentStatus ?? '',
        fulfillmentStatus: o.fulfillmentStatus ?? '',
        createdAt:        o.createTimestamp,
        items:            (o.items ?? []).map(i => ({ name: i.name ?? 'Item', qty: i.quantity ?? 1, price: i.price ?? 0 })),
      };
    });
  const payload = {
    updatedAt:        new Date().toISOString(),
    d7:               buildPeriodSlice(allOrders,  7, now),
    d30,
    d60:              buildPeriodSlice(allOrders, 60, now),
    d90:              buildPeriodSlice(allOrders, 90, now),
    stockAlerts:      stockAlerts.slice(0, 10),
    abandonedOrders,
    processingOrders,
  };

  const cacheDir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');

  console.log(
    `[${new Date().toISOString()}] Cache updated — ` +
    `${d30.kpis.totalOrders} orders (30d) | ${stockAlerts.length} stock alerts`
  );

  return payload;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', (req, res) => {
  if (!fs.existsSync(CACHE_FILE)) {
    return res.status(503).json({ error: 'Cache not ready — retry in a moment.' });
  }
  try {
    const raw   = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const days  = ['7', '60', '90'].includes(req.query.days) ? req.query.days : '30';
    const slice = raw[`d${days}`] ?? raw.d30 ?? {};
    res.json({
      updatedAt:        raw.updatedAt,
      stockAlerts:      raw.stockAlerts      ?? [],
      abandonedOrders:  raw.abandonedOrders  ?? [],
      processingOrders: raw.processingOrders ?? [],
      ...slice,
      kpis: { ...slice.kpis, lowStockCount: raw.stockAlerts?.length ?? 0, abandonedCount: raw.abandonedOrders?.length ?? 0 },
    });
  } catch {
    res.status(500).json({ error: 'Failed to read cache.' });
  }
});

app.get('/healthz', (_req, res) =>
  res.json({ ok: true, uptime: Math.round(process.uptime()) })
);

// ---------------------------------------------------------------------------
// Telemetry endpoint — live data, configurable cache
// ---------------------------------------------------------------------------

const REFRESH_SEC   = Math.max(10, parseInt(process.env.REFRESH_DATA_GLOBAL || '60', 10));

// Accessibility feature flags (read once at startup)
const A11Y_CART_VOICE   = (process.env.ACCESSIBILITY_CART_VOICE    || 'enabled') !== 'disabled';
const A11Y_ORDER_VOICE  = (process.env.ACCESSIBILITY_ORDER_VOICE   || 'enabled') !== 'disabled';
const A11Y_SUMMARY_BTN  = (process.env.ACCESSIBILITY_SUMMARY_BUTTON || 'enabled') !== 'disabled';
const A11Y_SUMMARY_AUTO = Math.max(0, parseInt(process.env.ACCESSIBILITY_SUMMARY_AUTO_MIN || '0', 10));
const A11Y_AUTO_ZOOM    = (process.env.ACCESSIBILITY_AUTO_ZOOM || 'disabled') === 'enabled';
const A11Y_ZOOM_MIN     = Math.max(1, parseInt(process.env.ACCESSIBILITY_ZOOM_INTERVAL_MIN || '30', 10));
console.log(`Accessibility: cartVoice=${A11Y_CART_VOICE} orderVoice=${A11Y_ORDER_VOICE} summaryButton=${A11Y_SUMMARY_BTN} summaryAutoMin=${A11Y_SUMMARY_AUTO} autoZoom=${A11Y_AUTO_ZOOM} zoomMin=${A11Y_ZOOM_MIN}`);

let telemetryCache    = null;
let telemetryCacheAt  = 0;
const TELEMETRY_TTL   = REFRESH_SEC * 1000;

console.log(`Refresh interval: ${REFRESH_SEC}s`);

const PAID_SET = new Set(['PAID', 'PARTIALLY_REFUNDED']);

app.get('/api/telemetry', async (req, res) => {
  if (telemetryCache && Date.now() - telemetryCacheAt < TELEMETRY_TTL) {
    return res.type('application/json').send(telemetryCache);
  }

  const headers = {
    Accept:        'application/json',
    Authorization: `Bearer ${TOKEN}`,
  };
  const signal = AbortSignal.timeout(15_000);

  try {
    const now           = Date.now();
    const todayStart    = new Date(); todayStart.setHours(0, 0, 0, 0);
    const secTodayStart = Math.floor(todayStart.getTime() / 1000);
    const secCutoff     = Math.floor((now - REFRESH_SEC * 1000) / 1000);

    const [cartsRes, ordersRes] = await Promise.all([
      fetch(`${API_BASE}/carts?limit=100&abandoned=false`, { headers, signal }),
      fetch(`${API_BASE}/orders?createdFrom=${secTodayStart}&limit=100&sortBy=TIME_PLACED_DESC`, { headers, signal }),
    ]);

    const cartsData  = cartsRes.ok  ? await cartsRes.json()  : { items: [] };
    const ordersData = ordersRes.ok ? await ordersRes.json() : { items: [] };

    const allCarts     = cartsData.items  ?? [];
    const recentOrders = ordersData.items ?? [];

    // Active = updated within REFRESH_DATA_GLOBAL seconds (abandoned carts are excluded)
    const activeCarts = allCarts.filter(c => (c.updateTimestamp ?? c.createTimestamp ?? 0) >= secCutoff);

    const cartsValue   = Math.round(activeCarts.reduce((s, c) => s + (c.total ?? 0), 0) * 100) / 100;
    const paidOrders   = recentOrders.filter(o => PAID_SET.has(o.paymentStatus));
    const paidRevenue  = Math.round(paidOrders.reduce((s, o) => s + (o.total ?? 0), 0) * 100) / 100;

    function mapCart(c) {
      const items = c.items ?? [];
      return {
        id:        c.cartId,
        email:     c.email || 'Guest',
        name:      c.shippingPerson?.name || c.billingPerson?.name || null,
        total:     Math.round((c.total ?? 0) * 100) / 100,
        itemCount: items.reduce((s, i) => s + (i.quantity ?? 1), 0),
        products:  items.slice(0, 3).map(i => ({ name: i.name, qty: i.quantity, price: i.price })),
        updatedTs: c.updateTimestamp ?? c.createTimestamp ?? 0,
      };
    }

    function mapOrder(o) {
      const items = o.items ?? [];
      return {
        id:          o.orderNumber ?? o.id,
        email:       o.email || 'Guest',
        name:        o.shippingPerson?.name || o.billingPerson?.name || null,
        total:       Math.round((o.total ?? 0) * 100) / 100,
        itemCount:   items.reduce((s, i) => s + (i.quantity ?? 1), 0),
        products:    items.slice(0, 3).map(i => ({ name: i.name, qty: i.quantity, price: i.price })),
        payStatus:   o.paymentStatus,
        shipStatus:  o.fulfillmentStatus,
        createdTs:   o.createTimestamp ?? 0,
      };
    }

    const payload = {
      fetchedAt: new Date().toISOString(),
      refreshIntervalSec: REFRESH_SEC,
      carts: {
        active:     activeCarts.length,
        total:      allCarts.length,
        totalValue: cartsValue,
        items:      activeCarts.slice(0, 12).map(mapCart),
      },
      orders30min: {
        total:   recentOrders.length,
        paid:    paidOrders.length,
        revenue: paidRevenue,
        items:   recentOrders.slice(0, 12).map(mapOrder),
      },
      accessibility: {
        cartVoice:      A11Y_CART_VOICE,
        orderVoice:     A11Y_ORDER_VOICE,
        summaryButton:  A11Y_SUMMARY_BTN,
        summaryAutoMin: A11Y_SUMMARY_AUTO,
        autoZoom:       A11Y_AUTO_ZOOM,
        zoomIntervalMin: A11Y_ZOOM_MIN,
      },
    };

    telemetryCache   = JSON.stringify(payload);
    telemetryCacheAt = Date.now();
    res.type('application/json').send(telemetryCache);
  } catch (err) {
    console.error('Telemetry error:', err.message);
    if (telemetryCache) return res.type('application/json').send(telemetryCache);
    res.status(503).json({ error: 'Telemetry unavailable.' });
  }
});

// ---------------------------------------------------------------------------
// Analytics endpoint — GA4 Realtime, 30-second cache
// ---------------------------------------------------------------------------

let analyticsCache   = null;
let analyticsCacheAt = 0;
const ANALYTICS_TTL  = 30_000;

// Rolling history — one entry per successful poll (up to 60 = 30 min at 30s intervals)
const analyticsHistory = [];
const HISTORY_MAX      = 60;

app.get('/api/analytics', async (req, res) => {
  if (!ga4Client) {
    return res.status(503).json({ error: 'GA4 not configured. Add ga4-credentials.json and restart.', configured: false });
  }

  if (analyticsCache && Date.now() - analyticsCacheAt < ANALYTICS_TTL) {
    return res.type('application/json').send(analyticsCache);
  }

  try {
    const property = `properties/${GA4_PROPERTY_ID}`;

    // Fetch realtime data in parallel (5 queries)
    const [byPageRes, totalRes, fiveMinRes, byCountryRes, byDeviceRes] = await Promise.all([
      ga4Client.runRealtimeReport({
        property,
        dimensions: [{ name: 'unifiedScreenName' }],
        metrics:    [{ name: 'activeUsers' }],
        orderBys:   [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit:      '15',
      }),
      ga4Client.runRealtimeReport({
        property,
        metrics: [{ name: 'activeUsers' }],
      }),
      ga4Client.runRealtimeReport({
        property,
        metrics:      [{ name: 'activeUsers' }],
        minuteRanges: [{ name: 'last5min', startMinutesAgo: 4, endMinutesAgo: 0 }],
      }),
      ga4Client.runRealtimeReport({
        property,
        dimensions: [{ name: 'country' }],
        metrics:    [{ name: 'activeUsers' }],
        orderBys:   [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit:      '8',
      }),
      ga4Client.runRealtimeReport({
        property,
        dimensions: [{ name: 'deviceCategory' }],
        metrics:    [{ name: 'activeUsers' }],
      }),
    ]);

    const [byPage]    = byPageRes;
    const [total]     = totalRes;
    const [fiveMin]   = fiveMinRes;
    const [byCountry] = byCountryRes;
    const [byDevice]  = byDeviceRes;

    const totalUsers   = parseInt(total?.rows?.[0]?.metricValues?.[0]?.value   ?? '0', 10);
    const fiveMinUsers = parseInt(fiveMin?.rows?.[0]?.metricValues?.[0]?.value ?? '0', 10);

    const pages = (byPage?.rows ?? []).map(row => ({
      title: row.dimensionValues?.[0]?.value || '(sem título)',
      users: parseInt(row.metricValues?.[0]?.value ?? '0', 10),
    }));

    const countries = (byCountry?.rows ?? []).map(row => ({
      name:  row.dimensionValues?.[0]?.value || '',
      users: parseInt(row.metricValues?.[0]?.value ?? '0', 10),
    }));

    const devices = (byDevice?.rows ?? []).map(row => ({
      type:  row.dimensionValues?.[0]?.value || 'other',
      users: parseInt(row.metricValues?.[0]?.value ?? '0', 10),
    }));

    // Push to rolling history
    analyticsHistory.push({ ts: Date.now(), users: totalUsers });
    if (analyticsHistory.length > HISTORY_MAX) analyticsHistory.shift();

    const payload = {
      fetchedAt:    new Date().toISOString(),
      configured:   true,
      activeUsers:  totalUsers,
      activeUsers5: fiveMinUsers,
      pages,
      countries,
      devices,
      history:      analyticsHistory.map(h => ({ ts: h.ts, users: h.users })),
    };

    analyticsCache   = JSON.stringify(payload);
    analyticsCacheAt = Date.now();
    res.type('application/json').send(analyticsCache);
  } catch (err) {
    console.error('GA4 Analytics error:', err.message);
    if (analyticsCache) return res.type('application/json').send(analyticsCache);
    res.status(503).json({ error: 'GA4 API error: ' + err.message, configured: true });
  }
});

// ---------------------------------------------------------------------------
// Scheduler + startup
// ---------------------------------------------------------------------------

// Refresh every 5 minutes
cron.schedule('*/5 * * * *', () => {
  buildCache().catch(err => console.error('Cache refresh failed:', err.message));
});

// Build cache first, then start listening
buildCache()
  .catch(err => console.error('Initial cache build failed — server will start anyway:', err.message))
  .finally(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Dashboard running → http://localhost:${PORT}`);
    });
  });
