// ============ 🧪 自动信标系统 + 上下文体检 ============
// 【模块定位】每隔 N 条用户消息塞入一条"记代号"隐藏消息，并提供体检功能
// 依赖：state.js / chat.js / api-core.js / utils.js
// 加载顺序：在 chat.js / tokens.js 之后

// ---- 代号生成器 ----
const BEACON_ADJECTIVES = [
  'NEPTUNE', 'PURPLE', 'THUNDER', 'CRIMSON', 'EMERALD', 'SAPPHIRE',
  'GOLDEN', 'SILVER', 'AMBER', 'JADE', 'CORAL', 'AZURE',
  'MIDNIGHT', 'SUNRISE', 'PHOENIX', 'DRAGON', 'TIGER', 'FALCON',
  'COMET', 'NEBULA', 'PULSAR', 'QUASAR', 'GALAXY', 'METEOR',
  'CYCLONE', 'BLIZZARD', 'TEMPEST', 'AURORA', 'ECLIPSE', 'ZENITH'
];

function _generateBeaconCode() {
  const adj = BEACON_ADJECTIVES[Math.floor(Math.random() * BEACON_ADJECTIVES.length)];
  const num = Math.floor(1000 + Math.random() * 9000); // 4 位数字
  return `${adj}-${num}`;
}

// 确保新代号不和当前对话已有信标重复
function _generateUniqueBeaconCode(chat) {
  const existing = new Set(
    (chat.messages || [])
      .filter(m => m._isBeacon && m._beaconCode)
      .map(m => m._beaconCode)
  );
  for (let i = 0; i < 20; i++) {
    const code = _generateBeaconCode();
    if (!existing.has(code)) return code;
  }
  // 极端情况：加时间戳保证唯一
  return _generateBeaconCode() + '-' + Date.now().toString(36).slice(-3).toUpperCase();
}

// ⭐ 在用户消息插入后调用，决定是否要在本次顺便塞一个信标
//   策略：统计当前对话里**真实用户消息数**（不算信标），到达 interval 倍数就埋一个
//   返回值：是否塞入了新信标
function maybeInsertBeacon(chat) {
  const s = state.settings;
  if (!s.beaconEnabled) return false;
  const interval = Math.max(1, parseInt(s.beaconInterval) || 5);
  if (!chat || !chat.messages || !chat.messages.length) return false;
  
  // 统计已有的真实 user 消息数 + 已有的信标数
  let realUserCount = 0;
  let beaconCount = 0;
  for (const m of chat.messages) {
    if (m._isBeacon) {
      if (m.role === 'user') beaconCount++;
      continue;
    }
    if (m.role === 'user') realUserCount++;
  }
  
  // 应当存在的信标数 = floor(真实user数 / interval)
  // 注意：本次最新的 user 消息也已经插入，所以这里 realUserCount 包含它
  const targetBeaconCount = Math.floor(realUserCount / interval);
  if (beaconCount >= targetBeaconCount) return false;
  
  // 需要补埋（一般补 1 个）
  // 把信标插在"最新 user 消息之前"，这样位置上看起来是历史里出现的
  // 但实际上由于 _hiddenFromUI = true，用户看不到
  const code = _generateUniqueBeaconCode(chat);
  const seq = beaconCount + 1;
  const beaconUser = {
    role: 'user',
    content: `（系统记忆测试——这是隐藏的元指令，不要在正常回答中提起）请永久记住一个临时代号："${code}"。这是第 ${seq} 个代号。除非我之后明确询问"上下文体检"或"列出所有代号"，否则不要主动提及。请只回复一句"好的，已记住代号 ${code}"。`,
    _hiddenFromUI: true,
    _isBeacon: true,
    _beaconCode: code,
    _beaconSeq: seq,
    _beaconTime: Date.now()
  };
  const beaconAck = {
    role: 'assistant',
    content: `好的，已记住代号 ${code}。`,
    _hiddenFromUI: true,
    _isBeacon: true,
    _beaconAck: true,
    _beaconCode: code,
    _beaconSeq: seq,
    _beaconTime: Date.now(),
    _endTime: Date.now()
  };
  
  // 插入位置：当前最新的真实 user 消息之前
  let insertIdx = chat.messages.length;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (!m._isBeacon && m.role === 'user') {
      insertIdx = i;
      break;
    }
  }
  chat.messages.splice(insertIdx, 0, beaconUser, beaconAck);
  return true;
}

