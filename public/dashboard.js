'use strict';

// Register datalabels plugin explicitly (CDN auto-register is unreliable with Chart.js 4)
if (typeof ChartDataLabels !== 'undefined') {
  Chart.register(ChartDataLabels);
}

let revenueChart = null;
let statusChart  = null;
let currentDays  = 30;

// Order lookup map — keyed by order id, populated on each data load
const _ordersById = {};

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

function fmt(n)  { return usd.format(n ?? 0); }
function esc(s)  {
  return String(s ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

function changeClass(n) { return n >= 0 ? 'positive' : 'negative'; }
function arrow(n)       { return n >= 0 ? '↑' : '↓'; }

function badgeClass(status) {
  switch (status) {
    case 'Paid':       return 'badge-paid';
    case 'Shipped':    return 'badge-shipped';
    case 'Processing': return 'badge-processing';
    default:           return 'badge-pending';
  }
}

function stockBadgeClass(status) {
  switch (status) {
    case 'Out': return 'badge-out';
    case 'Low': return 'badge-low';
    default:    return 'badge-ok';
  }
}

// ---------------------------------------------------------------------------
// Render functions
// ---------------------------------------------------------------------------

function renderKPIs(kpis) {
  // Revenue
  document.getElementById('kpiRevenue').textContent = fmt(kpis.totalRevenue);
  const revEl = document.getElementById('kpiRevenueChange');
  if (kpis.revenueChange != null) {
    revEl.className = `kpi-change ${changeClass(kpis.revenueChange)}`;
    revEl.textContent = `${arrow(kpis.revenueChange)} ${Math.abs(kpis.revenueChange)}% vs. last month`;
  } else {
    revEl.className = 'kpi-change neutral';
    revEl.textContent = 'No prior-period data';
  }

  // Orders
  document.getElementById('kpiOrders').textContent = kpis.totalOrders;
  const ordEl = document.getElementById('kpiOrdersChange');
  if (kpis.newToday > 0) {
    ordEl.className = 'kpi-change positive';
    ordEl.textContent = `↑ ${kpis.newToday} new today`;
  } else {
    ordEl.className = 'kpi-change neutral';
    ordEl.textContent = '0 new today';
  }

  // Avg order value
  document.getElementById('kpiAvg').textContent = fmt(kpis.avgOrderValue);
  const avgEl = document.getElementById('kpiAvgChange');
  if (kpis.avgChange != null) {
    avgEl.className = `kpi-change ${changeClass(kpis.avgChange)}`;
    avgEl.textContent = `${arrow(kpis.avgChange)} ${Math.abs(kpis.avgChange)}% vs. last month`;
  } else {
    avgEl.className = 'kpi-change neutral';
    avgEl.textContent = 'No prior-period data';
  }

  // Paid – needs shipping
  document.getElementById('kpiNeedsShipping').textContent = kpis.paidNeedsShipping ?? 0;
  const needsEl = document.getElementById('kpiNeedsShippingStatus');
  if ((kpis.paidNeedsShipping ?? 0) > 0) {
    needsEl.className = 'kpi-change warning';
    needsEl.textContent = 'Awaiting dispatch';
  } else {
    needsEl.className = 'kpi-change positive';
    needsEl.textContent = 'All shipped';
  }

  // Not paid
  document.getElementById('kpiNotPaid').textContent = kpis.notPaid ?? 0;
  const notPaidEl = document.getElementById('kpiNotPaidStatus');
  if ((kpis.notPaid ?? 0) > 0) {
    notPaidEl.className = 'kpi-change negative';
    notPaidEl.textContent = 'Pending payment';
  } else {
    notPaidEl.className = 'kpi-change positive';
    notPaidEl.textContent = 'All collected';
  }

  // Abandoned carts
  document.getElementById('kpiAbandoned').textContent = kpis.abandonedCount ?? 0;
  const abandonedEl = document.getElementById('kpiAbandonedStatus');
  if ((kpis.abandonedCount ?? 0) > 0) {
    abandonedEl.className = 'kpi-change warning';
    abandonedEl.textContent = 'Recovery opportunity';
  } else {
    abandonedEl.className = 'kpi-change positive';
    abandonedEl.textContent = 'No abandoned carts';
  }
}

function renderRevenueChart(data) {
  const labels   = data.map(d => d.label);
  const revenues = data.map(d => d.revenue);
  const orders   = data.map(d => d.orders);
  const avgs     = data.map(d => d.avgOrder ?? 0);

  const ctx = document.getElementById('revenueChart').getContext('2d');
  if (revenueChart) revenueChart.destroy();

  revenueChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        {
          type:            'bar',
          label:           'Revenue',
          data:            revenues,
          backgroundColor: 'rgba(59,130,246,0.80)',
          borderRadius:    4,
          yAxisID:         'yRev',
        },
        {
          type:              'line',
          label:             'Orders',
          data:              orders,
          borderColor:       '#22c55e',
          backgroundColor:   'rgba(34,197,94,0.08)',
          borderWidth:       2,
          pointRadius:       3,
          pointBackgroundColor: '#22c55e',
          tension:           0.3,
          yAxisID:           'yOrd',
        },
        {
          type:              'line',
          label:             'Avg Order',
          data:              avgs,
          borderColor:       '#fb923c',
          backgroundColor:   'rgba(251,146,60,0.08)',
          borderWidth:       2,
          borderDash:        [5, 4],
          pointRadius:       2,
          pointBackgroundColor: '#fb923c',
          tension:           0.3,
          yAxisID:           'yRev',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: '#94a3b8', font: { size: 26 }, boxWidth: 14, padding: 20 },
        },
        datalabels: { display: false },
      },
      scales: {
        x: {
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#94a3b8', font: { size: 26 } },
        },
        yRev: {
          position: 'left',
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            color: '#94a3b8',
            font:  { size: 26 },
            callback: v => `$${(v / 1000).toFixed(1)}k`,
          },
        },
        yOrd: {
          position: 'right',
          grid:  { drawOnChartArea: false },
          ticks: { color: '#94a3b8', font: { size: 26 }, precision: 0 },
        },
      },
    },
  });
}

