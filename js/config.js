// ============ 常量配置 ============
const STORE_KEY = 'aichat_data_v6';
const SETTINGS_KEY = 'aichat_settings_v6';
const TOOLS_KEY = 'aichat_tools_v6';
const BUILTIN_TOOLS_LOADED_KEY = 'aichat_builtin_tools_v10';  // ⭐ v10：新增 checkpoint 查看/恢复工具

// 🛡️ 敏感凭证集中清单（用于"一键清除所有凭证"功能）
// 每项 { key, label, type, scope }
//   type: 'localStorage' | 'state'
//   scope: 'localStorage 中的键名' 或 'state.settings 中的字段名'
const SECRET_REGISTRY = [
  { label: '🔑 大模型 API Key',   type: 'state',        scope: 'apiKey' },
  { label: '🎓 LMS Cookie',       type: 'localStorage', scope: 'lms_cookie_v1' },
  { label: '🖥 本地终端 Token',    type: 'localStorage', scope: 'aichat_terminal_token_v1' },
  { label: '🔐 终端永久授权',      type: 'localStorage', scope: 'aichat_terminal_perms_v1' },
];

// 清除所有敏感凭证（返回清除的项数组）
function clearAllSecrets() {
  const cleared = [];
  for (const item of SECRET_REGISTRY) {
    try {
      if (item.type === 'localStorage') {
        // ⭐ 兼容旧字段名：实际数据在 storage（IndexedDB）里
        const _store = (typeof storage !== 'undefined') ? storage : {
          get: k => localStorage.getItem(k),
          remove: k => localStorage.removeItem(k)
        };
        if (_store.get(item.scope) != null) {
          _store.remove(item.scope);
          cleared.push(item.label);
        }
      } else if (item.type === 'state') {
        if (typeof state !== 'undefined' && state.settings && state.settings[item.scope]) {
          state.settings[item.scope] = '';
          cleared.push(item.label);
        }
      }
    } catch (e) { /* 忽略单项失败 */ }
  }
  // 持久化 state 改动
  try { if (typeof persistSettings === 'function') persistSettings(); } catch (e) {}
  return cleared;
}

