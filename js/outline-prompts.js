// ============ 📑 大纲模式（Outline Mode · 动态规划） ============
// 【模块定位】常量与提示词模板（无副作用，无依赖）
// 单一长上下文 Agent：模型自己维护一份可变的"工作大纲"，
// 边做边改，发现新需求就追加条目，完成后给出综合回答。
// 与现有计划模式（瀑布式）并存，二选一。
//
// 本文件导出全局：OUTLINE_TOOLS、OUTLINE_TOOL_NAMES、DEFAULT_OUTLINE_SYSTEM_PROMPT
// 加载顺序：必须先于 outline-core.js 和 outline-render.js

// ============ 隐藏工具定义（不进 state.tools，仅大纲模式下注入到 tools 字段）============

const OUTLINE_TOOLS = [
  {
    name: 'save_outline',
    description: '保存或重写当前工作大纲（全量覆盖）。用于任务开始时初始化大纲，或在思路有较大调整时整体更新。每项需包含 id（如 a1、a2 等唯一标识）、title（简洁标题）、status（pending/active/done/skipped）。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '条目唯一标识，如 a1、a2、a3' },
              title: { type: 'string', description: '条目标题，简洁明了' },
              status: { type: 'string', enum: ['pending', 'active', 'done', 'skipped'], description: '当前状态' },
              note: { type: 'string', description: '附加说明或完成摘要（可选）' }
            },
            required: ['id', 'title', 'status']
          }
        }
      },
      required: ['items']
    }
  },
  {
    name: 'append_outline',
    description: '在工作大纲末尾追加一条新条目。当执行过程中发现需要补充新内容时使用。新条目 status 默认为 pending。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '新条目唯一标识' },
        title: { type: 'string', description: '条目标题' },
        note: { type: 'string', description: '附加说明（可选）' }
      },
      required: ['id', 'title']
    }
  },
  {
    name: 'update_outline',
    description: '更新工作大纲中某一条目的状态或内容。常见用法：开始处理某条时把它标为 active；完成时标为 done 并在 note 写完成摘要；跳过时标为 skipped。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要更新的条目 id' },
        status: { type: 'string', enum: ['pending', 'active', 'done', 'skipped'], description: '新状态（可选）' },
        title: { type: 'string', description: '新标题（可选）' },
        note: { type: 'string', description: '完成摘要或备注（可选）' }
      },
      required: ['id']
    }
  }
];

const OUTLINE_TOOL_NAMES = new Set(['save_outline', 'append_outline', 'update_outline']);

const DEFAULT_OUTLINE_SYSTEM_PROMPT = `你正在协助用户完成一项工作任务。请按以下流程进行：

1. **开始时**：先调用 save_outline 工具列出工作大纲（3-8 个条目）。每个条目包含 id（如 a1、a2）、title（简洁标题）、status（初始都设为 pending）。
2. **执行过程中**：每开始处理一个新条目前，调用 update_outline 把它标记为 active；完成后调用 update_outline 标记为 done 并在 note 里写一句完成摘要。可自由使用其他工具收集信息、操作文件等。
3. **动态调整**：如发现需要补充新内容，调用 append_outline 追加；某条不再需要时，update_outline 标记为 skipped。
4. **完成时**：所有条目都标为 done 或 skipped 后，**停止调用任何工具**，直接给出最终的综合回答。

要点：
- 调用工具时不需要冗长解释，直接调用即可
- 同一时刻只让一个条目处于 active 状态
- 最终回答用 Markdown 格式，内容要完整、连贯`;

const CODE_TASK_OUTLINE_PROFILE_PROMPT = `

【代码任务工程闭环】
当任务涉及代码、测试、构建、运行、调试、报错、bug 修复、功能实现、重构、依赖、脚本或项目配置时，必须采用下面的工程闭环：

1. 初始大纲必须覆盖这些阶段：探索项目结构和相关文件、定位实现/问题点、修改代码、运行测试/构建/复现命令、根据错误继续修复、最终验证和总结。
2. 修改前必须先用 list_notes / find_in_notes / read_note 或必要的命令了解相关代码和项目约定，不要直接猜。
3. 修改代码优先使用 apply_patch：先 dry_run=true 预检，预检通过后 dry_run=false 应用。仅在新建完整小文件或 patch 不适合时才用 save_note / edit_note。
4. 代码修改后必须调用 execute_action 运行最相关的测试、构建、lint、typecheck、启动检查或最小复现命令。
5. 如果验证命令失败，必须读取 stdout/stderr，继续修改代码，再次运行验证命令；不要在失败后直接总结为完成。
6. 如果在验证之后又修改了代码，必须重新运行验证命令；只有最新代码修改后的验证命令通过，或因为缺依赖、缺配置、缺权限、环境限制等明确阻塞且已说明原因时，才允许最终总结。
7. 最终回答必须包含：改了什么、运行了什么验证命令、验证结果、仍需注意的问题。`;