// ============ 🩺 体检流程 ============

// 判断是否为"工具流程"消息（中间步骤，不算真实对话）
//   - role==='tool'：工具返回结果
//   - assistant + tool_calls 非空：发起工具调用的中间助手消息（最终回答不带 tool_calls）
function _isToolFlowMessage(m) {
  if (!m) return false;
  if (m.role === 'tool') return true;
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) return true;
  return false;
}

// 收集当前对话中所有有效信标（按时间顺序）
//   positionPct 基于"真实对话消息序列"计算，工具调用 / tool_result / 信标本身均不计入分母，
//   避免重工具调用场景把所有信标都压缩到"开头"区段。
function _collectBeacons(chat) {
  if (!chat || !chat.messages) return [];
  const beacons = [];
  let realCount = 0;       // 已扫描到的"真实对话消息"数（不含信标、不含工具流程）
  let totalRealUser = 0;   // 已扫描到的真实 user 消息数（保留以兼容下游 realUserBefore）
  
  for (let i = 0; i < chat.messages.length; i++) {
    const m = chat.messages[i];
    
    // 信标：记录它在"真实消息流"中的插入位置
    if (m._isBeacon && m.role === 'user' && m._beaconCode) {
      beacons.push({
        code: m._beaconCode,
        seq: m._beaconSeq,
        time: m._beaconTime,
        msgIdx: i,             // 原数组下标（保留备用）
        realIdx: realCount,    // 在真实消息流中的位置
        positionPct: 0,        // 稍后填
        realUserBefore: totalRealUser
      });
      continue;
    }
    if (m._isBeacon) continue;          // 信标的 ack 消息也跳过
    if (_isToolFlowMessage(m)) continue; // 工具流程消息不计入位置分母
    
    // 真实对话消息（user 或 assistant 最终回答）
    realCount++;
    if (m.role === 'user') totalRealUser++;
  }
  
  // 计算 positionPct（基于真实消息流：0% = 对话最开头，100% = 最末尾）
  beacons.forEach(b => {
    b.positionPct = realCount > 1 ? Math.round((b.realIdx / (realCount - 1)) * 100) : 0;
  });
  return beacons;
}

// ⭐ 体检主入口
async function runHealthCheck() {
  const c = currentChat();
  if (!c || !c.messages.length) {
    toast('当前没有对话，无法体检');
    return;
  }
  if (state.isGenerating) {
    toast('当前正在生成，请稍候再体检');
    return;
  }
  
  const beacons = _collectBeacons(c);
  if (beacons.length === 0) {
    _showHealthCheckResult({
      empty: true,
      reason: !state.settings.beaconEnabled
        ? '⚠️ 你还没开启「自动信标」功能。请到 ⚙️ 设置 → 🧪 上下文体检 中启用，之后正常对话即可自动埋点。'
        : '当前对话还没有信标。请继续对话，每 ' + (state.settings.beaconInterval || 5) + ' 条消息会自动埋一个信标，之后再来体检。'
    });
    return;
  }
  
  // 显示 loading 弹窗
  _showHealthCheckLoading(beacons.length);
  
  try {
    // 构造体检查询（不写入 messages，不渲染）
    const probeQuestion = '【系统体检】请按照你最早被告知的顺序，列出我之前让你记住的所有临时代号。\n\n要求：\n1. 每行一个代号，不要编号\n2. 只列代号本身（形如 ABC-1234 的格式），不要加任何解释\n3. 如果某个代号你完全记不清了，那一行写"忘记"\n4. 如果你只能记起部分，按你能记起的顺序列出，不要编造\n\n直接给出列表，不要任何前后文字。';
    
    // 历史 = 当前所有消息（含信标）
    const probeHistory = c.messages.map(m => ({ ...m }));
    probeHistory.push({ role: 'user', content: probeQuestion });
    
    const response = await _silentApiCall(probeHistory);
    
    // 解析返回内容
    const reportedCodes = _parseBeaconResponse(response);
    
    // 对比 & 评分
    const result = _evaluateBeacons(beacons, reportedCodes);
    
    _showHealthCheckResult(result);
  } catch (e) {
    console.error('[runHealthCheck] 错误：', e);
    _showHealthCheckResult({
      error: true,
      reason: '体检失败：' + (e.message || String(e))
    });
  }
}