const PROVIDERS = {
  openai:    { url: 'https://api.openai.com/v1', path: '/chat/completions', format: 'openai', models: 'gpt-4o-mini, gpt-4o' },
  openai_responses: { url: 'https://api.openai.com/v1', path: '/responses', format: 'responses', models: 'gpt-4o-mini, gpt-4o' },
  anthropic: { url: 'https://api.anthropic.com/v1', path: '/messages', format: 'anthropic', models: 'claude-3-5-sonnet-20241022, claude-3-haiku-20240307' },
  deepseek:  { url: 'https://api.deepseek.com/v1', path: '/chat/completions', format: 'openai', models: 'deepseek-chat, deepseek-reasoner' },
  qwen:      { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', path: '/chat/completions', format: 'openai', models: 'qwen-plus, qwen-max, qwen-vl-plus' },
  zhipu:     { url: 'https://open.bigmodel.cn/api/paas/v4', path: '/chat/completions', format: 'openai', models: 'glm-4-flash, glm-4-plus' },
  custom:    { url: '', path: '/chat/completions', format: 'openai', models: '' }
};

const REFLECTION_PRESETS = {
  general: {
    student: '你是认真负责的回答者。请准确、完整、清晰地回答用户问题。收到反馈请改进。',
    teacher: '你是严格的评审老师。审视学生回答的准确性、完整性、清晰度、实用性。请用 JSON 输出（不要其他内容，不要代码块）：{"score":0-10的整数,"issues":["问题"],"suggestions":["建议"],"satisfied":true或false}'
  },
  code: {
    student: '你是经验丰富的程序员。请编写正确、高效、可读的代码。',
    teacher: '你是资深代码审查专家。审视：1.正确性 2.性能 3.可读性 4.健壮性 5.最佳实践。严格输出 JSON（不要其他内容，不要代码块）：{"score":0-10,"issues":[],"suggestions":[],"satisfied":true/false}'
  },
  writing: {
    student: '你是优秀的作家。请创作有深度、有感染力的文字。',
    teacher: '你是严苛的编辑。关注：1.逻辑 2.结构 3.文笔 4.表达 5.感染力。严格输出 JSON（不要其他内容，不要代码块）：{"score":0-10,"issues":[],"suggestions":[],"satisfied":true/false}'
  },
  math: {
    student: '你是严谨的解题者。请详细列出每步推导，使用 $...$ 数学公式。',
    teacher: '你是严格的数学老师。逐步检查推理、公式、计算。严格输出 JSON（不要其他内容，不要代码块）：{"score":0-10,"issues":["第几步出错"],"suggestions":["如何修正"],"satisfied":true/false}'
  },
  analysis: {
    student: '你是深刻的分析者。请从多角度深入分析，挖掘本质。',
    teacher: '你是思想评审者。关注：1.视角 2.深度 3.论证 4.平衡 5.洞察。严格输出 JSON（不要其他内容，不要代码块）：{"score":0-10,"issues":[],"suggestions":[],"satisfied":true/false}'
  },
  translation: {
    student: '你是资深翻译。追求信、达、雅。',
    teacher: '你是翻译评审。关注：1.信 2.达 3.雅 4.专业术语。严格输出 JSON（不要其他内容，不要代码块）：{"score":0-10,"issues":[],"suggestions":[],"satisfied":true/false}'
  }
};

const PLAN_PRESETS = {
  general: {
    planner: '你是任务规划专家。请把用户问题拆解为清晰的执行步骤。\n\n严格输出 JSON（不要其他文字，不要代码块）：\n{"analysis":"对问题的简要分析","steps":[{"id":"t1","title":"步骤标题","description":"详细说明怎么做","successCriteria":["完成后应满足的标准"]}]}\n\n要求：步骤 2-6 个，具体可执行，有逻辑顺序。只说明怎么做和完成标准，不要设计验证命令或验证手段。',
    executor: '你正在执行计划模式中的某一步。请聚焦当前步骤的目标和成功标准，必要时使用工具真实推进。完成后简洁说明本步骤结果、产物和仍需注意的风险。'
  },
  research: {
    planner: '你是研究分析专家。把问题拆为多视角分析步骤。\n严格输出 JSON（不要其他文字，不要代码块）：{"analysis":"...","steps":[{"id":"t1","title":"...","description":"...","successCriteria":["..."]}]}\n建议：背景定义→核心观点→多视角对比→争议→结论。只给做法和完成标准。',
    executor: '你是研究分析师。请就当前步骤给出有依据、有深度的分析。'
  },
  writing: {
    planner: '你是写作规划师。把写作任务拆为章节大纲。\n严格输出 JSON（不要其他文字，不要代码块）：{"analysis":"文章定位","steps":[{"id":"t1","title":"章节","description":"内容","successCriteria":["..."]}]}\n建议：引入→主体→结尾。只给做法和完成标准。',
    executor: '你是优秀作家。按当前章节写出有感染力的文字，注意连贯。'
  },
  code: {
    planner: '你是软件架构师。把代码任务拆为开发步骤。\n严格输出 JSON（不要其他文字，不要代码块）：{"analysis":"项目概述","steps":[{"id":"t1","title":"...","description":"...","successCriteria":["..."]}]}\n建议：需求分析→设计→实现→边界处理→测试。只给做法和完成标准，不要给测试命令或验证手段。',
    executor: '你是高级程序员。执行当前步骤时优先读代码和使用工具真实修改项目；完成后说明改动、验证结果和风险。'
  },
  problem: {
    planner: '你是解题专家。把复杂问题拆为推理步骤。\n严格输出 JSON（不要其他文字，不要代码块）：{"analysis":"问题理解","steps":[{"id":"t1","title":"...","description":"...","successCriteria":["..."]}]}\n建议：理解→已知条件→推理→验证→结论。只给做法和完成标准。',
    executor: '你是严谨解题者。就当前步骤严密推理，使用 $...$ 公式。'
  },
  teaching: {
    planner: '你是教学设计专家。拆为循序渐进的讲解步骤。\n严格输出 JSON（不要其他文字，不要代码块）：{"analysis":"学习目标","steps":[{"id":"t1","title":"...","description":"...","successCriteria":["..."]}]}\n建议：例子引入→概念→原理→应用→误区。只给做法和完成标准。',
    executor: '你是优秀老师。就当前讲解步骤深入浅出说明，多用例子。'
  }
};

const PLAN_REVIEWER_PROMPT = '你是计划评审专家。审视执行计划是否合理：\n1.步骤是否完整？2.顺序是否合理？3.粒度是否合适？4.有无缺失或多余？5.完成标准是否清晰、可判断？\n\nJSON输出（不要其他内容，不要代码块）：{"score":0-10,"satisfied":true/false,"issues":["阻塞性问题"],"suggestions":["非阻塞改进建议"],"revised_steps":null}\n\n评分标准：8 分及以上表示计划已经可执行，即使仍有可改进建议；低于 8 分才表示需要规划者重写。issues 只写会明显影响任务完成的阻塞性问题，普通优化点请写入 suggestions。重点：你负责指出问题和修改建议，规划者会根据你的意见自主重写计划。不要要求规划者提供验证命令或验证手段。';

const PLAN_RESULT_VERIFIER_PROMPT = '你是计划模式的最终结果验证老师。你只能看到原始任务、执行方案和最终执行结果，看不到执行者的工具调用过程或中间推理。请基于这些材料自主判断任务是否完成；如需要核验事实、文件、命令或环境状态，可以调用可用工具进行验证。\n\n最后必须严格输出 JSON（不要代码块，不要额外文字）：{"passed":true/false,"score":0-10,"reason":"通过或不通过的核心理由","issues":["未完成或不可靠之处"],"suggestions":["怎么改进"],"improvement":{"title":"改进阶段标题","description":"如果未通过，给执行者的具体改进任务；如果通过可为空","successCriteria":["改进完成标准"]}}\n\n评分标准：8 分及以上通常表示可以通过。若验证不通过，请给出具体、不重复原步骤的改进建议，便于用户决定是否追加一个改进阶段继续执行。';

const PRESET_TOOLS = {
  time:    { name: 'get_current_time', description: '获取当前时间', parameters: { type: 'object', properties: { timezone: { type: 'string' } }, required: [] }, code: "const tz=args.timezone||undefined;const opts={dateStyle:'full',timeStyle:'long'};if(tz)opts.timeZone=tz;return new Date().toLocaleString('zh-CN',opts);" },
  calc:    { name: 'calculator', description: '数学计算', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] }, code: "try{return '结果：'+Function('\"use strict\"; return ('+args.expression+')')();}catch(e){return '错误：'+e.message;}" },
  weather: { name: 'get_weather', description: '查天气（模拟）', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, code: "const c=['晴','多云','小雨','阴'];return{city:args.city,weather:c[Math.floor(Math.random()*c.length)],temperature:(Math.floor(Math.random()*30)+5)+'°C',note:'⚠️ 模拟数据'};" },
  random:  { name: 'random_number', description: '随机整数', parameters: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } }, required: ['min', 'max'] }, code: "return Math.floor(Math.random()*(args.max-args.min+1))+args.min;" },
  search:  { name: 'open_search', description: '打开搜索', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, code: "window.open('https://www.bing.com/search?q='+encodeURIComponent(args.query),'_blank');return '已搜索：'+args.query;" },
  fetch:   { name: 'http_get', description: 'HTTP GET', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, code: "try{const r=await fetch(args.url);return{status:r.status,body:(await r.text()).slice(0,2000)};}catch(e){return '失败：'+e.message;}" }
};

