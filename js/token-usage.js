// ============ 📊 全局 Token 使用统计 ============
// 【模块定位】汇总所有对话中的 chat.tokenStats，按模型统计 token / 费用 / 请求数趋势
// 数据来源：tokens.js 的 recordUsageFromResponse()，与对话顶部 Token 统计一致。

function openTokenUsageStats() {
  let modal = document.getElementById('tokenUsageModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tokenUsageModal';
    modal.className = 'modal-mask token-usage-modal';
    modal.innerHTML = `
      <div class="modal wide" style="max-width:980px;">
        <h2>📊 Token 使用统计 <button class="modal-close" onclick="closeTokenUsageStats()">×</button></h2>
        <div id="tokenUsageContent"></div>
        <div class="modal-footer">
          <button class="btn" onclick="renderTokenUsageStats()">🔄 刷新</button>
          <button class="btn btn-warning" onclick="resetTokenUsageLedger()">🗑 清空统计账本</button>
          <button class="btn" onclick="closeTokenUsageStats()">关闭</button>
        </div>
      </div>`;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeTokenUsageStats();
    });
    document.body.appendChild(modal);
  }
  renderTokenUsageStats();
  modal.classList.add('show');
}

function closeTokenUsageStats() {
  const modal = document.getElementById('tokenUsageModal');
  if (modal) modal.classList.remove('show');
}

function resetTokenUsageLedger() {
  if (!confirm('确定清空独立 Token 使用账本吗？\n\n这不会删除对话内容，也不会影响每个对话自身的 tokenStats。')) return;
  if (typeof saveTokenUsageLedger === 'function') saveTokenUsageLedger([]);
  renderTokenUsageStats();
  if (typeof toast === 'function') toast('✓ Token 使用账本已清空');
}

function _collectTokenUsageEvents() {
  // 统计页只读独立账本，不再依赖 state.chats。
  // 因此删除对话不会减少 Token 统计。
  if (typeof migrateChatTokenStatsToLedger === 'function') {
    try { migrateChatTokenStatsToLedger(); } catch (e) { console.warn('[token-usage] 迁移旧统计失败:', e); }
  }
  const ledger = (typeof loadTokenUsageLedger === 'function') ? loadTokenUsageLedger() : [];
  return ledger.map(ev => ({
    id: ev.id || '',
    chatId: ev.chatId || '',
    chatTitle: ev.chatTitle || '未命名对话',
    ts: ev.ts || Date.now(),
    model: ev.model || '未知模型',
    provider: ev.provider || '',
    inputTokens: Number(ev.inputTokens || 0),
    outputTokens: Number(ev.outputTokens || 0),
    cacheReadTokens: Number(ev.cacheReadTokens || 0),
    cacheCreateTokens: Number(ev.cacheCreateTokens || 0),
    thinkingTokens: Number(ev.thinkingTokens || 0),
    source: ev.source || 'usage',
    _legacy: !!ev._legacy,
    _requests: Number(ev._requests || 1)
  })).sort((a, b) => a.ts - b.ts);
}

function _tokenUsageCost(evOrAgg) {
  const model = evOrAgg.model || '未知模型';
  const pricing = (typeof getPricing === 'function')
    ? getPricing(model)
    : { input: 1.0, output: 3.0, cacheRead: 0.1, matched: null };
  const normalInput = Math.max(0, Number(evOrAgg.inputTokens || 0) - Number(evOrAgg.cacheReadTokens || 0));
  const costInput = normalInput * pricing.input / 1000000;
  const costCache = Number(evOrAgg.cacheReadTokens || 0) * pricing.cacheRead / 1000000;
  const costOutput = Number(evOrAgg.outputTokens || 0) * pricing.output / 1000000;
  return {
    usd: costInput + costCache + costOutput,
    pricing
  };
}

function _fmtTokenUsageMoney(usd) {
  const showCny = (typeof shouldShowCny === 'function') ? shouldShowCny() : true;
  const rate = (typeof getExchangeRate === 'function') ? getExchangeRate() : 7.2;
  const cny = usd * rate;
  return `$${usd.toFixed(6)}${showCny ? ` / ¥${cny.toFixed(4)}` : ''}`;
}