// ⭐ 静默 API 调用：不走 chat 流程，不渲染，不入 messages
async function _silentApiCall(historyMessages) {
  const s = state.settings;
  if (!s.apiKey) throw new Error('未配置 API Key');
  
  // 体检的温度策略：
  //   - 优先用用户设置的 temperature（保证模型兼容性，避免给"不支持 temperature"的推理模型乱传）
  //   - 用户没设就完全不传，让服务端用默认值
  //   - 如果首次请求因 temperature 被服务端拒（如 o1/o3/DeepSeek-R1 等），下面 catch 里会自动剥离重试
  const _rawTemp = parseFloat(s.temperature);
  const _temp = Number.isFinite(_rawTemp) ? _rawTemp : undefined;
  
  // 构造请求体（参考 buildRequestBody 但不依赖 currentChat）
  let body;
  if (s.apiFormat === 'anthropic') {
    const msgs = (typeof buildAnthropicMessages === 'function')
      ? buildAnthropicMessages(historyMessages)
      : historyMessages.map(m => ({ role: m.role, content: m.content }));
    body = {
      model: s.currentModel,
      max_tokens: Math.min(parseInt(s.maxTokens) || 2048, 1024),  // 体检不需要很长回答
      messages: msgs,
      stream: false
    };
    if (s.systemPrompt) body.system = s.systemPrompt;
    if (_temp !== undefined) body.temperature = _temp;
  } else {
    const msgs = (typeof buildOpenAIMessages === 'function')
      ? buildOpenAIMessages(historyMessages)
      : historyMessages.map(m => ({ role: m.role, content: m.content }));
    body = {
      model: s.currentModel,
      messages: msgs,
      max_tokens: Math.min(parseInt(s.maxTokens) || 2048, 1024),
      stream: false
    };
    if (_temp !== undefined) body.temperature = _temp;
  }
  
  // 构造 URL + Headers
  const url = (typeof buildFullUrl === 'function')
    ? buildFullUrl(s.baseUrl, s.apiPath)
    : (s.baseUrl + s.apiPath);
  const headers = (typeof buildHeaders === 'function')
    ? buildHeaders()
    : { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apiKey };
  
  // 调用 _apiFetchWithTimeout（已封装本地代理逻辑）
  const fetchFn = (typeof _apiFetchWithTimeout === 'function')
    ? _apiFetchWithTimeout
    : async (u, opts) => await fetch(u, opts);
  
  // 请求 + 针对"参数不被支持"的 400 兜底重试
  // 一些推理模型（o1/o3/DeepSeek-R1 等）已弃用 temperature/max_tokens 等参数，
  // 传了就 400。这里检测错误关键字后剥离对应字段重试一次。
  const _doFetch = async () => {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, null, 60000);
    if (!resp.ok) {
      const t = await resp.text();
      const err = new Error(`HTTP ${resp.status}: ${t.slice(0, 300)}`);
      err.status = resp.status;
      err.rawText = t;
      throw err;
    }
    return await resp.json();
  };
  
  let data;
  try {
    data = await _doFetch();
  } catch (e) {
    // 解析服务端报"哪个字段不支持"，剥离后重试一次
    const msg = (e.rawText || e.message || '').toLowerCase();
    let stripped = false;
    if (e.status === 400 && /temperature/.test(msg) && 'temperature' in body) {
      delete body.temperature;
      stripped = true;
    }
    if (e.status === 400 && /max[_ ]?tokens/.test(msg) && 'max_tokens' in body) {
      // 部分推理模型用 max_completion_tokens
      const mt = body.max_tokens;
      delete body.max_tokens;
      if (s.apiFormat !== 'anthropic') body.max_completion_tokens = mt;
      stripped = true;
    }
    if (!stripped) throw e;
    data = await _doFetch();
  }
  
  // 提取文本内容
  if (data.content && Array.isArray(data.content)) {
    // Anthropic 格式
    return data.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  if (data.choices && data.choices[0]) {
    // OpenAI 格式
    return data.choices[0].message?.content || '';
  }
  return JSON.stringify(data).slice(0, 500);
}

