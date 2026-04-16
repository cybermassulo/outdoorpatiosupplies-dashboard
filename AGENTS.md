# Outdoor Patio Supplies — Live Dashboard · AI Context Document

> **Purpose:** This file gives an AI assistant full context to safely make changes to this project without needing a long conversation history.

---

## 1. Project Overview

A **Node.js + Express** internal dashboard for the e-commerce store [outdoorpatiosupplies.com](https://outdoorpatiosupplies.com), served at `http://localhost:3000`.

It has two pages:

| Page | File | Purpose |
|---|---|---|
| `/` | `public/index.html` + `public/dashboard.js` | Sales dashboard — KPIs, revenue chart, top products, order status |
| `/telemetry` | `public/telemetry.html` + `public/telemetry.js` | Live store telemetry — real-time carts, orders, GA4 users, map |

---

## 2. Architecture

```
outdoorpatiosupplies/
├── server.js              # Express server — all API routes + cache builder
├── .env                   # Config — secrets, feature flags (never commit)
├── ga4-credentials.json   # Google service account key (never commit)
├── package.json
├── cache/
│   └── ecwid-data.json    # Cached Ecwid data, rebuilt every 5 minutes
└── public/
    ├── index.html         # Dashboard page (static HTML)
    ├── dashboard.js       # Dashboard client-side JS
    ├── telemetry.html     # Telemetry page (static HTML)
    └── telemetry.js       # Telemetry client-side JS
```

**No build step.** No React, no bundler. Pure HTML + JS + CSS served as static files by Express. All CSS is inlined inside each HTML file inside a `<style>` block.

---

## 3. Backend — `server.js`

### 3.1 Startup flow

1. Reads `.env` via `dotenv`
2. Validates `ECWID_STORE_ID` + `ECWID_TOKEN` (crashes on missing)
3. Initialises GA4 client if credentials file exists
4. Calls `buildCache()` immediately (fetches 180 days of orders + full product catalog from Ecwid)
5. Starts Express on `PORT` (default 3000)
6. Schedules `buildCache()` every 5 minutes via `node-cron`

### 3.2 API endpoints

| Method + Path | Description |
|---|---|
| `GET /api/data?days=7\|30\|90` | Cached Ecwid data (dashboard). Defaults to 30 days. |
| `GET /api/telemetry` | Live cart + order snapshot, TTL = `REFRESH_DATA_GLOBAL` seconds. |
| `GET /api/analytics` | GA4 realtime data, TTL = 30 seconds. |
| `GET /healthz` | Health check `{ ok: true, uptime: N }` |

### 3.3 Ecwid data pipeline

```
fetchAll('orders', { createdFrom: 180dAgo })   ← paginated, 100/page
fetchAll('products', {})                        ← paginated, full catalog

buildPeriodSlice(allOrders, 7|30|90, now)  →  { kpis, revenueChart, ordersByStatus, recentOrders, topProducts }
  └─ buildRevenueChart()   daily points (≤30d) or weekly points (90d)
  └─ buildTopProducts()    top 5 by revenue, paid orders only

Saved to cache/ecwid-data.json  →  served by /api/data
```

**Paid statuses:** `PAID`, `PARTIALLY_REFUNDED`

### 3.4 Telemetry live query

On each `/api/telemetry` request (unless within TTL):
- Fetches active (non-abandoned) carts from last `REFRESH_DATA_GLOBAL` seconds
- Fetches today's orders since midnight
- Maps to clean `{ id, email, name, total, itemCount, products[], updatedTs/createdTs }` shape
- Includes `accessibility` config block (read from `.env` at startup)

### 3.5 GA4 Realtime

5 parallel `runRealtimeReport()` calls:
1. Active users total
2. Active users last 5 minutes
3. Pages (top 15 by activeUsers)
4. Countries (top 8)
5. Devices (mobile/desktop/tablet)

Maintains a rolling 60-entry history (≈ 30 minutes at 30s TTL) for the sparkline.

---

## 4. Frontend — Dashboard (`index.html` + `dashboard.js`)

### 4.1 Theme

- **Deep Navy** dark theme: `--bg: #060d1a`, `--card: #0d1e38`
- Background image: `https://outdoorpatiosupplies.com/wp-content/uploads/2025/09/DSC_0321-2-2-scaled.jpg.webp` with `rgba(4,10,22,0.72)` overlay
- **Glassmorphism:** all cards use `backdrop-filter: blur(5px) saturate(160%)`
- Font: **Inter** from Google Fonts
- Card opacity: `rgba(10,22,48,0.78)`

### 4.2 KPI cards

Four cards at the top, with colored `border-top` by type:
- Green: Total Revenue, Avg Order Value
- Blue: Total Orders
- Orange: New Today
- Red: Low Stock (count sourced from `stockAlerts.length` in cache)

### 4.3 Period selector

Buttons in the header: **7d / 30d / 90d**. Clicking calls `loadData(N)` which hits `/api/data?days=N`. Active button gets `.period-btn.active` class.

### 4.4 Revenue chart (Chart.js 4)

Three datasets:
1. Revenue bar (blue gradient fill)
2. Orders line (amber, right Y axis)
3. Avg order value line (dashed orange, right Y axis)

### 4.5 Bottom grid

- **Top Products** (`#topProductsList`): ranked by revenue for the selected period
- **Recent Orders** (`#recentOrdersList`): last 5 orders with status badge
- **Orders by Status** (`#ordersByStatusList`): Paid / Processing / Shipped / Other
- Auto-refreshes every 5 minutes

---

## 5. Frontend — Telemetry (`telemetry.html` + `telemetry.js`)

### 5.1 Layout

```
Header (logo + "Live Store Telemetry" + Listen button + Dashboard link)
├── Top section
│   ├── Map card (Leaflet — 1/3 width)
│   └── KPI grid (4 cards — 2/3 width)
│       ├── Active carts (30 min)
│       ├── Total cart value
│       ├── Orders closed (today)
│       └── Revenue (today)
└── Content grid (3 columns)
    ├── GA4 panel  (Google Analytics realtime)
    ├── Carts panel (Active carts now)
    └── Orders panel (Recent orders today)
```

### 5.2 Data polling

```js
// telemetry.js
setInterval(fetchTelemetry, REFRESH_SEC * 1000)  // REFRESH_DATA_GLOBAL from server
setInterval(fetchAnalytics, 30_000)               // GA4 always 30s
```

On each telemetry fetch: diffs active cart list vs previous to detect **new carts** → triggers cart alert popup.
On each telemetry fetch: diffs order list vs previous to detect **new orders** → triggers order alert popup.

### 5.3 Cart alert popup

File: `#cartAlertOverlay` / `.cart-alert-box`

Two-column layout:
- Left: dark blue gradient column with store logo
- Right: cart icon, "NEW CART OPENED!" badge, customer name, email, product, item count, total in large font, progress bar countdown (30s auto-close)

Sound: 3-note ascending triangle wave (C5 → E5 → G5) via Web Audio API.

Multiple carts queue via `_cartAlertQueue` + `_drainCartQueue()`.

### 5.4 Order alert popup

File: `#alertOverlay` / `.alert-box`

Identical layout to cart alert — two-column:
- Left: dark green gradient column with store logo
- Right: party emoji, "NEW ORDER CONFIRMED!" badge, customer name, order number, product, item count, total in large font, progress bar countdown (60s auto-close)

Sound: 3-note chime (E5 → G5 → B5) via Web Audio API.

### 5.5 Map

Leaflet 1.9.4 with CartoDB dark_nolabels tiles. CSS filter applied for blue-tinted dark look:
```css
filter: brightness(6) saturate(0.5) hue-rotate(195deg)
```
Markers are plotted from GA4 country data using approximate lat/lng lookup.

### 5.6 GA4 panel

Shows: active users (30min + 5min), top pages list, device breakdown (mobile/desktop/tablet icons), country list, sparkline (60-point history → Chart.js line).

### 5.7 Voice summary ("Listen" button)

Function: `speakSummary()` → `buildSummaryText()` → Web Speech API.

- Voice selection: `_getBestVoice()` prefers `en-US` voices (Samantha / Alex / Google US English), with fallback to any `en-*` voice
- Settings: `rate: 0.95`, `pitch: 1.05`, `volume: 1.0`
- Handles async voice loading via `voiceschanged` event
- Toggle: click while speaking → cancels

**All other voice alerts (`speakText()`) use the exact same voice selection and settings.**

### 5.8 Auto-zoom accessibility tour

When `ACCESSIBILITY_AUTO_ZOOM=enabled`, every `ACCESSIBILITY_ZOOM_INTERVAL_MIN` minutes a tour runs:

5 zoom stops (in order):
1. `.kpi-grid` — scale 1.55 — "KPI Overview"
2. `.ga-panel` — scale 1.70 — "Analytics"
3. `.panel-carts` — scale 1.70 — "Active Carts"
4. `.panel-orders` — scale 1.70 — "Recent Orders"
5. `#gaMap` — scale 1.80 — "Visitor Map"

Each stop held for 7 seconds. Label shown in `#zoomStopLabel` (fixed, bottom-center). CSS `html { transition: transform 0.8s }` drives the animation.

### 5.9 Mock alert buttons

Both panel headers have a "🌈 Test" button (`#mockCartBtn`, `#mockOrderBtn`) for testing alert popups without real purchases.

- 3 rotating mock carts and 3 mock orders
- Always speak (bypasses voice flags in test mode)
- Defined at the bottom of `telemetry.js`

---

## 6. Styling Conventions

| Rule | Detail |
|---|---|
| All CSS is inline | Inside `<style>` in each HTML file — no external CSS files |
| CSS variables | Defined in `:root` at the top of each `<style>` block |
| No CSS frameworks | Pure hand-written CSS |
| Panel gradient headers | `.panel-header` gets `background: linear-gradient(...)` per panel type |
| Glassmorphism pattern | `background: rgba(..., 0.78); backdrop-filter: blur(5px) saturate(160%)` |

---

## 7. Environment Variables (`.env`)

| Variable | Default | Description |
|---|---|---|
| `ECWID_STORE_ID` | — | **Required.** Ecwid store numeric ID |
| `ECWID_TOKEN` | — | **Required.** Ecwid API secret token |
| `PORT` | `3000` | HTTP port |
| `REFRESH_DATA_GLOBAL` | `60` | Telemetry cache TTL in seconds (min: 10) |
| `GA4_PROPERTY_ID` | — | GA4 property numeric ID |
| `GA4_CREDENTIALS_FILE` | `./ga4-credentials.json` | Path to Google service account JSON |
| `ACCESSIBILITY_CART_VOICE` | `enabled` | Voice alert on new cart popup |
| `ACCESSIBILITY_ORDER_VOICE` | `enabled` | Voice alert on new order popup |
| `ACCESSIBILITY_SUMMARY_BUTTON` | `enabled` | Show "Listen" button in telemetry header |
| `ACCESSIBILITY_SUMMARY_AUTO_MIN` | `0` | Auto-speak summary every N min (0 = off) |
| `ACCESSIBILITY_AUTO_ZOOM` | `disabled` | Enable periodic DOM zoom tour |
| `ACCESSIBILITY_ZOOM_INTERVAL_MIN` | `30` | How often the zoom tour runs (minutes) |

---

## 8. Running the Project

```bash
# Install
npm install

# Start (production)
node server.js
# or
npm start

# Start (dev — auto-restart on file change)
npm run dev
```

First run fetches 180 days of Ecwid data. **This is slow (~10-30s).** Subsequent refreshes run every 5 minutes via cron.

---

## 9. Key Implementation Notes for AI Assistants

- **No hot reload for server changes** — must restart `node server.js` after editing `server.js`
- **Frontend changes are instant** — editing `.html` / `.js` files in `public/` takes effect on next page reload; no restart needed
- **Cache invalidation** — if you change the structure of `buildCache()` output, delete `cache/ecwid-data.json` so the old format doesn't crash the server on startup
- **`_a11y` object in telemetry.js** — populated from `/api/telemetry` response (`accessibility` field). Controls voice and zoom behavior. Default flags set in `server.js` at startup
- **Alert diff logic** — carts: compares `cart.id` sets between polls. Orders: compares `order.id` sets. New IDs trigger alerts
- **Web Audio API** — alert sounds are generated programmatically (no audio files). Cart = triangle oscillator, Order = sine oscillator
- **GA4 credentials** — `ga4-credentials.json` is a Google Cloud service account key with "Viewer" role on the GA4 property. If missing, `/api/analytics` returns `{ configured: false }` and the GA panel shows a placeholder
- **`exit 137`** — means OOM kill (Linux). The server uses significant memory on first cache build (180 days of orders). If this happens, consider reducing to 90 days in `buildCache()`
- **Chart.js version** — loaded from CDN as Chart.js 4.x. The `indexAxis`, `borderDash`, and dual Y-axis APIs from v4 are used; do not use v2/v3 syntax
- **Leaflet version** — 1.9.4 from CDN. Tile layer: `https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png`

---

## 10. External Dependencies (CDN, no npm)

Used in HTML files directly via `<script>` tags:

| Library | Version | Used in |
|---|---|---|
| Chart.js | 4.x | `index.html`, `telemetry.html` |
| Leaflet | 1.9.4 | `telemetry.html` |
| Google Fonts (Inter) | — | Both pages |

---

## 11. Security Notes

- `.env` and `ga4-credentials.json` are in `.gitignore` — never commit
- The Ecwid token in `.env` is a **secret** API key — treat as a password
- The dashboard has **no authentication** — it is intended for private/internal LAN use only
- All Ecwid API calls use `Authorization: Bearer <TOKEN>` header
- `AbortSignal.timeout(15_000)` on all external fetches to prevent hanging requests