function renderStatusChart(statusData) {
  const COLOR_MAP = {
    'Not Shipped': '#f59e0b',
    Paid:          '#3b82f6',
    Processing:    '#1d4ed8',
    Shipped:       '#14b8a6',
    Other:         '#475569',
    Pending:       '#475569',
  };

  const labels = Object.keys(statusData).filter(k => statusData[k] > 0);
  const values = labels.map(k => statusData[k]);
  const colors = labels.map(l => COLOR_MAP[l] ?? '#475569');

  const ctx = document.getElementById('statusChart').getContext('2d');
  if (statusChart) statusChart.destroy();

  statusChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data:            values,
        backgroundColor: colors,
        borderWidth:     0,
        hoverOffset:     6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          display: true,
          labels: { color: '#94a3b8', font: { size: 26 }, boxWidth: 14, padding: 20 },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.parsed} orders`,
          },
        },
        datalabels: {
          display: true,
          color: '#fff',
          anchor: 'center',
          align: 'center',
          textAlign: 'center',
          font: { size: 22, weight: 'bold' },
          formatter: (value, ctx) => {
            const label = ctx.chart.data.labels[ctx.dataIndex];
            return `${label}\n${value}`;
          },
        },
      },
    },
  });
}

function renderOrders(orders) {
  const list = document.getElementById('recentOrdersList');
  if (!list) return;
  if (!orders?.length) {
    list.innerHTML = '<li style="color:var(--muted);padding:12px 0">No orders found.</li>';
    return;
  }
  list.innerHTML = orders.map(o => {
    _ordersById[o.id] = o;
    return `
    <li class="stock-item od-clickable" data-order-id="${esc(o.id)}">
      <span class="stock-name">${esc(o.description)}<small>#${esc(o.id)}</small></span>
      <span class="badge ${badgeClass(o.status)}">${esc(o.status)}</span>
      <span class="rev-blue">${fmt(o.total)}</span>
    </li>`;
  }).join('');
  _bindOrderClicks(list);
}

function renderAbandonedOrders(orders) {
  const list = document.getElementById('abandonedOrdersList');
  if (!list) return;
  if (!orders?.length) {
    list.innerHTML = '<li style="color:var(--muted);padding:12px 0">✅ No abandoned orders — great!</li>';
    return;
  }
  list.innerHTML = orders.map(o => {
    _ordersById[o.id] = o;
    return `
    <li class="stock-item od-clickable" data-order-id="${esc(o.id)}">
      <span class="stock-name" title="${esc(o.email)}">${esc(o.customer)}<small>#${esc(o.id)} &middot; ${esc(o.product)}</small></span>
      <span class="rev-red">${fmt(o.total)}</span>
    </li>`;
  }).join('');
  _bindOrderClicks(list);
}

function renderProcessingOrders(orders) {
  const list = document.getElementById('processingOrdersList');
  if (!list) return;
  if (!orders?.length) {
    list.innerHTML = '<li style="color:var(--muted);padding:12px 0">✅ No orders in processing.</li>';
    return;
  }
  list.innerHTML = orders.map(o => {
    _ordersById[o.id] = o;
    return `
    <li class="stock-item od-clickable" data-order-id="${esc(o.id)}">
      <span class="stock-name">${esc(o.customer)}<small>#${esc(o.id)} &middot; ${esc(o.product)}</small></span>
      <span class="rev-orange">${fmt(o.total)}</span>
    </li>`;
  }).join('');
  _bindOrderClicks(list);
}

let _topProductsArr = [];

function renderTopProducts(products) {
  _topProductsArr = products || [];
  const list = document.getElementById('topProductsList');
  if (!list) return;
  if (!_topProductsArr.length) {
    list.innerHTML = '<li style="color:var(--muted);padding:12px 0">No sales data for this period</li>';
    return;
  }
  list.innerHTML = _topProductsArr.map((p, i) => `
    <li class="stock-item od-clickable" data-product-idx="${i}">
      <span class="rank-num">#${i + 1}</span>
      <span class="stock-name">${esc(p.name)}</span>
      <span class="stock-qty">${p.quantity}</span>
      <span class="top-rev">${fmt(p.revenue)}</span>
    </li>
  `).join('');
  list.querySelectorAll('[data-product-idx]').forEach(li => {
    li.addEventListener('click', () => {
      const idx = parseInt(li.dataset.productIdx, 10);
      const p = _topProductsArr[idx];
      if (p) openProductModal(p, idx + 1);
    });
  });
}

// ---------------------------------------------------------------------------
// Data fetch + render cycle
// ---------------------------------------------------------------------------

async function loadData(days = currentDays) {
  try {
    const res = await fetch(`/api/data?days=${days}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    renderKPIs(data.kpis);
    renderRevenueChart(data.revenueChart);
    renderStatusChart(data.ordersByStatus);
    renderOrders(data.recentOrders);
    renderTopProducts(data.topProducts);
    renderAbandonedOrders(data.abandonedOrders);
    renderProcessingOrders(data.processingOrders);
    _lastDashData = data;

    // Update period badge in revenue card header
    const badge = document.getElementById('revPeriodBadge');
    if (badge) badge.textContent = `Last ${data.kpis?.periodDays ?? days} days`;

    const d = new Date(data.updatedAt);
    document.getElementById('updatedAt').textContent =
      `Updated: ${d.toLocaleTimeString()}`;
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
  }
}