// 解析 AI 返回的代号列表
function _parseBeaconResponse(text) {
  if (!text) return [];
  const lines = text.split(/[\n\r]+/);
  const codes = [];
  // 匹配 ABC-1234 / ABC_1234 / ABC 1234 三种形式（容错）
  const pattern = /\b([A-Z]{3,12})[\s\-_]+(\d{3,5})\b/i;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(pattern);
    if (m) {
      // 规范化成 大写-数字 形式
      codes.push((m[1].toUpperCase() + '-' + m[2]));
    } else if (/忘|forget|don.?t remember|unknown|不记得|记不|^[\-\.]+$/i.test(trimmed)) {
      codes.push(null);  // 占位"忘记"
    }
  }
  return codes;
}

// 评估每个信标的状态
function _evaluateBeacons(beacons, reportedCodes) {
  const reported = new Set(reportedCodes.filter(Boolean));
  
  // 对每个信标判定：✅ 记得 / ⚠️ 模糊 / ❌ 忘了
  const results = beacons.map(b => {
    if (reported.has(b.code)) {
      return { ...b, status: 'remembered', icon: '✅', label: '记得' };
    }
    // 模糊：代号的字母部分对了但数字错了，或反之
    const [adj, num] = b.code.split('-');
    for (const r of reported) {
      const [ra, rn] = r.split('-');
      if (ra === adj || rn === num) {
        return { ...b, status: 'fuzzy', icon: '⚠️', label: '模糊', fuzzyMatch: r };
      }
    }
    return { ...b, status: 'forgotten', icon: '❌', label: '忘了' };
  });
  
  // 综合健康度（0-100）
  const total = results.length;
  const remembered = results.filter(r => r.status === 'remembered').length;
  const fuzzy = results.filter(r => r.status === 'fuzzy').length;
  // 模糊算 0.5 分
  const score = total > 0 ? Math.round((remembered + fuzzy * 0.5) / total * 100) : 0;
  
  // 健康度等级
  let level, levelColor, levelText;
  if (score >= 90) { level = 'excellent'; levelColor = '#10b981'; levelText = '优秀'; }
  else if (score >= 70) { level = 'good'; levelColor = '#3b82f6'; levelText = '良好'; }
  else if (score >= 50) { level = 'fair'; levelColor = '#f59e0b'; levelText = '一般'; }
  else if (score >= 30) { level = 'poor'; levelColor = '#ef4444'; levelText = '较差'; }
  else { level = 'critical'; levelColor = '#991b1b'; levelText = '严重'; }
  
  // 位置分析
  const positionAnalysis = _analyzePosition(results);
  
  return {
    score,
    level,
    levelColor,
    levelText,
    total,
    remembered,
    fuzzy,
    forgotten: total - remembered - fuzzy,
    results,
    positionAnalysis,
    rawReportedCount: reportedCodes.length
  };
}

// 按位置分组分析（开头/中段/末尾）
function _analyzePosition(results) {
  const groups = { early: [], middle: [], late: [] };
  results.forEach(r => {
    if (r.positionPct < 33) groups.early.push(r);
    else if (r.positionPct < 67) groups.middle.push(r);
    else groups.late.push(r);
  });
  const calcRate = (arr) => {
    if (!arr.length) return null;
    const ok = arr.filter(r => r.status === 'remembered').length;
    return Math.round(ok / arr.length * 100);
  };
  return {
    early: { count: groups.early.length, rate: calcRate(groups.early), items: groups.early },
    middle: { count: groups.middle.length, rate: calcRate(groups.middle), items: groups.middle },
    late: { count: groups.late.length, rate: calcRate(groups.late), items: groups.late }
  };
}

// ============ 🎨 UI：体检 loading + 结果弹窗 ============

