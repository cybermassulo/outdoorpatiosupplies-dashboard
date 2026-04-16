'use strict';

let revenueChart = null;
let statusChart  = null;
let currentDays  = 30;

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

  // Low stock
  document.getElementById('kpiLowStock').textContent = kpis.lowStockCount ?? 0;
  const stockEl = document.getElementById('kpiStockStatus');
  if (kpis.lowStockCount > 0) {
    stockEl.className = 'kpi-change warning';
    stockEl.textContent = 'Action needed';
  } else {
    stockEl.className = 'kpi-change positive';
    stockEl.textContent = 'All stocked';
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
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#94a3b8', font: { size: 18 } },
        },
        yRev: {
          position: 'left',
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            color: '#94a3b8',
            font:  { size: 18 },
            callback: v => `$${(v / 1000).toFixed(1)}k`,
          },
        },
        yOrd: {
          position: 'right',
          grid:  { drawOnChartArea: false },
          ticks: { color: '#94a3b8', font: { size: 18 }, precision: 0 },
        },
      },
    },
  });
}

function renderStatusChart(statusData) {
  const COLOR_MAP = {
    Paid:       '#3b82f6',
    Processing: '#1d4ed8',
    Shipped:    '#14b8a6',
    Other:      '#475569',
    Pending:    '#475569',
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
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.parsed} orders`,
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
  list.innerHTML = orders.map(o => `
    <li class="stock-item">
      <span class="rank-num">#${esc(o.id)}</span>
      <span class="stock-name">${esc(o.description)}</span>
      <span class="badge ${badgeClass(o.status)}">${esc(o.status)}</span>
      <span class="rev-blue">${fmt(o.total)}</span>
    </li>
  `).join('');
}

function renderAbandonedOrders(orders) {
  const list = document.getElementById('abandonedOrdersList');
  if (!list) return;
  if (!orders?.length) {
    list.innerHTML = '<li style="color:var(--muted);padding:12px 0">✅ Nenhum pedido abandonado — timo!</li>';
    return;
  }
  list.innerHTML = orders.map(o => `
    <li class="stock-item">
      <span class="stock-name" title="${esc(o.email)}">${esc(o.customer)}<small>#${esc(o.id)} &middot; ${esc(o.product)}</small></span>
      <span class="rev-red">${fmt(o.total)}</span>
    </li>
  `).join('');
}

function renderProcessingOrders(orders) {
  const list = document.getElementById('processingOrdersList');
  if (!list) return;
  if (!orders?.length) {
    list.innerHTML = '<li style="color:var(--muted);padding:12px 0">✅ Nenhum pedido em processamento.</li>';
    return;
  }
  list.innerHTML = orders.map(o => `
    <li class="stock-item">
      <span class="stock-name">${esc(o.customer)}<small>#${esc(o.id)} &middot; ${esc(o.product)}</small></span>
      <span class="rev-orange">${fmt(o.total)}</span>
    </li>
  `).join('');
}

function renderTopProducts(products) {
  const list = document.getElementById('topProductsList');
  if (!list) return;
  if (!products?.length) {
    list.innerHTML = '<li style="color:var(--muted);padding:12px 0">No sales data for this period</li>';
    return;
  }
  list.innerHTML = products.map((p, i) => `
    <li class="stock-item">
      <span class="rank-num">#${i + 1}</span>
      <span class="stock-name">${esc(p.name)}</span>
      <span class="stock-qty">${p.quantity}</span>
      <span class="top-rev">${fmt(p.revenue)}</span>
    </li>
  `).join('');
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
