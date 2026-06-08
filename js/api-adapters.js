// ============ 🔌 API - 消息格式适配器（OpenAI / Anthropic）============
// 【模块定位】将 chats[].messages 转换成各家 API 要求的格式
// 依赖：state.js / utils.js
// 加载顺序：在 api-core.js / api-stream.js 之前

// ============ API 调用核心 ============

function buildOpenAIMessages(history) {
  const out = [];
  const systemPrompt = typeof getEffectiveSystemPrompt === 'function'
    ? getEffectiveSystemPrompt()
    : state.settings.systemPrompt;
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  
  for (const m of history) {
    if (m._isCompressing) continue;
    if (m._isSummary) {
      out.push({ role: 'system', content: m.content });
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.tool_call_id,
        name: m.name,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      out.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
      continue;
    }
    
    const attachments = m.attachments || [];
    const imageAttachments = attachments.filter(a => a.type === 'image' && a.data && !a._stripped);
    const textFileTexts = attachments.filter(a => 
      a.type === 'file' && a.text
    ).map(a => `\n\n[附件: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``).join('');
    
    const strippedNotes = attachments.filter(a => a._stripped).map(a => 
      `\n\n[附件: ${a.name} - ⚠️ 数据已丢失]`
    ).join('');
    
    const textContent = (m.content || '') + textFileTexts + strippedNotes;
    
    const hasImg = imageAttachments.length > 0;
    
    if (hasImg && m.role === 'user') {
      const parts = [];
      if (textContent.trim()) parts.push({ type: 'text', text: textContent });
      for (const a of imageAttachments) {
        parts.push({ type: 'image_url', image_url: { url: a.data } });
      }
      out.push({ role: m.role, content: parts });
    } else {
      out.push({ role: m.role, content: textContent });
    }
  }
  
  // ⭐ 关键修复：确保每个 assistant(tool_calls) 后面都有对应的 tool 消息
  // 否则 DeepSeek/OpenAI 会报 400："An assistant message with 'tool_calls' must be followed by tool messages"
  return fixOpenAIMessageSequence(out);
}

// ⭐ 新增：修复 OpenAI 消息序列，确保每个 tool_calls 中的 id 都有对应的 tool 消息
function fixOpenAIMessageSequence(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls || !m.tool_calls.length) continue;
    
    // 收集这条 assistant 消息之后的所有 tool 消息的 tool_call_id
    const subsequentToolIds = new Set();
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === 'tool' && messages[j].tool_call_id) {
        subsequentToolIds.add(messages[j].tool_call_id);
      }
      // 遇到下一条 user 或 assistant 消息就停止（tool 消息必须紧跟在 assistant 之后）
      if (messages[j].role === 'user' || messages[j].role === 'assistant') break;
    }
    
    // 找出缺失的 tool_call_id
    const missingIds = m.tool_calls
      .map(tc => tc.id)
      .filter(id => id && !subsequentToolIds.has(id));
    
    if (missingIds.length > 0) {
      console.warn(`[修复·OpenAI] 缺失 tool 消息：${missingIds.join(', ')}，自动补全`);
      
      // 在 assistant 消息后面插入占位 tool 消息
      const fillerMessages = missingIds.map(id => ({
        role: 'tool',
        tool_call_id: id,
        content: '[系统：此工具调用被中断或结果丢失，操作未完成]'
      }));
      
      // 找到插入位置：assistant 消息之后、下一条非 tool 消息之前
      let insertAt = i + 1;
      while (insertAt < messages.length && messages[insertAt].role === 'tool') {
        insertAt++;
      }
      messages.splice(insertAt, 0, ...fillerMessages);
      
      // 由于我们插入了消息，调整 i 跳过刚插入的
      i += fillerMessages.length;
    }
  }
  return messages;
}

// ============ OpenAI Responses API ============
function buildOpenAIResponsesInput(history) {
  const out = [];
  
  for (const m of history) {
    if (m._isCompressing) continue;
    if (m._isSummary) {
      out.push({ role: 'system', content: m.content || '' });
      continue;
    }
    
    if (m.role === 'tool') {
      if (!m.tool_call_id) continue;
      out.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      });
      continue;
    }
    
    if (m.role === 'assistant' && Array.isArray(m._responsesOutput) && m._responsesOutput.length) {
      for (const item of m._responsesOutput) out.push(JSON.parse(JSON.stringify(item)));
      continue;
    }
    
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      if (m.content && m.content.trim()) {
        out.push({ role: 'assistant', content: m.content });
      }
      for (const tc of m.tool_calls) {
        out.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '{}'
        });
      }
      continue;
    }
    
    const attachments = m.attachments || [];
    const imageAttachments = attachments.filter(a => a.type === 'image' && a.data && !a._stripped);
    const pdfAttachments = attachments.filter(a => a.mime === 'application/pdf' && a.data && !a._stripped);
    const textFileTexts = attachments.filter(a => 
      a.type === 'file' && a.text && a.mime !== 'application/pdf'
    ).map(a => `\n\n[附件: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``).join('');
    const strippedNotes = attachments.filter(a => a._stripped).map(a => 
      `\n\n[附件: ${a.name} - ⚠️ 数据已丢失]`
    ).join('');
    
    const textContent = (m.content || '') + textFileTexts + strippedNotes;
    const hasMultimedia = m.role === 'user' && (imageAttachments.length || pdfAttachments.length);
    
    if (hasMultimedia) {
      const parts = [];
      if (textContent.trim()) parts.push({ type: 'input_text', text: textContent });
      for (const a of imageAttachments) {
        parts.push({ type: 'input_image', image_url: a.data });
      }
      for (const a of pdfAttachments) {
        parts.push({ type: 'input_file', filename: a.name || 'attachment.pdf', file_data: a.data });
      }
      out.push({ role: 'user', content: parts });
    } else {
      out.push({ role: m.role, content: textContent });
    }
  }
  
  return out;
}

// ⭐ 关键修复：支持 PDF 和图片
function buildAnthropicMessages(history) {
  const out = [];
  
  // ⭐ 收集摘要：Anthropic 的 system 字段保持稳定，摘要在循环结束后 prepend 到首条 user 消息
  // 这样既不污染 system 缓存，又满足 Anthropic 必须 user 开头的要求
  const summaryText = history.filter(m => m._isSummary).map(m => m.content).join('\n\n');
  
  for (const m of history) {
    if (m._isCompressing) continue;
    if (m._isSummary) continue;
    if (m.role === 'system') continue;
    
    if (m.role === 'tool') {
      const toolResultPart = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(toolResultPart);
      } else {
        out.push({ role: 'user', content: [toolResultPart] });
      }
      continue;
    }
    
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const parts = [];
      if (m.content && m.content.trim()) {
        parts.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
        parts.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || '',
          input: input
        });
      }
      out.push({ role: 'assistant', content: parts });
      continue;
    }
    
    const attachments = m.attachments || [];
    const imageAttachments = attachments.filter(a => a.type === 'image' && a.data && !a._stripped);
    const pdfAttachments = attachments.filter(a => 
      a.mime === 'application/pdf' && a.data && !a._stripped
    );
    const fileTexts = attachments.filter(a => 
      a.type === 'file' && a.text && a.mime !== 'application/pdf'
    ).map(a => `\n\n[附件: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``).join('');
    const strippedNotes = attachments.filter(a => a._stripped).map(a => 
      `\n\n[附件: ${a.name} - ⚠️ 数据已丢失]`
    ).join('');
    
    const textContent = (m.content || '') + fileTexts + strippedNotes;
    const hasMultimedia = (imageAttachments.length > 0 || pdfAttachments.length > 0) && m.role === 'user';
    
    if (hasMultimedia) {
      const parts = [];
      for (const a of pdfAttachments) {
        const b64 = a.data.split(',')[1] || '';
        parts.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: b64 }
        });
      }
      for (const a of imageAttachments) {
        const mt = (a.data.match(/data:([^;]+);base64,/) || [])[1] || 'image/png';
        const b64 = a.data.split(',')[1] || '';
        parts.push({ type: 'image', source: { type: 'base64', media_type: mt, data: b64 } });
      }
      if (textContent.trim()) parts.push({ type: 'text', text: textContent });
      out.push({ role: m.role, content: parts });
    } else {
      out.push({ role: m.role, content: textContent });
    }
  }
  
  // ⭐ 第二步：把摘要 prepend 到第一条"纯 user"消息内容前（保持 system 字段稳定 → 命中 prompt cache）
  if (summaryText) {
    const summaryBlock = `【对话历史摘要】\n${summaryText}\n\n---\n\n`;
    // ⭐ 关键修复：必须找"不含 tool_result 的 user 消息"
    //    如果第一条 user 里有 tool_result，前面 prepend 文本会破坏
    //    "tool_use 后立刻 tool_result" 的硬约束，触发 Anthropic 400
    const firstUserIdx = out.findIndex(m => {
      if (m.role !== 'user') return false;
      if (Array.isArray(m.content)) {
        return !m.content.some(p => p.type === 'tool_result');
      }
      return true;
    });
    if (firstUserIdx >= 0) {
      const u = out[firstUserIdx];
      if (typeof u.content === 'string') {
        u.content = summaryBlock + u.content;
      } else if (Array.isArray(u.content)) {
        // 找第一个 text 块；没有就在最前面插一个
        const textPart = u.content.find(p => p.type === 'text');
        if (textPart) {
          textPart.text = summaryBlock + textPart.text;
        } else {
          u.content.unshift({ type: 'text', text: summaryBlock });
        }
      }
    } else {
      // 兜底：连一条"干净 user"都没有，直接在最前面塞一条纯文本 user
      // （由于 fix 函数会跑在后面，不会破坏 tool_use/tool_result 配对）
      out.unshift({ role: 'user', content: summaryBlock });
    }
  }
  
  // ⭐ 第三步：修复格式（自动补全缺失的 tool_result）
  return fixAnthropicMessageSequence(out);
}

// ⭐ 新增：修复消息序列，确保每个 tool_use 都有对应的 tool_result
function fixAnthropicMessageSequence(messages) {
  const fixed = [];
  
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    fixed.push(m);
    
    // 如果这条是 assistant 且包含 tool_use
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const toolUses = m.content.filter(p => p.type === 'tool_use');
      
      if (toolUses.length > 0) {
        // 检查下一条是不是 user 消息且包含对应的 tool_result
        const next = messages[i + 1];
        const nextToolResults = (next && next.role === 'user' && Array.isArray(next.content))
          ? next.content.filter(p => p.type === 'tool_result').map(p => p.tool_use_id)
          : [];
        
        // 找出缺失的 tool_result
        const missingIds = toolUses
          .map(tu => tu.id)
          .filter(id => !nextToolResults.includes(id));
        
        if (missingIds.length > 0) {
          console.warn(`[修复] 缺失 tool_result：${missingIds.join(', ')}，自动补全`);
          
          // 构造补全的 tool_result 块
          const fillerResults = missingIds.map(id => ({
            type: 'tool_result',
            tool_use_id: id,
            content: '[系统：此工具调用的结果丢失，可能是因为操作被中断或会话被重置]',
            is_error: true
          }));
          
          // 如果下一条是 user 消息（含 tool_result），把缺失的合并进去
          if (next && next.role === 'user' && Array.isArray(next.content)) {
            // 在 next 的 content 开头插入缺失的 results
            next.content.unshift(...fillerResults);
          } else {
            // 否则插入一个新的 user 消息
            fixed.push({
              role: 'user',
              content: fillerResults
            });
          }
        }
      }
    }
  }
  
  // ⭐ 第三步：清理空的 user 消息（content 数组里只有 tool_result 但全部被清空的情况）
  return fixed.filter(m => {
    if (m.role === 'user' && Array.isArray(m.content) && m.content.length === 0) {
      console.warn('[修复] 跳过空 user 消息');
      return false;
    }
    return true;
  });
}