function _showHealthCheckLoading(beaconCount) {
  let modal = document.getElementById('healthCheckModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'healthCheckModal';
    modal.className = 'modal-mask';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal" style="max-width:480px;">
      <div style="text-align:center;padding:20px;">
        <div style="font-size:48px;margin-bottom:12px;">🩺</div>
        <h3 style="margin:0 0 8px;font-size:16px;">正在体检...</h3>
        <p style="color:var(--text-secondary);font-size:13px;margin:0 0 16px;">
          正在测试 AI 对 ${beaconCount} 个信标的记忆情况<br>
          （这个过程不会出现在对话中）
        </p>
        <div class="loading-spinner" style="width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto;"></div>
      </div>
    </div>
  `;
  modal.classList.add('show');
}

function _showHealthCheckResult(result) {
  let modal = document.getElementById('healthCheckModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'healthCheckModal';
    modal.className = 'modal-mask';
    document.body.appendChild(modal);
  }
  
  // 空 / 错误状态
  if (result.empty || result.error) {
    modal.innerHTML = `
      <div class="modal" style="max-width:480px;">
        <div style="text-align:center;padding:20px;">
          <div style="font-size:48px;margin-bottom:12px;">${result.error ? '❌' : 'ℹ️'}</div>
          <h3 style="margin:0 0 12px;font-size:16px;">${result.error ? '体检失败' : '暂无信标'}</h3>
          <p style="color:var(--text-secondary);font-size:13px;line-height:1.6;margin:0 0 16px;">
            ${(result.reason || '').replace(/\n/g, '<br>')}
          </p>
          <button class="btn" onclick="closeHealthCheckModal()">关闭</button>
        </div>
      </div>
    `;
    modal.classList.add('show');
    return;
  }
  
  // 正常结果
  const r = result;
  const pa = r.positionAnalysis;
  
  // 信标条目 HTML
  const itemsHtml = r.results.map(item => {
    const bg = item.status === 'remembered' ? 'rgba(16,185,129,0.08)'
             : item.status === 'fuzzy' ? 'rgba(245,158,11,0.08)'
             : 'rgba(239,68,68,0.08)';
    const border = item.status === 'remembered' ? '#10b981'
                 : item.status === 'fuzzy' ? '#f59e0b' : '#ef4444';
    const fuzzyNote = item.fuzzyMatch ? `<span style="font-size:11px;color:var(--text-secondary);"> · 答成了 ${escapeHtml(item.fuzzyMatch)}</span>` : '';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:${bg};border-left:3px solid ${border};border-radius:4px;margin-bottom:6px;font-size:13px;">
        <span style="font-size:16px;">${item.icon}</span>
        <span style="font-family:monospace;font-weight:600;letter-spacing:0.5px;">${escapeHtml(item.code)}</span>
        <span style="flex:1;color:var(--text-secondary);font-size:12px;">位置 ${item.positionPct}%${fuzzyNote}</span>
        <span style="font-size:12px;color:${border};font-weight:500;">${item.label}</span>
      </div>
    `;
  }).join('');
  
  // 位置分析柱状
  const renderPosBar = (g, label) => {
    if (g.count === 0) return `<div style="flex:1;text-align:center;color:var(--text-secondary);font-size:11px;padding:8px 4px;">${label}<br>无信标</div>`;
    const rate = g.rate;
    const color = rate >= 80 ? '#10b981' : rate >= 50 ? '#f59e0b' : '#ef4444';
    return `
      <div style="flex:1;text-align:center;">
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">${label}</div>
        <div style="height:60px;background:var(--bg-input);border-radius:4px;position:relative;overflow:hidden;">
          <div style="position:absolute;bottom:0;left:0;right:0;background:${color};height:${rate}%;transition:height 0.5s;"></div>
        </div>
        <div style="font-size:14px;font-weight:600;color:${color};margin-top:4px;">${rate}%</div>
        <div style="font-size:10px;color:var(--text-secondary);">${g.count} 个</div>
      </div>
    `;
  };
  
  // 解读
  const interpretation = _generateInterpretation(r);
  
  modal.innerHTML = `
    <div class="modal" style="max-width:560px;">
      <div style="padding:6px;">
        <div style="text-align:center;margin-bottom:16px;">
          <div style="font-size:42px;margin-bottom:4px;">🩺</div>
          <h3 style="margin:0 0 8px;font-size:16px;">上下文体检报告</h3>
          
          <!-- 大分数 -->
          <div style="display:inline-flex;align-items:baseline;gap:6px;background:${r.levelColor}15;border:2px solid ${r.levelColor};padding:8px 20px;border-radius:12px;">
            <span style="font-size:36px;font-weight:700;color:${r.levelColor};line-height:1;">${r.score}</span>
            <span style="font-size:14px;color:${r.levelColor};">/ 100</span>
            <span style="font-size:14px;color:${r.levelColor};font-weight:600;margin-left:8px;">${r.levelText}</span>
          </div>
        </div>
        
        <!-- 总览 -->
        <div style="display:flex;gap:8px;margin-bottom:16px;">
          <div style="flex:1;text-align:center;padding:10px;background:rgba(16,185,129,0.08);border-radius:6px;">
            <div style="font-size:20px;font-weight:600;color:#10b981;">${r.remembered}</div>
            <div style="font-size:11px;color:var(--text-secondary);">✅ 记得</div>
          </div>
          <div style="flex:1;text-align:center;padding:10px;background:rgba(245,158,11,0.08);border-radius:6px;">
            <div style="font-size:20px;font-weight:600;color:#f59e0b;">${r.fuzzy}</div>
            <div style="font-size:11px;color:var(--text-secondary);">⚠️ 模糊</div>
          </div>
          <div style="flex:1;text-align:center;padding:10px;background:rgba(239,68,68,0.08);border-radius:6px;">
            <div style="font-size:20px;font-weight:600;color:#ef4444;">${r.forgotten}</div>
            <div style="font-size:11px;color:var(--text-secondary);">❌ 忘了</div>
          </div>
        </div>
        
        <!-- 位置分析 -->
        <h4 style="margin:12px 0 8px;font-size:13px;color:var(--text-secondary);">📍 按对话位置分析</h4>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          ${renderPosBar(pa.early, '🌅 开头')}
          ${renderPosBar(pa.middle, '🌄 中段')}
          ${renderPosBar(pa.late, '🌃 末尾')}
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;">
          💡 中段召回率通常最低（"lost in the middle"），如果开头和末尾正常但中段差，属于正常现象。
        </div>
        
        <!-- 解读 -->
        <div style="background:var(--bg-input);padding:10px 12px;border-radius:6px;margin-bottom:12px;font-size:12px;line-height:1.6;">
          <strong>📋 解读：</strong>${interpretation}
        </div>
        
        <!-- 详细列表（可折叠） -->
        <details style="margin-bottom:12px;">
          <summary style="cursor:pointer;font-size:13px;font-weight:600;padding:6px 0;">📜 信标详情（${r.total} 个）</summary>
          <div style="margin-top:8px;">${itemsHtml}</div>
        </details>
        
        <div style="display:flex;gap:8px;">
          <button class="btn" style="flex:1;" onclick="runHealthCheck()">🔄 重新体检</button>
          <button class="btn btn-primary" style="flex:1;" onclick="closeHealthCheckModal()">关闭</button>
        </div>
      </div>
    </div>
  `;
  modal.classList.add('show');
}

