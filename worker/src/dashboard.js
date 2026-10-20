/**
 * TabPOS 云端远程经营看板 (Web Companion Dashboard)
 * 纯原生 HTML5 + CSS3 + Vanilla JS，零外部依赖，极速轻量，针对手机移动端与平板全面优化。
 */

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, function(m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
  });
}

export function renderDashboardHtml(shop = {}, cfg = {}) {
  const storeName = shop.name || "TabPOS 云端看板";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#0b0f19">
  <title>${escapeHtml(storeName)} - 远程经营看板</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #131b2e;
      --card-hover: #1a243d;
      --border: #1f293d;
      --border-light: #2d3c59;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --primary: #10b981;
      --primary-dim: rgba(16, 185, 129, 0.15);
      --accent: #3b82f6;
      --accent-dim: rgba(59, 130, 246, 0.15);
      --warning: #f59e0b;
      --warning-dim: rgba(245, 158, 11, 0.15);
      --danger: #ef4444;
      --danger-dim: rgba(239, 68, 68, 0.15);
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      padding-bottom: 40px;
    }
    .header {
      background: rgba(19, 27, 46, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 50;
      padding: 12px 16px;
    }
    .header-inner {
      max-width: 1100px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-logo {
      width: 34px;
      height: 34px;
      background: linear-gradient(135deg, #10b981, #059669);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 18px;
      color: #fff;
      box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
    }
    .brand-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text);
      line-height: 1.2;
    }
    .brand-subtitle {
      font-size: 11px;
      color: var(--text-muted);
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn-icon {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s;
    }
    .btn-icon:hover {
      background: var(--card-hover);
      color: var(--text);
      border-color: var(--border-light);
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .status-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 12px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .dot-green { background: #10b981; box-shadow: 0 0 8px #10b981; }
    .dot-yellow { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }
    .dot-red { background: #ef4444; box-shadow: 0 0 8px #ef4444; }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }
    @media (min-width: 768px) {
      .kpi-grid { grid-template-columns: repeat(4, 1fr); }
    }
    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
      position: relative;
      overflow: hidden;
    }
    .kpi-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: transparent;
    }
    .kpi-card.green::before { background: var(--primary); }
    .kpi-card.blue::before { background: var(--accent); }
    .kpi-card.amber::before { background: var(--warning); }
    .kpi-card.purple::before { background: #a855f7; }
    .kpi-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .kpi-value {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: var(--text);
      line-height: 1.1;
      margin-bottom: 4px;
    }
    .kpi-sub {
      font-size: 11px;
      color: var(--text-dim);
    }

    /* Section Cards */
    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section-tag {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(255,255,255,0.06);
      color: var(--text-muted);
    }

    /* Active Tables Grid */
    .tables-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 10px;
    }
    .table-item {
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: transform 0.15s, border-color 0.15s;
    }
    .table-item:hover {
      border-color: var(--border-light);
      transform: translateY(-2px);
    }
    .table-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .table-name {
      font-weight: 700;
      font-size: 15px;
      color: var(--text);
    }
    .table-timer {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }
    .timer-green { background: var(--primary-dim); color: #34d399; }
    .timer-amber { background: var(--warning-dim); color: #fbbf24; }
    .timer-red { background: var(--danger-dim); color: #f87171; }
    .table-meta {
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
    }
    .table-amount {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary);
      text-align: right;
    }

    /* Hourly Chart */
    .chart-container {
      height: 140px;
      display: flex;
      align-items: flex-end;
      gap: 4px;
      padding-top: 10px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 4px;
      overflow-x: auto;
    }
    .chart-bar-wrap {
      flex: 1;
      min-width: 14px;
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      justify-content: flex-end;
      position: relative;
    }
    .chart-bar {
      width: 100%;
      background: linear-gradient(180deg, #3b82f6, #1d4ed8);
      border-radius: 3px 3px 0 0;
      transition: height 0.3s ease;
      min-height: 2px;
    }
    .chart-bar.peak {
      background: linear-gradient(180deg, #10b981, #059669);
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.4);
    }
    .chart-label {
      font-size: 9px;
      color: var(--text-dim);
      margin-top: 4px;
    }

    /* Rank List */
    .rank-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .rank-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .rank-item:last-child { border-bottom: none; }
    .rank-num {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: rgba(255,255,255,0.06);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      flex-shrink: 0;
    }
    .rank-1 { background: #eab308; color: #000; }
    .rank-2 { background: #94a3b8; color: #000; }
    .rank-3 { background: #b45309; color: #fff; }
    .rank-info {
      flex: 1;
      min-width: 0;
    }
    .rank-name {
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rank-bar-bg {
      height: 4px;
      background: rgba(255,255,255,0.06);
      border-radius: 2px;
      margin-top: 4px;
      overflow: hidden;
    }
    .rank-bar-fill {
      height: 100%;
      background: var(--primary);
      border-radius: 2px;
    }
    .rank-stat {
      text-align: right;
      flex-shrink: 0;
    }
    .rank-qty {
      font-size: 12px;
      font-weight: 700;
      color: var(--text);
    }
    .rank-amount {
      font-size: 11px;
      color: var(--text-dim);
    }

    /* Two column grid on desktop */
    .two-col {
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
    }
    @media (min-width: 768px) {
      .two-col { grid-template-columns: 1fr 1fr; }
    }

    /* Staff chips */
    .staff-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .staff-chip {
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 6px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    .staff-role {
      font-size: 10px;
      background: var(--accent-dim);
      color: #60a5fa;
      padding: 2px 6px;
      border-radius: 10px;
    }

    /* Remote Control Section */
    .control-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .control-row:last-child { border-bottom: none; }
    .btn-toggle {
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .btn-toggle.active {
      background: var(--primary-dim);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .btn-toggle.paused {
      background: var(--warning-dim);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    /* Key Auth Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(11, 15, 25, 0.85);
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      z-index: 100;
    }
    .modal-card {
      background: var(--card-bg);
      border: 1px solid var(--border-light);
      border-radius: 12px;
      width: 100%;
      max-width: 360px;
      padding: 24px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      text-align: center;
    }
    .modal-title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .modal-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 16px;
      line-height: 1.4;
    }
    .input-key {
      width: 100%;
      background: rgba(0,0,0,0.3);
      border: 1px solid var(--border-light);
      border-radius: 8px;
      padding: 10px 14px;
      color: #fff;
      font-size: 14px;
      margin-bottom: 12px;
      outline: none;
    }
    .input-key:focus {
      border-color: var(--primary);
    }
    .btn-submit {
      width: 100%;
      background: var(--primary);
      color: #000;
      border: none;
      padding: 10px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }
    .toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #1e293b;
      color: #fff;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      display: none;
      z-index: 200;
    }
    .empty-placeholder {
      text-align: center;
      color: var(--text-dim);
      font-size: 12px;
      padding: 20px 0;
    }
  </style>
</head>
<body>

  <!-- Key Authentication Modal -->
  <div id="authModal" class="modal-overlay" style="display: none;">
    <div class="modal-card">
      <div style="font-size: 32px; margin-bottom: 12px;">🔑</div>
      <div class="modal-title">TabPOS 远程经营看板</div>
      <div class="modal-desc">请输入店铺管理口令 (Site Publish Key) 以查看实时营收与营业数据。</div>
      <input type="password" id="keyInput" class="input-key" placeholder="输入通信口令" autofocus>
      <button class="btn-submit" onclick="submitAuthKey()">验证并进入看板</button>
      <div id="authError" style="color: var(--danger); font-size: 11px; margin-top: 8px; display: none;"></div>
    </div>
  </div>

  <!-- Header -->
  <header class="header">
    <div class="header-inner">
      <div class="brand">
        <div class="brand-logo">T</div>
        <div>
          <div class="brand-title" id="shopNameDisplay">${escapeHtml(storeName)}</div>
          <div class="brand-subtitle">远程经营数据看板 · 实时同步</div>
        </div>
      </div>
      <div class="header-actions">
        <button class="btn-icon" onclick="loadDashboardData(true)">
          <span>🔄</span> <span class="hide-mobile">刷新</span>
        </button>
        <button class="btn-icon" onclick="logoutKey()">
          <span>⚙️</span> <span class="hide-mobile">退出</span>
        </button>
      </div>
    </div>
  </header>

  <!-- Main Content Container -->
  <main class="container">

    <!-- Status Strip -->
    <div class="status-strip">
      <div class="status-badge" id="heartbeatStatus">
        <div class="dot dot-green" id="heartbeatDot"></div>
        <span id="heartbeatText">正在连接 POS 设备…</span>
      </div>
      <div style="color: var(--text-muted); font-size: 11px;" id="deviceInfoText">
        版本: -- · 打印机: --
      </div>
    </div>

    <!-- KPI Grid -->
    <div class="kpi-grid">
      <div class="kpi-card green">
        <div class="kpi-label">今日总实收 (Gross) <span>💵</span></div>
        <div class="kpi-value" id="grossValue">$0.00</div>
        <div class="kpi-sub" id="grossSub">现金 $0.00 · 刷卡 $0.00</div>
      </div>
      <div class="kpi-card blue">
        <div class="kpi-label">今日总单数 (Orders) <span>🧾</span></div>
        <div class="kpi-value" id="ordersValue">0 单</div>
        <div class="kpi-sub" id="ordersSub">堂食 0 · 外带 0</div>
      </div>
      <div class="kpi-card amber">
        <div class="kpi-label">平均客单价 (Avg Ticket) <span>🎯</span></div>
        <div class="kpi-value" id="avgTicketValue">$0.00</div>
        <div class="kpi-sub">基于非作废完成订单</div>
      </div>
      <div class="kpi-card purple">
        <div class="kpi-label">实时用餐桌台 (Active) <span>🪑</span></div>
        <div class="kpi-value" id="activeTablesCount">0 桌</div>
        <div class="kpi-sub" id="activeGuestsCount">共 0 位客人在店</div>
      </div>
    </div>

    <!-- Active Tables Grid -->
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">
          <span>🪑</span> 当前在店用餐桌台
        </div>
        <div class="section-tag" id="activeTablesTag">0 桌正在用餐</div>
      </div>
      <div class="tables-grid" id="tablesContainer">
        <div class="empty-placeholder">当前店内暂无在席桌台 (全部空闲)</div>
      </div>
    </div>

    <!-- Hourly Sales Trend Chart -->
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">
          <span>📊</span> 今日各时段营收走势
        </div>
        <div class="section-tag" id="peakHourTag">最高峰: --</div>
      </div>
      <div class="chart-container" id="chartContainer">
        <!-- Bars dynamically generated -->
      </div>
    </div>

    <!-- Two Columns: Top Items & Category / Payment Breakdown -->
    <div class="two-col">

      <!-- Top Selling Dishes -->
      <div class="section-card">
        <div class="section-header">
          <div class="section-title">
            <span>🏆</span> 今日热销菜品 Top 10
          </div>
          <div class="section-tag">销量排行</div>
        </div>
        <div class="rank-list" id="topItemsContainer">
          <div class="empty-placeholder">暂无今日菜品销售明细</div>
        </div>
      </div>

      <!-- Categories & Staff & Remote Control -->
      <div style="display: flex; flex-direction: column; gap: 16px;">

        <!-- Categories Breakdown -->
        <div class="section-card">
          <div class="section-header">
            <div class="section-title">
              <span>🏷️</span> 分类销售额占比
            </div>
          </div>
          <div class="rank-list" id="categoriesContainer">
            <div class="empty-placeholder">暂无分类统计</div>
          </div>
        </div>

        <!-- On-Duty Staff -->
        <div class="section-card">
          <div class="section-header">
            <div class="section-title">
              <span>👥</span> 今日在岗员工工时
            </div>
            <div class="section-tag" id="activeStaffTag">0 人在岗</div>
          </div>
          <div class="staff-grid" id="staffContainer">
            <div class="empty-placeholder">当前暂无员工上班打卡记录</div>
          </div>
        </div>

        <!-- Device & Remote Control -->
        <div class="section-card">
          <div class="section-header">
            <div class="section-title">
              <span>⚙️</span> POS 设备与远程管控
            </div>
          </div>
          <div class="control-row">
            <div>
              <div style="font-size: 13px; font-weight: 600;">外卖网订接单开关</div>
              <div style="font-size: 11px; color: var(--text-dim);" id="intakeDesc">控制点单网站是否继续接单</div>
            </div>
            <button class="btn-toggle active" id="btnToggleIntake" onclick="toggleOnlineOrders()">
              <span id="intakeIndicator">🟢</span> <span id="intakeText">接单中</span>
            </button>
          </div>
          <div class="control-row">
            <div>
              <div style="font-size: 13px; font-weight: 600;">免密直通书签</div>
              <div style="font-size: 11px; color: var(--text-dim);">复制包含当前口令的快捷访问链接</div>
            </div>
            <button class="btn-icon" onclick="copyOneTapUrl()">
              <span>📋</span> 复制链接
            </button>
          </div>
        </div>

      </div>

    </div>

  </main>

  <div id="toast" class="toast"></div>

  <script>
    let currentKey = "";
    let currentState = null;

    function escapeHtml(str) {
      return (str || '').replace(/[&<>"']/g, function(m) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
      });
    }

    function showToast(msg) {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.style.display = "block";
      setTimeout(() => { t.style.display = "none"; }, 2500);
    }

    // Auth Initialization
    function initAuth() {
      const urlParams = new URLSearchParams(window.location.search);
      const queryKey = urlParams.get("key");
      if (queryKey) {
        currentKey = queryKey.trim();
        localStorage.setItem("tabpos_agent_key", currentKey);
        // Clean URL to prevent key leakage in address bar
        window.history.replaceState({}, document.title, window.location.pathname);
      } else {
        currentKey = localStorage.getItem("tabpos_agent_key") || "";
      }

      if (!currentKey) {
        document.getElementById("authModal").style.display = "flex";
      } else {
        loadDashboardData();
      }
    }

    async function submitAuthKey() {
      const input = document.getElementById("keyInput").value.trim();
      const err = document.getElementById("authError");
      if (!input) return;
      try {
        const res = await fetch("/api/report/verify", {
          headers: { "x-agent-key": input }
        });
        const data = await res.json();
        if (data.ok) {
          currentKey = input;
          localStorage.setItem("tabpos_agent_key", currentKey);
          document.getElementById("authModal").style.display = "none";
          loadDashboardData();
        } else {
          err.textContent = "口令错误，请重新输入";
          err.style.display = "block";
        }
      } catch (e) {
        err.textContent = "验证失败: " + e.message;
        err.style.display = "block";
      }
    }

    function logoutKey() {
      if (confirm("确定要退出当前看板登录吗？")) {
        localStorage.removeItem("tabpos_agent_key");
        location.reload();
      }
    }

    function copyOneTapUrl() {
      if (!currentKey) return;
      const url = window.location.origin + window.location.pathname + "?key=" + encodeURIComponent(currentKey);
      navigator.clipboard.writeText(url).then(() => {
        showToast("免密直通链接已复制到剪贴板");
      }).catch(() => {
        showToast("复制失败，请手动复制");
      });
    }

    // Load Data from Worker
    async function loadDashboardData(manual = false) {
      if (!currentKey) return;
      try {
        const res = await fetch("/api/pos/state", {
          headers: { "x-agent-key": currentKey }
        });
        if (res.status === 403) {
          document.getElementById("authModal").style.display = "flex";
          return;
        }
        const data = await res.json();
        if (data.ok && data.state) {
          currentState = data.state;
          renderDashboard(data.state);
          if (manual) showToast("数据已刷新");
        } else {
          renderOfflineNotice();
        }
      } catch (e) {
        console.error("Dashboard fetch error:", e);
      }
    }

    function renderDashboard(state) {
      const today = state.today || {};
      const now = Date.now();
      const stateAt = state.at || 0;
      const ageMinutes = Math.floor((now - stateAt) / 60000);

      // Heartbeat
      const dot = document.getElementById("heartbeatDot");
      const text = document.getElementById("heartbeatText");
      if (ageMinutes < 10) {
        dot.className = "dot dot-green";
        text.textContent = "🟢 POS 在线 · " + (ageMinutes <= 1 ? "刚刚同步" : ageMinutes + " 分钟前更新");
      } else if (ageMinutes < 30) {
        dot.className = "dot dot-yellow";
        text.textContent = "🟡 同步稍有延迟 · " + ageMinutes + " 分钟前";
      } else {
        dot.className = "dot dot-red";
        text.textContent = "🔴 POS 离线 · " + ageMinutes + " 分钟前";
      }

      // Shop Name
      if (state.companyName) {
        document.getElementById("shopNameDisplay").textContent = state.companyName;
      }

      // Device info
      const devText = "设备: " + (state.device || state.model || "POS") + " · 版本: " + (state.versionName || "v2.x") + " · 打印机: " + (state.selectedPrinter ? "已配置" : "未选");
      document.getElementById("deviceInfoText").textContent = devText;

      // KPIs
      const gross = today.gross != null ? today.gross : (state.gross || 0);
      const orders = today.orderCount != null ? today.orderCount : (state.orderCount || 0);
      const cash = today.cashCollected != null ? today.cashCollected : (state.cashCollected || 0);
      const card = Math.max(0, Math.round((gross - cash) * 100) / 100);
      const avgTicket = today.avgTicket != null ? today.avgTicket : (orders > 0 ? (gross / orders).toFixed(2) : "0.00");
      const dineIn = today.dineInCount != null ? today.dineInCount : (state.dineInCount || 0);
      const pickup = today.pickupCount != null ? today.pickupCount : (state.pickupCount || 0);

      document.getElementById("grossValue").textContent = "$" + Number(gross).toFixed(2);
      document.getElementById("grossSub").textContent = "现金 $" + Number(cash).toFixed(2) + " · 刷卡 $" + Number(card).toFixed(2);
      document.getElementById("ordersValue").textContent = orders + " 单";
      document.getElementById("ordersSub").textContent = "堂食 " + dineIn + " · 外带 " + pickup;
      document.getElementById("avgTicketValue").textContent = "$" + Number(avgTicket).toFixed(2);

      // Active Tables
      const activeTables = today.activeTables || [];
      const totalGuests = activeTables.reduce((acc, t) => acc + (t.guests || 1), 0);
      document.getElementById("activeTablesCount").textContent = activeTables.length + " 桌";
      document.getElementById("activeGuestsCount").textContent = "共 " + totalGuests + " 位客人在店";
      document.getElementById("activeTablesTag").textContent = activeTables.length + " 桌正在用餐";

      const tablesContainer = document.getElementById("tablesContainer");
      if (activeTables.length === 0) {
        tablesContainer.innerHTML = '<div class="empty-placeholder">当前店内暂无在席桌台 (全部空闲)</div>';
      } else {
        tablesContainer.innerHTML = activeTables.map(t => {
          const min = t.seatedMinutes || 0;
          let timerClass = "timer-green";
          if (min >= 75) timerClass = "timer-red";
          else if (min >= 45) timerClass = "timer-amber";

          return '<div class="table-item">' +
            '<div class="table-head">' +
              '<span class="table-name">' + escapeHtml(t.table || "未排座") + '</span>' +
              '<span class="table-timer ' + timerClass + '">⏱️ ' + min + 'm</span>' +
            '</div>' +
            '<div class="table-meta">' +
              '<span>👥 ' + (t.guests || 1) + ' 人</span>' +
              '<span>' + (t.itemCount || 0) + ' 道菜</span>' +
            '</div>' +
            '<div class="table-amount">$' + Number(t.total || 0).toFixed(2) + '</div>' +
          '</div>';
        }).join('');
      }

      // Hourly Sales Chart
      const hourly = today.hourly || [];
      const chartContainer = document.getElementById("chartContainer");
      if (hourly.length > 0) {
        const maxGross = Math.max(...hourly.map(h => h.gross || 0), 1);
        let peakHour = 0;
        let peakSales = 0;
        hourly.forEach(h => {
          if ((h.gross || 0) > peakSales) {
            peakSales = h.gross;
            peakHour = h.hour;
          }
        });
        document.getElementById("peakHourTag").textContent = "最高峰: " + peakHour + ":00 ($" + peakSales.toFixed(2) + ")";

        chartContainer.innerHTML = hourly.map(h => {
          const pct = Math.max(2, Math.round(((h.gross || 0) / maxGross) * 100));
          const isPeak = h.hour === peakHour && peakSales > 0;
          return '<div class="chart-bar-wrap" title="' + h.hour + ':00 - ' + (h.count || 0) + ' 单 · $' + Number(h.gross || 0).toFixed(2) + '">' +
            '<div class="chart-bar ' + (isPeak ? 'peak' : '') + '" style="height: ' + pct + '%;"></div>' +
            '<div class="chart-label">' + h.hour + '</div>' +
          '</div>';
        }).join('');
      } else {
        chartContainer.innerHTML = '<div class="empty-placeholder" style="width: 100%;">暂无各时段销售走势</div>';
      }

      // Top Items
      const topItems = today.topItems || [];
      const topContainer = document.getElementById("topItemsContainer");
      if (topItems.length > 0) {
        const maxQty = Math.max(...topItems.map(i => i.qty || 1), 1);
        topContainer.innerHTML = topItems.map((item, idx) => {
          let rankClass = "";
          if (idx === 0) rankClass = "rank-1";
          else if (idx === 1) rankClass = "rank-2";
          else if (idx === 2) rankClass = "rank-3";
          const pct = Math.max(5, Math.round(((item.qty || 0) / maxQty) * 100));

          return '<div class="rank-item">' +
            '<div class="rank-num ' + rankClass + '">' + (idx + 1) + '</div>' +
            '<div class="rank-info">' +
              '<div class="rank-name">' + escapeHtml(item.name || "菜品") + '</div>' +
              '<div class="rank-bar-bg"><div class="rank-bar-fill" style="width: ' + pct + '%;"></div></div>' +
            '</div>' +
            '<div class="rank-stat">' +
              '<div class="rank-qty">' + (item.qty || 0) + ' 份</div>' +
              '<div class="rank-amount">$' + Number(item.amount || 0).toFixed(2) + '</div>' +
            '</div>' +
          '</div>';
        }).join('');
      } else {
        topContainer.innerHTML = '<div class="empty-placeholder">暂无今日菜品销售明细</div>';
      }

      // Categories
      const categories = today.categories || [];
      const catContainer = document.getElementById("categoriesContainer");
      if (categories.length > 0) {
        const maxCatGross = Math.max(...categories.map(c => c.gross || 1), 1);
        catContainer.innerHTML = categories.map(cat => {
          const pct = Math.max(5, Math.round(((cat.gross || 0) / maxCatGross) * 100));
          return '<div class="rank-item">' +
            '<div class="rank-info">' +
              '<div class="rank-name">' + escapeHtml(cat.category || "未分类") + '</div>' +
              '<div class="rank-bar-bg"><div class="rank-bar-fill" style="width: ' + pct + '%; background: var(--accent);"></div></div>' +
            '</div>' +
            '<div class="rank-stat">' +
              '<div class="rank-qty">$' + Number(cat.gross || 0).toFixed(2) + '</div>' +
              '<div class="rank-amount">' + (cat.count || 0) + ' 单</div>' +
            '</div>' +
          '</div>';
        }).join('');
      } else {
        catContainer.innerHTML = '<div class="empty-placeholder">暂无分类统计</div>';
      }

      // Active Staff
      const staffList = today.activeStaff || [];
      const staffContainer = document.getElementById("staffContainer");
      document.getElementById("activeStaffTag").textContent = staffList.length + " 人在岗";
      if (staffList.length > 0) {
        staffContainer.innerHTML = staffList.map(s => {
          const durH = Math.floor((s.durationMinutes || 0) / 60);
          const durM = (s.durationMinutes || 0) % 60;
          const durText = (durH > 0 ? durH + "h " : "") + durM + "m";
          return '<div class="staff-chip">' +
            '<span>🟢</span>' +
            '<span style="font-weight: 600;">' + escapeHtml(s.userName || "员工") + '</span>' +
            '<span class="staff-role">' + escapeHtml(s.role || "Staff") + '</span>' +
            '<span style="color: var(--text-dim);">' + durText + '</span>' +
          '</div>';
        }).join('');
      } else {
        staffContainer.innerHTML = '<div class="empty-placeholder">当前暂无员工上班打卡记录</div>';
      }

      // Online intake button
      const intakeOn = state.onlineOrdersEnabled !== false && state.intakeOn !== false;
      const btn = document.getElementById("btnToggleIntake");
      const ind = document.getElementById("intakeIndicator");
      const txt = document.getElementById("intakeText");
      if (intakeOn) {
        btn.className = "btn-toggle active";
        ind.textContent = "🟢";
        txt.textContent = "接单中 (点击暂停)";
      } else {
        btn.className = "btn-toggle paused";
        ind.textContent = "⏸️";
        txt.textContent = "已暂停 (点击开启)";
      }
    }

    function renderOfflineNotice() {
      document.getElementById("heartbeatDot").className = "dot dot-red";
      document.getElementById("heartbeatText").textContent = "🔴 POS 离线 · 等待设备连接";
    }

    async function toggleOnlineOrders() {
      if (!currentState) return;
      const curOn = currentState.onlineOrdersEnabled !== false && currentState.intakeOn !== false;
      const targetState = !curOn;
      const confirmMsg = targetState ? "确定要恢复线上接单吗？" : "确定要暂停线上接单吗？网站将临时关闭下单入口。";
      if (!confirm(confirmMsg)) return;

      try {
        const res = await fetch("/api/pos/command", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-agent-key": currentKey
          },
          body: JSON.stringify({
            cmd: "set_setting",
            args: { key: "onlineOrdersEnabled", value: String(targetState) }
          })
        });
        const d = await res.json();
        if (d.ok) {
          showToast("指令已下发，POS 将在 4 秒内同步生效");
          currentState.onlineOrdersEnabled = targetState;
          currentState.intakeOn = targetState;
          renderDashboard(currentState);
        } else {
          showToast("下发失败: " + d.error);
        }
      } catch (e) {
        showToast("请求失败: " + e.message);
      }
    }

    // Initialize and Auto-refresh every 30 seconds
    initAuth();
    setInterval(() => {
      loadDashboardData();
    }, 30000);
  </script>
</body>
</html>
`;
}