// ---------------------------------------------------------------------------
// Order Detail Modal
// ---------------------------------------------------------------------------

function _statusBadgeClass(ps, fs) {
  if (fs === 'SHIPPED' || fs === 'DELIVERED') return 'od-status-shipped';
  if (ps === 'PAID' || ps === 'PARTIALLY_REFUNDED') return 'od-status-notshipped';
  if (fs === 'PROCESSING') return 'od-status-processing';
  if (ps === 'AWAITING_PAYMENT') return 'od-status-unpaid';
  return 'od-status-default';
}

function _paymentLabel(ps) {
  const map = {
    PAID: 'Paid', PARTIALLY_REFUNDED: 'Partially Refunded',
    AWAITING_PAYMENT: 'Awaiting Payment', CANCELLED: 'Cancelled',
  };
  return map[ps] || ps || 'Unknown';
}

function _fulfillmentLabel(fs) {
  const map = {
    AWAITING_PROCESSING: 'Awaiting Processing', PROCESSING: 'Processing',
    SHIPPED: 'Shipped', DELIVERED: 'Delivered', WILL_NOT_DELIVER: 'Will Not Deliver',
  };
  return map[fs] || fs || 'Awaiting Processing';
}

function openProductModal(product, rank) {
  const overlay = document.getElementById('orderDetailOverlay');
  if (!overlay) return;
  document.getElementById('odBadge').textContent    = 'Product Details';
  document.getElementById('odOrderNum').textContent = `#${rank}`;
  document.getElementById('odDate').textContent     = `${currentDays}d period`;
  document.getElementById('odCustomer').textContent = product.name;
  document.getElementById('odEmail').textContent    = '';
  document.getElementById('odStatuses').innerHTML   = '<span class="od-status-badge od-status-shipped">Top Product</span>';
  document.getElementById('odItems').innerHTML      = `
    <li class="od-item-row">
      <span class="od-item-name">Units sold</span>
      <span class="od-item-price">${product.quantity}</span>
    </li>`;
  document.getElementById('odTotal').textContent = fmt(product.revenue);
  overlay.classList.add('visible');
}