function _fmtTokenUsageDate(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function _fmtTokenUsageTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${_fmtTokenUsageDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _renderMiniBars(rows, labelKey, valueKey, maxRows = 14) {
  const top = rows.slice(-maxRows);
  const max = Math.max(1, ...top.map(r => r[valueKey] || 0));
  return top.map(r => {
    const v = r[valueKey] || 0;
    const w = Math.max(4, Math.round(v / max * 100));
    return `
      <div style="display:grid;grid-template-columns:110px 1fr 56px;gap:8px;align-items:center;margin:6px 0;font-size:12px;">
        <div style="color:var(--text-secondary);font-family:monospace;">${escapeHtml(r[labelKey])}</div>
        <div style="height:9px;background:var(--bg-input);border-radius:999px;overflow:hidden;">
          <div style="height:100%;width:${w}%;background:var(--accent);border-radius:999px;"></div>
        </div>
        <div style="text-align:right;font-family:monospace;">${v}</div>
      </div>`;
  }).join('') || `<div style="color:var(--text-secondary);font-size:12px;">暂无数据</div>`;
}

function _todayTokenUsageDateValue() {
  return _fmtTokenUsageDate(Date.now());
}

function _getTokenUsageSelectedDate() {
  if (!window._tokenUsageSelectedDate) window._tokenUsageSelectedDate = _todayTokenUsageDateValue();
  return window._tokenUsageSelectedDate;
}

function onTokenUsageDateChange(value) {
  window._tokenUsageSelectedDate = value || _todayTokenUsageDateValue();
  renderTokenUsageStats();
}

function _parseLocalDateStart(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return new Date(new Date().setHours(0, 0, 0, 0));
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

function _renderRequestCurve(events, dateStr) {
  const start = _parseLocalDateStart(dateStr);
  const dayEnd = new Date(start.getTime() + 24 * 3600 * 1000);
  const now = new Date();
  const isToday = _fmtTokenUsageDate(start.getTime()) === _fmtTokenUsageDate(now.getTime());
  const end = isToday ? new Date(Math.min(now.getTime(), dayEnd.getTime())) : dayEnd;

  // 以 1 小时为一个点。当天默认从 0 点到当前小时；历史日期显示完整 24 小时。
  const endHour = isToday ? Math.max(0, end.getHours()) : 23;
  const buckets = Array.from({ length: endHour + 1 }, (_, h) => ({ hour: h, requests: 0 }));
  for (const ev of events) {
    if (ev.ts < start.getTime() || ev.ts >= end.getTime()) continue;
    const h = new Date(ev.ts).getHours();
    if (h >= 0 && h < buckets.length) buckets[h].requests += ev._legacy ? (ev._requests || 1) : 1;
  }

  const width = 860, height = 260;
  const padL = 44, padR = 18, padT = 18, padB = 36;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const maxY = Math.max(1, ...buckets.map(b => b.requests));
  const denom = Math.max(1, buckets.length - 1);
  const x = i => padL + (i / denom) * plotW;
  const y = v => padT + plotH - (v / maxY) * plotH;
  const points = buckets.map((b, i) => `${x(i).toFixed(1)},${y(b.requests).toFixed(1)}`).join(' ');
  const areaPoints = `${padL},${padT + plotH} ${points} ${x(buckets.length - 1).toFixed(1)},${padT + plotH}`;
  const totalReq = buckets.reduce((s, b) => s + b.requests, 0);
  const xLabels = buckets
    .filter((_, i) => i === 0 || i === buckets.length - 1 || i % 3 === 0)
    .map((b, i, arr) => {
      const idx = buckets.indexOf(b);
      return `<text x="${x(idx).toFixed(1)}" y="${height - 12}" text-anchor="middle" class="tus-axis">${String(b.hour).padStart(2, '0')}:00</text>`;
    }).join('');
  const yLabels = [0, Math.ceil(maxY / 2), maxY].map(v => `
    <g>
      <line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${width - padR}" y2="${y(v).toFixed(1)}" class="tus-grid" />
      <text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="tus-axis">${v}</text>
    </g>`).join('');
  const dots = buckets.map((b, i) => `
    <circle cx="${x(i).toFixed(1)}" cy="${y(b.requests).toFixed(1)}" r="3" class="tus-dot">
      <title>${dateStr} ${String(b.hour).padStart(2, '0')}:00 - ${String(b.hour).padStart(2, '0')}:59，请求 ${b.requests} 次</title>
    </circle>`).join('');

  return `
    <div class="token-usage-chart-head">
      <div>
        <h3 style="font-size:15px;margin:0;">请求数随时间变化曲线</h3>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">范围：${escapeHtml(dateStr)} 00:00 → ${isToday ? '当前时间' : '24:00'}，合计 ${totalReq} 次请求</div>
      </div>
      <label class="token-usage-date-picker">
        <span>选择日期</span>
        <input type="date" value="${escapeHtml(dateStr)}" onchange="onTokenUsageDateChange(this.value)">
      </label>
    </div>
    <div class="token-usage-chart-wrap">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="请求数随时间变化曲线">
        <defs>
          <linearGradient id="tusAreaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="currentColor" stop-opacity="0.22" />
            <stop offset="100%" stop-color="currentColor" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        ${yLabels}
        <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" class="tus-axis-line" />
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" class="tus-axis-line" />
        <polygon points="${areaPoints}" class="tus-area" />
        <polyline points="${points}" class="tus-line" />
        ${dots}
        ${xLabels}
      </svg>
    </div>`;
}

function renderTokenUsageStats() {
  const el = document.getElementById('tokenUsageContent');
  if (!el) return;

  const events = _collectTokenUsageEvents();
  if (!events.length) {
    el.innerHTML = `
      <div class="json-help">暂无 Token 使用记录。发送请求并拿到 API usage 后，这里会自动汇总。</div>
    `;
    return;
  }

  const byModel = new Map();
  let total = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    thinkingTokens: 0,
    usd: 0
  };

  for (const ev of events) {
    const reqCount = ev._legacy ? (ev._requests || 1) : 1;
    const key = ev.model || '未知模型';
    if (!byModel.has(key)) {
      byModel.set(key, {
        model: key,
        provider: ev.provider || '',
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        thinkingTokens: 0,
        usd: 0,
        firstTs: ev.ts,
        lastTs: ev.ts
      });
    }
    const row = byModel.get(key);
    row.requests += reqCount;
    row.inputTokens += ev.inputTokens;
    row.outputTokens += ev.outputTokens;
    row.cacheReadTokens += ev.cacheReadTokens;
    row.cacheCreateTokens += ev.cacheCreateTokens;
    row.thinkingTokens += ev.thinkingTokens;
    row.firstTs = Math.min(row.firstTs, ev.ts);
    row.lastTs = Math.max(row.lastTs, ev.ts);
    row.usd += _tokenUsageCost(ev).usd;

    total.requests += reqCount;
    total.inputTokens += ev.inputTokens;
    total.outputTokens += ev.outputTokens;
    total.cacheReadTokens += ev.cacheReadTokens;
    total.cacheCreateTokens += ev.cacheCreateTokens;
    total.thinkingTokens += ev.thinkingTokens;
  }
  total.usd = [...byModel.values()].reduce((s, r) => s + r.usd, 0);

  const modelRows = [...byModel.values()].sort((a, b) => b.usd - a.usd || b.requests - a.requests);

  const selectedDate = _getTokenUsageSelectedDate();
  const latestEvents = events.slice(-12).reverse();
  const legacyCount = events.filter(e => e._legacy).length;

  el.innerHTML = `
    <style>
      .token-usage-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0;}
      .token-usage-card{background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:12px;}
      .token-usage-card .label{font-size:12px;color:var(--text-secondary);margin-bottom:6px;}
      .token-usage-card .value{font-size:18px;font-weight:700;font-family:monospace;}
      .token-usage-table{width:100%;border-collapse:collapse;font-size:12px;}
      .token-usage-table th,.token-usage-table td{padding:8px;border-bottom:1px solid var(--border);vertical-align:middle;}
      .token-usage-table th{text-align:left;color:var(--text-secondary);font-weight:600;background:var(--bg-input);}
      .token-usage-table td.num{text-align:right;font-family:monospace;white-space:nowrap;}
      .token-usage-section{margin-top:16px;}
      .token-usage-chart-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;}
      .token-usage-date-picker{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);}
      .token-usage-date-picker input{background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 8px;}
      .token-usage-chart-wrap{width:100%;overflow-x:auto;color:var(--accent);}
      .token-usage-chart-wrap svg{width:100%;min-width:720px;display:block;}
      .tus-grid{stroke:var(--border);stroke-width:1;opacity:.8;}
      .tus-axis-line{stroke:var(--text-secondary);stroke-width:1;opacity:.6;}
      .tus-axis{fill:var(--text-secondary);font-size:11px;font-family:monospace;}
      .tus-line{fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;}
      .tus-area{fill:url(#tusAreaGradient);color:var(--accent);}
      .tus-dot{fill:var(--bg);stroke:currentColor;stroke-width:2;}
      @media(max-width:900px){.token-usage-cards{grid-template-columns:repeat(2,minmax(0,1fr));}.token-usage-chart-head{align-items:flex-start;flex-direction:column;}}
    </style>

    <div class="json-help">
      数据来源：所有对话的 <code>tokenStats</code>，由 <code>recordUsageFromResponse()</code> 从 API 返回的 <code>usage</code> 字段累计，和对话中的 Token 统计来源一致。费用使用「定价管理」里的价格表估算。
      ${legacyCount ? `<br>⚠️ 有 ${legacyCount} 条旧版累计记录没有逐次模型信息，已归入「历史累计（未记录模型）」。` : ''}
    </div>

    <div class="token-usage-cards">
      <div class="token-usage-card"><div class="label">总请求数</div><div class="value">${formatNumber(total.requests)}</div></div>
      <div class="token-usage-card"><div class="label">输入 token</div><div class="value">${formatNumber(total.inputTokens)}</div></div>
      <div class="token-usage-card"><div class="label">输出 token</div><div class="value">${formatNumber(total.outputTokens)}</div></div>
      <div class="token-usage-card"><div class="label">估算费用</div><div class="value" style="font-size:15px;">${_fmtTokenUsageMoney(total.usd)}</div></div>
    </div>

    <div class="token-usage-section">
      <h3 style="font-size:15px;margin:0 0 10px;">按模型汇总</h3>
      <div style="max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:10px;">
        <table class="token-usage-table">
          <thead>
            <tr>
              <th>模型</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存读</th><th class="num">思考</th><th class="num">费用</th><th>时间范围</th>
            </tr>
          </thead>
          <tbody>
            ${modelRows.map(r => `
              <tr>
                <td><code>${escapeHtml(r.model)}</code></td>
                <td class="num">${formatNumber(r.requests)}</td>
                <td class="num">${formatNumber(r.inputTokens)}</td>
                <td class="num">${formatNumber(r.outputTokens)}</td>
                <td class="num">${formatNumber(r.cacheReadTokens)}</td>
                <td class="num">${formatNumber(r.thinkingTokens)}</td>
                <td class="num">${_fmtTokenUsageMoney(r.usd)}</td>
                <td style="font-size:11px;color:var(--text-secondary);white-space:nowrap;">${_fmtTokenUsageDate(r.firstTs)} → ${_fmtTokenUsageDate(r.lastTs)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="token-usage-section" style="background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:12px;">
      ${_renderRequestCurve(events, selectedDate)}
    </div>

    <div class="token-usage-section" style="background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:12px;">
      <h3 style="font-size:15px;margin:0 0 10px;">最近请求</h3>
        <div style="max-height:245px;overflow:auto;">
          ${latestEvents.map(ev => `
            <div style="display:grid;grid-template-columns:118px 1fr auto;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;align-items:center;">
              <span style="color:var(--text-secondary);font-family:monospace;">${_fmtTokenUsageTime(ev.ts)}</span>
              <span><code>${escapeHtml(ev.model)}</code></span>
              <span style="font-family:monospace;">${formatNumber(ev.inputTokens + ev.outputTokens)}</span>
            </div>`).join('')}
        </div>
    </div>
  `;
}