function _generateInterpretation(r) {
  const pa = r.positionAnalysis;
  const parts = [];
  
  if (r.score >= 90) {
    parts.push('上下文记忆非常完整，AI 几乎记得所有埋点。');
  } else if (r.score >= 70) {
    parts.push('上下文基本可靠，少量信息有衰减但不影响主要对话。');
  } else if (r.score >= 50) {
    parts.push('上下文有明显遗忘。建议把关键信息重申一次，或开新对话。');
  } else {
    parts.push('⚠️ 严重遗忘！AI 已经丢失大量上下文，强烈建议开新对话并通过笔记加载关键信息。');
  }
  
  // 位置特征
  if (pa.early.rate !== null && pa.middle.rate !== null && pa.late.rate !== null) {
    if (pa.middle.rate < 50 && pa.early.rate >= 70 && pa.late.rate >= 70) {
      parts.push('呈典型 <strong>"lost in the middle"</strong> 模式——首尾记得清楚，中段遗忘严重。');
    } else if (pa.early.rate < 50 && pa.late.rate >= 70) {
      parts.push('<strong>早期信息丢失</strong>——可能是自动压缩触发，或上下文已溢出窗口。');
    } else if (pa.late.rate < 70) {
      parts.push('⚠️ 连最近的信息都开始模糊，说明模型已经接近能力极限。');
    }
  }
  
  return parts.join(' ');
}

function closeHealthCheckModal() {
  const modal = document.getElementById('healthCheckModal');
  if (modal) modal.classList.remove('show');
}

// 注入旋转动画样式（如未注入）
(function _injectBeaconStyle() {
  if (document.getElementById('beacon-style')) return;
  const style = document.createElement('style');
  style.id = 'beacon-style';
  style.textContent = `
    @keyframes spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
})();