function openOrderModal(order) {
  const overlay = document.getElementById('orderDetailOverlay');
  if (!overlay) return;

  document.getElementById('odOrderNum').textContent   = `#${order.id}`;
  document.getElementById('odCustomer').textContent   = order.customer || order.description || 'Unknown';
  document.getElementById('odEmail').textContent      = order.email || '';

  // Date
  const dateEl = document.getElementById('odDate');
  if (order.createdAt) {
    const d = new Date(order.createdAt * 1000);
    dateEl.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } else {
    dateEl.textContent = '';
  }

  // Status badges
  const statusesEl = document.getElementById('odStatuses');
  const psClass = order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIALLY_REFUNDED'
    ? 'od-status-paid' : order.paymentStatus === 'AWAITING_PAYMENT' ? 'od-status-unpaid' : 'od-status-default';
  const fsClass = order.fulfillmentStatus === 'SHIPPED' || order.fulfillmentStatus === 'DELIVERED'
    ? 'od-status-shipped' : order.fulfillmentStatus === 'PROCESSING' ? 'od-status-processing' : 'od-status-default';
  statusesEl.innerHTML = `
    <span class="od-status-badge ${psClass}">${_paymentLabel(order.paymentStatus)}</span>
    <span class="od-status-badge ${fsClass}">${_fulfillmentLabel(order.fulfillmentStatus)}</span>`;

  // Items
  const itemsEl = document.getElementById('odItems');
  if (order.items?.length) {
    itemsEl.innerHTML = order.items.map(i => `
      <li class="od-item-row">
        <span class="od-item-qty">x${i.qty}</span>
        <span class="od-item-name">${esc(i.name)}</span>
        <span class="od-item-price">${fmt(i.price * i.qty)}</span>
      </li>`).join('');
  } else {
    const desc = order.description || order.product || '';
    itemsEl.innerHTML = desc
      ? `<li class="od-item-row"><span class="od-item-name">${esc(desc)}</span></li>`
      : '<li class="od-item-row" style="color:#94a3b8">No item details available</li>';
  }

  // Total
  document.getElementById('odTotal').textContent = fmt(order.total);

  overlay.classList.add('visible');
  document.getElementById('odBadge').textContent = 'Order Details';
}

function closeOrderModal() {
  document.getElementById('orderDetailOverlay')?.classList.remove('visible');
}

function _bindOrderClicks(list) {
  list.querySelectorAll('[data-order-id]').forEach(li => {
    li.addEventListener('click', () => {
      const order = _ordersById[li.dataset.orderId];
      if (order) openOrderModal(order);
    });
  });
}

// Modal close bindings
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('odClose')?.addEventListener('click', closeOrderModal);
  document.getElementById('orderDetailOverlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeOrderModal();
  });
});

// ---------------------------------------------------------------------------
// Period selector
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentDays = parseInt(btn.dataset.days, 10);
    loadData(currentDays);
  });
});

