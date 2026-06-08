// ============ Markdown 渲染 ============

function renderMarkdown(text) {
  if (!text) return '';
  
  // 1. 抽取代码块
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_+\-#.]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const id = codeBlocks.length;
    codeBlocks.push({ lang: (lang || 'plaintext').toLowerCase(), code: code.replace(/\n$/, '') });
    return `\x00CODE${id}\x00`;
  });
  
  // 2. 抽取行内代码
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (m, c) => {
    inlineCodes.push(c);
    return `\x00ICODE${inlineCodes.length - 1}\x00`;
  });
  
  // 3. 抽取数学公式
  const mathBlocks = [];
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, c) => {
    mathBlocks.push({ display: true, formula: c });
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  });
  text = text.replace(/(?<![\\$])\$([^\n$]+?)\$(?!\$)/g, (m, c) => {
    mathBlocks.push({ display: false, formula: c });
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  });
  
  // 4. 转义 HTML
  text = escapeHtml(text);
  
  // 5. 标题
  text = text.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  
  // 6. 水平线
  text = text.replace(/^\s*---+\s*$/gm, '<hr>');
  
  // 7. 粗体、斜体、删除线
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  
  // 8. 链接
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  
  // 9. 引用
  text = text.replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  text = text.replace(/(<\/blockquote>\n<blockquote>)/g, '<br>');
  
  // 10. 表格
  text = renderTables(text);
  
  // 11. 列表
  text = renderLists(text);
  
  // 12. 段落
  text = text.split(/\n{2,}/).map(p => {
    p = p.trim();
    if (!p) return '';
    if (/^<(h\d|ul|ol|li|blockquote|hr|table|div|pre|p)/i.test(p)) return p;
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  
  // 13. 还原数学公式
  text = text.replace(/\x00MATH(\d+)\x00/g, (m, i) => {
    const mb = mathBlocks[+i];
    const tag = mb.display ? 'div' : 'span';
    return `<${tag} class="math-${mb.display ? 'block' : 'inline'}" data-formula="${encodeURIComponent(mb.formula)}" data-display="${mb.display}"></${tag}>`;
  });
  
  // 14. 还原行内代码
  text = text.replace(/\x00ICODE(\d+)\x00/g, (m, i) => `<code>${escapeHtml(inlineCodes[+i])}</code>`);
  
  // 15. 还原代码块
  text = text.replace(/\x00CODE(\d+)\x00/g, (m, i) => {
    const cb = codeBlocks[+i];
    const codeId = 'code_' + Math.random().toString(36).slice(2, 9);
    return `<div class="code-block"><div class="code-header"><span class="code-lang">${escapeHtml(cb.lang)}</span><button class="code-btn" onclick="copyCode('${codeId}')">📋 复制</button></div><pre><code id="${codeId}" class="language-${escapeHtml(cb.lang)}">${escapeHtml(cb.code)}</code></pre></div>`;
  });
  
  return text;
}

// ⭐ 流式专用：自动补未闭合的代码块/数学块，避免"断成两截"的视觉抖动
// 仅用于流式渲染过程中；流式结束后用 renderMarkdown 做最终渲染
function renderMarkdownStreaming(text) {
  if (!text) return '';
  
  // 1) 统计 ``` 围栏数。奇数说明有未闭合代码块，临时补一个闭合
  const fenceMatches = text.match(/```/g);
  const fenceCount = fenceMatches ? fenceMatches.length : 0;
  if (fenceCount % 2 === 1) {
    text = text + '\n```';
  }
  
  // 2) 同样处理 $$...$$ 数学块
  const dollarBlocks = text.match(/\$\$/g);
  const dollarCount = dollarBlocks ? dollarBlocks.length : 0;
  if (dollarCount % 2 === 1) {
    text = text + '\n$$';
  }
  
  // 3) 处理孤立的 ` `（行内代码）— 一行末尾刚开的 `xxx 没闭合时
  // 仅当末尾 token 看起来像未闭合行内代码才补；保守起见只看最后一行
  const lastNewline = text.lastIndexOf('\n');
  const lastLine = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
  // 只统计非围栏的反引号（``` 已经被前面处理）
  const stripped = lastLine.replace(/```/g, '');
  const tickCount = (stripped.match(/`/g) || []).length;
  if (tickCount % 2 === 1) {
    text = text + '`';
  }
  
  return renderMarkdown(text);
}

function renderTables(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
      const headers = line.split('|').slice(1, -1).map(s => s.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map(s => s.trim()));
        i++;
      }
      let html = '<div class="table-wrap"><table><thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
      for (const r of rows) html += '<tr>' + headers.map((_, idx) => `<td>${r[idx] || ''}</td>`).join('') + '</tr>';
      html += '</tbody></table></div>';
      out.push(html);
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join('\n');
}

function renderLists(text) {
  const lines = text.split('\n');
  const out = [];
  let stack = [];
  const closeAll = () => { while (stack.length) out.push('</' + stack.pop().type + '>'); };
  for (const line of lines) {
    const um = line.match(/^(\s*)[-*+]\s+(.+)$/);
    const om = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (um || om) {
      const indent = (um || om)[1].length;
      const type = um ? 'ul' : 'ol';
      const content = (um || om)[2];
      while (stack.length && (stack[stack.length - 1].indent > indent || (stack[stack.length - 1].indent === indent && stack[stack.length - 1].type !== type))) {
        out.push('</' + stack.pop().type + '>');
      }
      if (!stack.length || stack[stack.length - 1].indent < indent) {
        out.push('<' + type + '>');
        stack.push({ type, indent });
      }
      out.push('<li>' + content + '</li>');
    } else {
      closeAll();
      out.push(line);
    }
  }
  closeAll();
  return out.join('\n');
}

// ⭐ 改造：接受 root 参数，只在指定子树内渲染，避免全文档扫描带来的卡顿
// opts.skipMath = true 时跳过 KaTeX（适用于流式输出过程，公式半截会浪费）
function postRender(root, opts) {
  root = root || document;
  opts = opts || {};
  
  // 数学公式渲染
  if (!opts.skipMath && window.renderMathInElement) {
    root.querySelectorAll('[data-formula]').forEach(el => {
      if (el.dataset.rendered === '1') return;  // 已渲染过，跳过
      const f = decodeURIComponent(el.dataset.formula);
      const disp = el.dataset.display === 'true';
      try {
        katex.render(f, el, { displayMode: disp, throwOnError: false });
        el.dataset.rendered = '1';
      } catch (e) {
        el.textContent = (disp ? '$$' : '$') + f + (disp ? '$$' : '$');
      }
    });
  }
  // 代码高亮
  if (window.hljs) {
    root.querySelectorAll('.code-block pre code').forEach(el => {
      if (!el.dataset.highlighted) {
        try {
          hljs.highlightElement(el);
          el.dataset.highlighted = '1';
        } catch (e) {}
      }
    });
  }
}