// ⭐ 内置工具定义（基础笔记/文件夹操作 + 可选工具组）
const BUILTIN_TOOLS = [
  {
    name: 'read_skill',
    description: '读取一个已扫描到的本地 Skill 的完整 SKILL.md 内容。仅当系统提示中的 skill-ref 摘要与当前任务相关时调用，参数 path 必须来自 skill-ref 的 path。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Skill 路径，必须使用系统提示中 skill-ref 的 path 值，例如 skill/example/SKILL.md' }
      },
      required: ['path']
    },
    code: 'return await readSkill(args.path);'
  },
  {
    name: 'read_tool_artifact',
    description: '读取被系统归档的长工具输出。当前上下文里看到“[工具结果已归档] artifact_id: ...”时，如需查看全文、搜索关键字或指定行范围，调用本工具。优先用 query 或 start_line/end_line 精确读取，避免一次性取回过长内容。',
    parameters: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', description: '归档 ID，例如 tool_art_20260608_xxxxxx' },
        query: { type: 'string', description: '可选：在 artifact 中搜索关键词，返回匹配行及上下文' },
        start_line: { type: 'number', description: '可选：起始行号，从 1 开始' },
        end_line: { type: 'number', description: '可选：结束行号' },
        head_lines: { type: 'number', description: '未指定 query/range 且内容过长时返回的开头行数，默认 100' },
        tail_lines: { type: 'number', description: '未指定 query/range 且内容过长时返回的结尾行数，默认 80' },
        max_chars: { type: 'number', description: '最多返回字符数，默认 12000，最大 50000' }
      },
      required: ['artifact_id']
    },
    code: 'return await readToolArtifact(args.artifact_id, args.query, args.start_line, args.end_line, args.head_lines, args.tail_lines, args.max_chars);'
  },
  {
    name: 'execute_action',
    description: '在用户的本地工作区中执行任务指令。可用于运行程序、查询信息、安装依赖、版本管理等日常任务。命令只能在工作区沙箱内运行；cwd 可指定执行目录。单独执行 cd 会切换当前浏览器会话的后续工具目录，其他标签/任务不受影响；更推荐直接传 cwd 保持目录明确。每次执行前会向用户征求确认。如果用户明确要求在新终端窗口中运行（如想看到实时输出、命令耗时很长不想阻塞），请设置 new_window: true。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的任务指令，例如 ls -la 或 python script.py' },
        cwd: { type: 'string', description: '执行目录（可选）' },
        new_window: { type: 'boolean', description: '是否在新终端窗口中运行（默认 false 即后台静默运行）。适合长时间命令（如安装依赖、训练模型、启动服务），或用户明确要求看到终端实时输出时使用。' }
      },
      required: ['command']
    },
    code: 'return await executeTerminalCommand(args.command, args.cwd, args.new_window);'
  },
  {
    name: 'read_note',
    description: '加载并查看本地文件夹中的笔记文档内容（支持 .py .md .txt .json .js 等文本格式）。⚠️ 图片、PDF 等二进制请用 attach_file 工具。可指定行号范围；文档超过 1MB 必须指定 start_line/end_line 分段读取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档路径' },
        start_line: { type: 'number', description: '起始行号（可选，从 1 开始）' },
        end_line: { type: 'number', description: '结束行号（可选）' }
      },
      required: ['path']
    },
    code: 'return await readFile(args.path, args.start_line, args.end_line);'
  },
  {
    name: 'save_note',
    description: '创建新文档或覆盖已存在文档的全部内容。更适合新建文档、说明文件或小文件整体生成；代码修改优先使用 apply_patch，避免误覆盖。父目录自动创建。每次保存会向用户确认。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档路径，例如 hello.py 或 docs/readme.md' },
        content: { type: 'string', description: '要保存的完整文档内容' }
      },
      required: ['path', 'content']
    },
    code: 'return await writeFile(args.path, args.content);'
  },
  {
    name: 'apply_patch',
    description: '按 unified diff / patch 修改代码文件。适合代码任务和多文件小范围修改：先生成带 --- / +++ / @@ 的补丁，可 dry_run 预检，确认能应用后再 dry_run=false 真正写入。相比 save_note/edit_note 更适合代码修改、重构和测试失败后的迭代。当前不支持删除文件，删除请用 delete_note。',
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description: 'unified diff 文本，必须包含文件头 --- a/path、+++ b/path 和 @@ hunk。路径必须在工作区内。'
        },
        dry_run: {
          type: 'boolean',
          description: '是否只预检不写入。建议第一次传 true，预检通过后再传 false 应用。'
        }
      },
      required: ['patch']
    },
    code: 'return await applyPatch(args.patch, args.dry_run === true);'
  },
  {
    name: 'append_note',
    description: '在笔记/文档末尾追加内容，不覆盖原有内容；文件不存在时会创建。适合写日志、累加数据、续写笔记等场景。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档路径' },
        content: { type: 'string', description: '要追加的内容' }
      },
      required: ['path', 'content']
    },
    code: 'return await appendFile(args.path, args.content);'
  },
  {
    name: 'edit_note',
    description: '精确查找并替换文档中的内容：在文档里找到 old_text 替换为 new_text。old_text 必须在文档中唯一存在。适合小范围修改笔记或文档；代码修改优先使用 apply_patch。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档路径' },
        old_text: { type: 'string', description: '要被替换的原文本（必须在文档中唯一）' },
        new_text: { type: 'string', description: '替换后的新文本' }
      },
      required: ['path', 'old_text', 'new_text']
    },
    code: 'return await editFile(args.path, args.old_text, args.new_text);'
  },
  {
    name: 'list_notes',
    description: '列出本地文件夹下一级文档和子目录。不提供 path 则浏览当前目录；需要看子目录时再传对应 path。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径（可选）' }
      },
      required: []
    },
    code: 'return await listDir(args.path);'
  },
  {
    name: 'find_in_notes',
    description: '在笔记/文档中搜索包含特定文本或正则模式的内容。可指定 file_glob 限定文档类型（如 *.py、*.md）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '搜索的根目录（默认当前）' },
        pattern: { type: 'string', description: '搜索关键词或正则表达式' },
        file_glob: { type: 'string', description: '文档通配符（如 *.py），默认 *' }
      },
      required: ['pattern']
    },
    code: 'return await searchInFiles(args.path || ".", args.pattern, args.file_glob);'
  },
  {
    name: 'delete_note',
    description: '从本地文件夹中移除指定的文档或空目录。⚠️ 不可恢复，操作前会向用户确认。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要移除的文档或空目录路径' }
      },
      required: ['path']
    },
    code: 'return await deleteFile(args.path);'
  },
  {
    name: 'list_checkpoints',
    description: '列出 AI 文件工具在写入前自动创建的 checkpoint。用于用户要求回滚、验证失败后评估是否恢复、或查看本轮任务修改前快照。只读操作，不会修改文件。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回数量，1-100，默认 20' }
      },
      required: []
    },
    code: 'return await listCheckpoints(args.limit);'
  },
  {
    name: 'restore_checkpoint',
    description: '【⚠️ 危险操作 - 会覆盖或删除当前文件】把文件恢复到指定 checkpoint 记录的修改前状态。AI 不应静默调用；只有当用户明确要求回滚，或验证失败后已向用户说明并获得确认时才调用。checkpoint_id 可来自当前大纲任务的 outline.checkpointId 或 list_checkpoints。默认 force=false；如果返回冲突，必须向用户说明风险并确认后才能用 force=true。',
    parameters: {
      type: 'object',
      properties: {
        checkpoint_id: { type: 'string', description: 'checkpoint ID，例如 ckpt_20260608_172155_abcd1234；为空时在大纲模式下会尝试使用当前 outline.checkpointId' },
        force: { type: 'boolean', description: '是否强制覆盖冲突。默认 false。只有用户确认后才允许 true。' }
      },
      required: []
    },
    code: 'return await restoreCheckpoint(args.checkpoint_id, args.force === true);'
  },
  {
    name: 'get_current_time',
    description: '获取当前日期和时间。',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: '时区，例如 Asia/Shanghai（可选）' }
      },
      required: []
    },
    code: "const tz=args.timezone||undefined;const opts={dateStyle:'full',timeStyle:'long'};if(tz)opts.timeZone=tz;return new Date().toLocaleString('zh-CN',opts);"
  },
  {
    name: 'calculator',
    description: '执行数学表达式计算，支持 +-*/、括号、Math 函数（如 Math.sqrt、Math.sin）。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式，例如 2*(3+4) 或 Math.sqrt(16)' }
      },
      required: ['expression']
    },
    code: "try{return '结果：'+Function('\"use strict\"; return ('+args.expression+')')();}catch(e){return '错误：'+e.message;}"
  },
  {
    name: 'attach_file',
    description: '把本地文件夹里的多媒体文档（图片、PDF 等无法用 read_note 直接查看的二进制文档）加入对话。AI 在下一轮回复中可以查看图片内容。\n\n使用场景：\n- 用户让你"查看"图片、"分析"图表（.jpg .png .gif 等）\n- 用户让你"阅读" PDF 文档（仅 Claude 模型支持 PDF）\n- 任何需要多模态理解的二进制文档\n\n注意：调用此功能后，文档会出现在附件区；默认前端会自动触发一次隐藏后续消息，让你在下一轮看到附件内容。在大纲模式中，附件会由下一轮大纲循环消化。不要要求用户再发一句，除非工具返回明确要求。\n\n不要用于纯文本文档（.py .txt .md 等），那些用 read_note 即可。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档路径，例如 photo.jpg 或 docs/report.pdf' },
        description: { type: 'string', description: '可选：对文档的简短说明' }
      },
      required: ['path']
    },
    code: 'return await attachFileForAI(args.path, args.description);'
  },
  {
    name: 'list_windows',
    description: '列出当前桌面窗口，供截图前定位目标窗口使用。可按窗口标题或进程名过滤。截图流程中如用户提供窗口线索，优先用它确认 hwnd/title；若无窗口线索，可跳过直接 ai_screenshot 全屏预览。',
    parameters: {
      type: 'object',
      properties: {
        window_title: { type: 'string', description: '窗口标题关键词（可选，模糊匹配）' },
        process_name: { type: 'string', description: '进程名关键词（可选，如 python.exe、chrome.exe）' }
      },
      required: []
    },
    code: 'return await aiListWindows(args.window_title, args.process_name);'
  },
  {
    name: 'ai_screenshot',
    description: '截图工具，支持全屏截图或指定窗口截图，自动保存 PNG 到当前工作目录并返回文件路径。\n\n使用方式：\n- 全屏截图：不传窗口参数即可\n- 窗口截图：提供 window_title 或 process_name 定位窗口\n- 也可先用 list_windows 列出窗口，再传入 hwnd 精确截图\n\n窗口类型与截图方法：\n- 🔧 终端/命令行（cmd.exe / powershell.exe / 所有含 "cmd" "powershell" "命令提示符" 的传统控制台窗口）：传 use_printwindow=true，使用 PrintWindow 离屏渲染，即使窗口在后台也能完整截取\n- 🔧 传统 Win32 窗口（notepad.exe / regedit.exe / 资源管理器 / 大部分非浏览器的原生 Windows 程序）：同样传 use_printwindow=true，支持后台截图\n- 🌐 浏览器（chrome.exe / msedge.exe / firefox.exe）：不传 use_printwindow（默认 false），使用屏幕像素裁剪，窗口需在前台可见\n- ⚡ Electron / UWP 应用（如 VS Code / Discord / Slack / WindowsTerminal.exe）：不传 use_printwindow，使用屏幕裁剪\n\n⚠️ WindowsTerminal 多标签页注意：当 execute_action 的 new_window=true 打开新终端时，可能不会创建新独立窗口，而是在已有 WindowsTerminal.exe 进程中新增标签页。应先用 list_windows（process_name=WindowsTerminal.exe 或按窗口标题搜索）找到主窗口 hwnd（标题如"AI 终端"），而不是内部标签页句柄（标题如 C:\\Windows\\system32\\cmd.exe）。内部标签页句柄只是宿主内的子句柄，截它只能截到单个标签页\n\n截图自动保存到当前工作目录，无需额外步骤。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'auto/window/fullscreen。默认 auto：有窗口信息则优先窗口截图，失败全屏兜底。fullscreen 直接全屏。window 只截指定窗口，失败不兜底。' },
        window_title: { type: 'string', description: '目标窗口标题关键词，可选' },
        process_name: { type: 'string', description: '目标进程名关键词，可选，如 python.exe/chrome.exe' },
        hwnd: { type: 'number', description: '窗口句柄，可由 list_windows 获得，可选' },
        all_screens: { type: 'boolean', description: '全屏模式下是否覆盖多显示器，默认 true。' },
        use_printwindow: { type: 'boolean', description: '是否使用 PrintWindow 离屏渲染。传统 cmd/powershell 控制台和 Win32 窗口设为 true（支持后台截图）；浏览器/Electron/UWP/WindowsTerminal 设为 false 或不传（默认）。' }
      },
      required: []
    },
    code: 'return await aiScreenshot(args);'
  },
  {
    name: 'web_search',
    description: '查询在线参考资料：根据关键词通过在线搜索引擎检索公开网页，返回相关条目的标题、链接和摘要列表。\n\n使用场景：\n- 用户询问的内容超出已有知识范围或需要最新信息\n- 需要查找具体资料、文档、教程的来源链接\n- 作为 fetch_url 的前置：先找到链接，再加载详情\n\n建议工作流：先 web_search 拿到链接 → 再 fetch_url 加载详细内容。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询关键词，可用中文或英文' },
        max_results: { type: 'number', description: '返回结果数量，默认 8，最多 20' },
        region: { type: 'string', description: '地区偏好，可选 cn（默认，国内优先）/ global（海外优先）' }
      },
      required: ['query']
    },
    code: 'return await webSearch(args.query, args.max_results, args.region);'
  },
  {
    name: 'fetch_url',
    description: '加载并查看一个网页的内容，自动识别编码并提取正文（去除 HTML 标签、脚本、样式）。\n\n使用场景：\n- 阅读 web_search 返回的某条结果的详情\n- 阅读用户直接给的链接\n- 加载 API 返回的 JSON / 纯文本资料\n\n注意：默认提取网页正文。如需保留原始 HTML/JSON，传 extract_text=false。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整链接，必须以 http:// 或 https:// 开头' },
        extract_text: { type: 'boolean', description: '是否提取网页正文（默认 true）。设为 false 返回原始内容（适合 JSON/纯文本）' },
        max_chars: { type: 'number', description: '最多返回字符数，默认 8000，最大 50000' }
      },
      required: ['url']
    },
    code: 'return await fetchUrl(args.url, args.extract_text, args.max_chars);'
  },

  // ============ 📚 论文/学术工具（前端直连 API，无需后端代理） ============
  // 实现函数定义在 paper_tools.js 中（arxivSearch / semanticScholarSearch / fetchPdfText）
  {
    name: 'arxiv_search',
    description: '📚【论文】在 arXiv 学术预印本库中搜索论文（覆盖 CS / 物理 / 数学 / 统计等）。返回标题、作者、发表日期、摘要页和 PDF 链接。\n\n使用场景：\n- 用户想找某个领域的最新研究（如"transformer 综述""扩散模型最新论文"）\n- 需要精确按主题/作者检索预印本\n\n后续可用 fetch_pdf_text 读取 PDF 全文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询关键词，英文效果最佳，如 "attention mechanism" "diffusion model"' },
        max_results: { type: 'number', description: '返回数量，默认 8，最多 20' },
        sort_by: { type: 'string', description: '排序方式：relevance（相关度，默认）/ submittedDate（按日期，找最新论文用这个）' }
      },
      required: ['query']
    },
    code: 'return await arxivSearch(args.query, args.max_results, args.sort_by);'
  },
  {
    name: 'semantic_scholar_search',
    description: '🎓【论文】用 Semantic Scholar 搜索学术论文（覆盖全学科 2 亿+ 论文）。返回标题、作者、年份、引用数、期刊/会议、DOI、arXiv ID、开放 PDF 链接。\n\n相比 arxiv_search 优势：\n- 覆盖所有学科（不止理工）\n- 带引用数指标（找高影响力论文）\n- 已正式发表的期刊/会议论文（不止预印本）\n\n注意：未授权用户限速 100 次 / 5 分钟，连续调用可能 429。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询关键词，英文效果最佳' },
        max_results: { type: 'number', description: '返回数量，默认 8，最多 20' },
        year: { type: 'string', description: '年份过滤，如 "2023" 或区间 "2020-2024"（可选）' }
      },
      required: ['query']
    },
    code: 'return await semanticScholarSearch(args.query, args.max_results, args.year);'
  },
  {
    name: 'fetch_pdf_text',
    description: '📄【论文】下载并提取 PDF 全文内容（用于读论文正文，不只是摘要）。基于浏览器端 pdf.js，首次调用会自动加载库（约 300KB）。\n\n使用场景：\n- arxiv_search 拿到 PDF 链接后，用本工具读全文\n- 用户给一个 PDF 链接想让你总结/翻译/答疑\n\n推荐：arXiv 链接（https://arxiv.org/pdf/...）可靠性最高，其他源可能因 CORS 失败。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'PDF 完整 URL，如 https://arxiv.org/pdf/1706.03762' },
        max_pages: { type: 'number', description: '最多读取页数，默认 20，最大 100' },
        max_chars: { type: 'number', description: '最多返回字符数，默认 20000，最大 80000' }
      },
      required: ['url']
    },
    code: 'return await fetchPdfText(args.url, args.max_pages, args.max_chars);'
  },

  // ============ 🎓 LMS 工具（西安交大学习系统） ============
  // 实现函数定义在 lms.js 中（lmsToolXxx 系列）
  {
    name: 'lms_status',
    description: '🎓【LMS】检查西安交大学习系统的 Cookie 是否有效，并显示过期时间。如果用户问"LMS 连上了吗""Cookie 还有效吗"用这个。',
    parameters: { type: 'object', properties: {}, required: [] },
    code: 'return await lmsToolStatus();'
  },
  {
    name: 'lms_courses',
    description: '🎓【LMS】列出当前学生在西安交大 LMS 上所有的课程（按学年分组）。返回包含课程 ID，后续调用 lms_materials 需要这个 ID。',
    parameters: { type: 'object', properties: {}, required: [] },
    code: 'return await lmsToolCourses();'
  },
  {
    name: 'lms_todos',
    description: '🎓【LMS】列出西安交大 LMS 上所有未完成的作业/待办事项，按截止时间排序。当用户问"作业""待办""ddl""有什么要交"时用。',
    parameters: { type: 'object', properties: {}, required: [] },
    code: 'return await lmsToolTodos();'
  },
  {
    name: 'lms_homework',
    description: '🎓【LMS】查看某项作业的详细要求（说明文字、附件、截止时间等）。需要先用 lms_todos 拿到作业 ID（hw_id）。',
    parameters: {
      type: 'object',
      properties: { hw_id: { type: 'number', description: '作业 ID（从 lms_todos 输出里拿）' } },
      required: ['hw_id']
    },
    code: 'return await lmsToolHomework(args.hw_id);'
  },
  {
    name: 'lms_materials',
    description: '🎓【LMS】列出某门课的全部课件资料（PPT/PDF/文档），并标注是否允许下载。需要先用 lms_courses 或 lms_find_course 拿到课程 ID。',
    parameters: {
      type: 'object',
      properties: { course_id: { type: 'number', description: '课程 ID' } },
      required: ['course_id']
    },
    code: 'return await lmsToolMaterials(args.course_id);'
  },
  {
    name: 'lms_find_course',
    description: '🎓【LMS】用关键词搜索课程，返回匹配的课程 ID 和名字。例如用户说"操作系统"就调这个找到 course_id。',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '课程名关键词' } },
      required: ['keyword']
    },
    code: 'return await lmsToolFindCourse(args.keyword);'
  },
  {
    name: 'lms_download',
    description: '🎓【LMS】下载一个文件到本地（通过浏览器下载窗口）。需要 upload_id —— 从 lms_materials 或 lms_homework 输出里找到 ✅ 标记的那些。注意：老师设置了 🔒 的文件无法下载。',
    parameters: {
      type: 'object',
      properties: {
        upload_id: { type: 'number', description: 'upload_id（必须是允许下载的）' },
        filename:  { type: 'string', description: '保存为的文件名（可选，默认使用原文件名）' }
      },
      required: ['upload_id']
    },
    code: 'return await lmsToolDownload(args.upload_id, args.filename);'
  },
  {
    name: 'lms_set_cookie',
    description: '🎓【LMS】保存用户提供的 LMS Cookie 到浏览器本地。当用户主动粘贴一长串 cookie 时用。一般用户应该在 🎓 学习面板里填写。',
    parameters: {
      type: 'object',
      properties: { cookie: { type: 'string', description: '完整的 cookie 字符串，含 session=... 字段' } },
      required: ['cookie']
    },
    code: 'return await lmsToolSetCookie(args.cookie);'
  },

  // ============ 💾 笔记快照（版本管理）============
  // 让 AI 在写完一阶段工作时主动"保存进度"，类似存档点
  // 实现位于 terminal.js（aiGitXxx 系列），共享后端 callGit
  {
    name: 'note_status',
    description: '查看当前本地文件夹里有哪些笔记/文档相对上次保存有改动。用法场景：\n- 写完一段代码、回答了一个复杂问题、修了一个 bug 之后\n- 准备调用 note_snapshot 保存进度前，先看一眼有多少改动\n- 用户问"你刚改了哪些文件"\n\n返回当前分支、已改动文件清单、未跟踪文件清单。不会修改任何内容。',
    parameters: { type: 'object', properties: {}, required: [] },
    code: 'return await aiGitStatus();'
  },
  {
    name: 'note_history',
    description: '查看历史快照（按时间倒序）。每个快照都有一个短 hash 标识。用法场景：\n- 想回顾之前都做了哪些工作\n- 准备调用 note_diff 看某次具体改动前\n- 准备调用 note_restore 回退文件前，先找到目标快照的 hash\n\n参数 limit 控制条数（1-100，默认 20）。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回多少条历史（默认 20，最大 100）' }
      },
      required: []
    },
    code: 'return await aiGitHistory(args.limit);'
  },
  {
    name: 'note_diff',
    description: '查看某次快照的具体改动内容，或当前本地文件夹里的未保存改动。用法场景：\n- 不传 commit：看现在本地文件夹相对上次保存改了什么\n- 传 commit：看那次快照具体做了什么改动\n- 传 path：只看某个文件的改动\n\n返回标准的 diff 文本（+/- 行）。不会修改任何内容。',
    parameters: {
      type: 'object',
      properties: {
        commit: { type: 'string', description: '快照 hash（4-40 位十六进制，可选；不传则看当前本地文件夹改动）' },
        path: { type: 'string', description: '限定文件路径（可选）' }
      },
      required: []
    },
    code: 'return await aiGitDiff(args.commit, args.path);'
  },
  {
    name: 'note_snapshot',
    description: '【写入操作】把当前本地文件夹里的所有改动保存为一个新的版本快照，相当于"存档点"。\n\n何时主动调用：\n- 你刚完成一段完整的工作（如：实现完一个功能、修完一个 bug、重构完一个模块、写完一篇文档）\n- 觉得"写得差不多了"、"到一个稳定状态了"\n- 用户明确说"保存进度"、"存档一下"、"打个快照"\n- 即将开始新的尝试性改动前（防止后悔）\n\n建议的 message 写法：用一句话清楚描述这次做了什么，例如：\n  • "实现 Phase 2 的 5 大 Git 模块"\n  • "修复计时器不停止的 bug"\n  • "重构存储层迁移到 IndexedDB"\n\n本工具会自动暂存所有改动（git add .）并提交。每次调用都会向用户弹窗确认。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '本次快照的描述（必填，建议一句话清楚说明做了什么）' }
      },
      required: ['message']
    },
    code: 'return await aiGitSnapshot(args.message);'
  },
  {
    name: 'note_restore',
    description: '【⚠️ 危险操作 - 会覆盖本地文件】把某个文件恢复到历史快照中的版本。\n\n用法严格限制：\n- 必须先用 note_history 找到目标快照的 hash\n- 必须明确知道要恢复哪个文件的路径\n- 当前文件中尚未保存的改动会丢失\n\n典型场景：\n- 用户说"刚才你改坏了 xxx 文件，恢复一下"\n- 你自己意识到刚才的改动是错的，主动回退\n\n建议工作流：\n1. note_history 找到坏掉之前的快照\n2. note_diff 看清那个快照里文件长啥样\n3. note_restore 执行恢复\n4. note_snapshot 把回退动作也存档（可选）\n\n每次调用都会向用户弹窗确认（高危类别，需输入"我确定"级别的确认）。',
    parameters: {
      type: 'object',
      properties: {
        commit: { type: 'string', description: '要恢复到的快照 hash（4-40 位十六进制，从 note_history 拿）' },
        path: { type: 'string', description: '要恢复的文件路径' }
      },
      required: ['commit', 'path']
    },
    code: 'return await aiGitRestore(args.commit, args.path);'
  }
];