// Initial load + auto-refresh every 5 minutes
loadData();
setInterval(() => loadData(currentDays), 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Voice summary
// ---------------------------------------------------------------------------

let _lastDashData = null;

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

function _updateVoiceBtn(speaking) {
  const btn = document.getElementById('voiceBtn');
  if (!btn) return;
  btn.innerHTML = speaking ? '&#9209;&nbsp;Stop' : '&#128266;&nbsp;Listen';
  btn.classList.toggle('voice-btn--speaking', speaking);
}

function buildDashSummaryText() {
  const hour     = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const time     = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days     = currentDays;

  const parts = [`${greeting}. Here's your sales dashboard summary as of ${time}, for the last ${days} days.`];

  if (_lastDashData) {
    const k = _lastDashData.kpis;

    // Revenue
    parts.push(
      `Total revenue: ${fmt(k.totalRevenue)}.` +
      (k.revenueChange != null
        ? ` That's ${k.revenueChange >= 0 ? 'up' : 'down'} ${Math.abs(k.revenueChange)} percent vs the previous period.`
        : '')
    );

    // Orders
    parts.push(
      `Total orders: ${k.totalOrders}.` +
      (k.newToday > 0 ? ` ${k.newToday} new order${k.newToday !== 1 ? 's' : ''} placed today.` : ' No new orders today yet.')
    );

    // Avg order
    parts.push(
      `Average order value: ${fmt(k.avgOrderValue)}.` +
      (k.avgChange != null
        ? ` ${k.avgChange >= 0 ? 'Up' : 'Down'} ${Math.abs(k.avgChange)} percent vs the previous period.`
        : '')
    );

    // Stock
    if (k.lowStockCount > 0) {
      parts.push(`Attention: ${k.lowStockCount} product${k.lowStockCount !== 1 ? 's are' : ' is'} low on stock.`);
    } else {
      parts.push('All products are well stocked.');
    }

    // Orders by status
    const s = _lastDashData.ordersByStatus;
    if (s) {
      const statusParts = [];
      if (s.Paid)       statusParts.push(`${s.Paid} paid`);
      if (s.Processing) statusParts.push(`${s.Processing} in processing`);
      if (s.Shipped)    statusParts.push(`${s.Shipped} shipped`);
      if (s.Other)      statusParts.push(`${s.Other} other`);
      if (statusParts.length) parts.push(`Orders by status: ${statusParts.join(', ')}.`);
    }

    // Top product
    const tp = _lastDashData.topProducts;
    if (tp && tp.length > 0) {
      parts.push(`Top product: "${tp[0].name}" with ${tp[0].quantity} unit${tp[0].quantity !== 1 ? 's' : ''} sold and ${fmt(tp[0].revenue)} in revenue.`);
    }

    // Abandoned orders
    const ab = _lastDashData.abandonedOrders;
    if (ab && ab.length > 0) {
      parts.push(`${ab.length} abandoned order${ab.length !== 1 ? 's' : ''} in the last 30 days with recovery potential.`);
    }

    // Processing
    const pr = _lastDashData.processingOrders;
    if (pr && pr.length > 0) {
      parts.push(`${pr.length} order${pr.length !== 1 ? 's are' : ' is'} currently in processing and need${pr.length === 1 ? 's' : ''} to be prepared.`);
    }
  } else {
    parts.push('Dashboard data has not loaded yet. Please wait a moment and try again.');
  }

  parts.push('End of summary.');
  return parts.join(' ');
}

function speakSummary() {
  if (!('speechSynthesis' in window)) {
    alert('Text-to-speech is not supported in this browser.');
    return;
  }
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    _updateVoiceBtn(false);
    return;
  }

  const text = buildDashSummaryText();
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 0.95;
  utt.pitch  = 1.05;
  utt.volume = 1.0;

  const trySpeak = () => {
    const voice = _getBestVoice();
    if (voice) utt.voice = voice;
    utt.onstart = () => _updateVoiceBtn(true);
    utt.onend   = () => _updateVoiceBtn(false);
    utt.onerror = () => _updateVoiceBtn(false);
    window.speechSynthesis.speak(utt);
  };

  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.addEventListener('voiceschanged', trySpeak, { once: true });
  } else {
    trySpeak();
  }
}

document.getElementById('voiceBtn').addEventListener('click', speakSummary);
