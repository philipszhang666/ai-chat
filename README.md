# AI Chat Local Agent Workbench

一个本地优先、可观察、可控、可执行的大模型 Agent 工作台。

它不是一个只会聊天的 Web UI，也不是把模型直接放进终端里裸跑的自动化脚本。这个项目把聊天、工具调用、文件/命令执行、Git、网页检索、截图、MCP、Skill、计划模式、大纲模式、反思评审、Token/费用统计和请求调试放在同一个浏览器工作台里，让模型真正能做事，同时把关键权限和执行过程留在用户手里。

前端零构建，主界面可以直接打开 HTML；配合本地 Python 服务后，模型可以在受控工作区内读写文件、执行命令、查看屏幕、搜索网页、管理 Git 快照和调用扩展工具。

## 为什么它更适合个人 Agent 工作流

很多现有 Agent 工具通常会卡在几个点上：要么只有聊天和工具调用但不透明，要么能执行但安全边界粗糙，要么工作流很自动但用户很难插手，要么调试 API 请求和费用统计要靠外部工具。

这个项目的取向更务实：

| 常见痛点 | 本项目的做法 |
| --- | --- |
| 模型到底发了什么请求看不清 | 内置 JSON 请求查看器、原始响应记录、cURL 复制、请求历史 |
| Agent 一跑起来很难控制 | 工具权限按类别确认，计划模式需审批，大纲模式可暂停/继续/收尾 |
| 只能给建议，不能真的落地 | 本地后端支持文件读写、命令执行、截图、Git、网页抓取、MCP |
| 单一模型或接口绑定 | 支持 OpenAI、OpenAI Responses、Anthropic、DeepSeek、Qwen、智谱和自定义兼容接口 |
| Token 和费用不透明 | 对话级 Token 条、全局 usage 账本、模型定价、缓存/思考 token 统计 |
| 云端工具不适合私有项目 | 对话、配置、工具、统计默认存浏览器 IndexedDB；文件操作限制在本地工作区 |
| 自动化太重，日常使用成本高 | 零构建前端 + 轻量 Python 后端，不需要 LangChain/LangGraph 这类框架即可使用 |

## 核心亮点

### 1. 可执行，但默认受控

- `execute_action` 在工作区沙箱内运行命令，可用于测试、安装依赖、启动服务、查看状态。
- 文本工具支持读取、保存、追加、精确替换、删除、目录浏览和全文搜索。
- 截图工具支持全屏、指定窗口、窗口列表定位，让模型能观察桌面 UI 或运行结果。
- Git 快照工具可查看状态、历史、diff，保存阶段性改动，也能在确认后恢复历史文件。
- 所有高风险能力都有权限确认：命令、写入、删除、附件、截图、MCP、Git 写入、Git 恢复。

### 2. 三种 Agent 工作流

- **计划模式**：先规划、再评审、再由用户审批，然后逐步执行，最后由验证老师判断结果是否完成。
- **大纲模式**：模型边做边维护动态任务大纲，适合长任务；支持暂停、继续、中途追加用户意见和强制收尾。
- **师生反思模式**：学生生成答案，老师独立评审打分，学生根据反馈改进，适合写作、代码、推理和翻译质量提升。

### 3. 请求和成本完全可观察

- 查看实际发送给模型的 URL、Headers、Body 和原始响应。
- 支持自定义 JSON 请求模板、额外请求头、本地 LLM 代理，方便适配非标准网关。
- 支持流式响应、自动重试、请求超时、频率限制和随机延迟。
- Token 使用有当前对话统计和全局账本，能按模型聚合请求数、输入、输出、缓存读取、思考 token 和估算费用。

### 4. 工具生态可扩展

- 自定义 JS 工具：在 UI 中写工具代码和参数 schema，直接交给模型调用。
- MCP stdio 工具：配置 MCP server，自动同步工具列表并映射为模型可调用工具。
- 本地 Skill：扫描 `skill/` 目录，把 Skill 摘要注入系统提示，必要时再读取完整 `SKILL.md`。
- 论文工具：arXiv、Semantic Scholar、PDF 文本提取。
- LMS 工具：课程、作业、课件、下载等示例能力，可作为接入私有业务系统的样板。

### 5. 项目级记忆

项目记忆默认关闭。开启后才会读取或生成当前 workspace 的 `.agent/memory.md`，用于保存项目定位、启动方式、架构约定、关键文件、已知注意事项、用户偏好和长期待办。它更像一个可编辑的项目背景文件，而不是不可控的黑盒长期记忆。

## 功能地图

### 对话与模型

- Provider：OpenAI、OpenAI Responses、Anthropic、DeepSeek、Qwen、智谱、自定义兼容接口。
- 多套 API 配置档案：Base URL、Path、API Key、模型名、温度、最大输出等可保存并切换。
- Markdown、代码高亮、KaTeX 公式、图片/PDF/文本附件。
- OpenAI / Anthropic / Responses 消息格式适配，自动修复部分 tool call 序列问题。

### 本地 Agent 工具

| 工具 | 能力 |
| --- | --- |
| `execute_action` | 在工作区内执行命令，可选择新终端窗口运行长任务 |
| `read_note` / `save_note` / `append_note` / `edit_note` / `delete_note` | 文本文件读取、写入、追加、精确替换、删除 |
| `list_notes` / `find_in_notes` | 目录浏览和全文搜索 |
| `attach_file` | 把本地图片、PDF 等加入对话，供多模态模型查看 |
| `web_search` / `fetch_url` | 在线搜索和网页正文提取 |
| `ai_screenshot` / `list_windows` | 截取全屏或指定窗口，辅助模型观察界面 |
| `get_current_time` / `calculator` | 当前时间和数学表达式计算 |
| `read_skill` | 按需读取已扫描的本地 Skill |

### 可选工具组

| 工具组 | 能力 |
| --- | --- |
| Git 快照工具 | `note_status`、`note_history`、`note_diff`、`note_snapshot`、`note_restore` |
| 论文工具 | `arxiv_search`、`semantic_scholar_search`、`fetch_pdf_text` |
| LMS 工具 | 课程、待办、作业详情、课件、下载、Cookie 状态 |
| MCP 工具 | 配置 stdio MCP server，同步并调用外部工具 |
| 自定义工具 | 在工具面板中编写 JS 工具和参数 schema |

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

`local_terminal_server.py` 主体尽量使用 Python 标准库；`requests` 用于搜索/网页/LMS，`Pillow`、`pywin32`、`psutil` 用于截图和窗口定位。

### 2. 启动本地后端

在你希望模型访问的工作区目录启动：

```bash
python local_terminal_server.py
```

也可以显式指定工作区：

```bash
python local_terminal_server.py --workspace D:\your-project
```

默认监听 `127.0.0.1:8765`。服务启动目录会作为沙箱根目录，文件操作和命令工作目录都限制在这个目录内。

### 3. 打开界面

方式一：直接双击打开：

```text
AI-Chat-大模型对话助手.html
```

方式二：启动后端后访问本地静态服务：

```text
http://127.0.0.1:8765/
```

首次使用进入设置，填写 API Key、Base URL、模型名和接口格式。需要通过本地代理访问模型 API 时，先在设置里拉取本地终端 Token，并在 Python 终端确认授权。

### 4. 按需开启能力

- 在工具面板启用 Git 快照工具、论文工具、LMS 工具。
- 在 MCP / Skill 面板添加 MCP server 或扫描 `skill/` 目录。
- 在更多菜单开启项目记忆后，Agent 才会检测或生成 `.agent/memory.md`。
- 在 JSON 请求编辑器中调整请求体模板和额外请求头。
- 在定价管理中配置模型价格，用于费用估算。

## 典型使用场景

- **调试项目**：让模型读取代码、运行测试、查看错误、修改文件、保存 Git 快照。
- **长任务执行**：用计划模式先拆解和审批，再逐步执行；或用大纲模式边做边调整。
- **本地资料处理**：读取 Markdown、代码、JSON、图片和 PDF，必要时结合网页搜索。
- **API 网关适配**：用 JSON 请求编辑器调试模型请求，复制 cURL 到终端复现。
- **学习和研究**：搜索论文、提取 PDF 文本、生成总结或对照分析。
- **私有工具接入**：通过 MCP、自定义 JS 工具或 LMS 示例，把内部系统接进 Agent 工作流。

## 安全设计

已经实现的防护：

- 本地服务使用 Token 鉴权，浏览器端需要授权后才能调用。
- 文件操作限制在工作区根目录内，使用 `realpath` / `commonpath` 防止路径越界和 symlink 越狱。
- 命令执行前检查危险命令和明显的工作区外路径。
- 多标签/多任务使用独立会话目录状态，避免一个任务 `cd` 后影响另一个任务。
- 工具权限按类别弹窗确认，并支持本任务允许/永久允许/撤销。
- Git 恢复文件属于高危操作，执行前需要额外确认。
- API Key、LMS Cookie、本地 Token、永久授权可以一键清除。

仍需注意：

- 不要把 API Key、`~/.aichat_terminal_token`、`lms_tool/.lms_cookie` 提交到 Git。
- `.agent/` 默认被 `.gitignore` 排除，项目记忆可能包含个人偏好、内部路径或待办，不建议直接提交。
- 不要导入不可信备份；自定义工具本质上是在浏览器中执行的 JS 代码。
- 浏览器 IndexedDB 是本地存储，不适合在公共电脑长期保存密钥。

## 项目结构

```text
.
├── AI-Chat-大模型对话助手.html   # 主入口，浏览器直接打开
├── base.css                      # 通用样式
├── git-panel.css                 # Git 面板样式
├── lms.css                       # LMS 面板样式
├── local_terminal_server.py      # 本地工具后端入口
├── requirements.txt              # Python 依赖
├── start_agent.bat / start_agent.sh
├── js/
│   ├── api-adapters.js           # OpenAI / Anthropic / Responses 消息适配
│   ├── api-core.js               # 请求体构造、重试、代理、非流式处理
│   ├── api-stream.js             # 流式响应处理
│   ├── api-profiles.js           # 多套 API 配置档案
│   ├── json-editor.js            # 请求预览、模板、Headers、响应、历史
│   ├── tokens.js                 # Token 估算、精确统计、压缩
│   ├── token-usage.js            # 全局 Token 使用统计
│   ├── pricing.js                # 模型定价和费用估算
│   ├── project-memory.js         # 项目级记忆读取、生成和注入
│   ├── plan-core.js / plan-ui.js
│   ├── outline-core.js / outline-render.js / outline-prompts.js
│   ├── reflection.js             # 师生反思模式
│   ├── tools.js / terminal.js / permissions.js
│   ├── mcp-skills.js             # MCP 和本地 Skill 前端集成
│   ├── git-panel.js              # Git 可视化面板
│   ├── paper_tools.js            # arXiv / Semantic Scholar / PDF 文本
│   └── ...
├── server/
│   ├── handler.py                # HTTP 路由
│   ├── exec.py                   # 命令执行
│   ├── files.py                  # 文件读写
│   ├── git_ops.py                # Git 操作
│   ├── mcp_skills.py             # MCP stdio client + Skill loader
│   ├── proxy.py                  # LLM 代理
│   ├── sandbox.py                # 工作区和危险命令限制
│   ├── screenshot.py             # 窗口/屏幕截图
│   └── web.py                    # 搜索与网页读取
├── skill/
│   └── README.md                 # 本地 Skill 目录说明
└── lms_tool/
    ├── lms.py
    ├── README.md
    └── .lms_cookie.example
```

## 开发特点

- 纯前端零构建：JS 通过 HTML 中的 `<script>` 顺序加载，不使用打包器。
- 后端轻依赖：主体为 Python 标准库，按需使用 `requests` / `Pillow` / `pywin32` / `psutil`。
- 工具以 JSON schema 描述参数，由模型通过 function calling 调用。
- 可选工具组默认不全部注入，避免工具列表过长；需要时在 UI 中手动启用。
- 状态持久化使用 IndexedDB，支持配置、工具、对话、统计的备份和恢复。

## 后续路线图

- 给计划模式增加更细的步骤级自动 Gate。
- 增加简单任务路由，把轻量问题自动分配给便宜模型。
- 为师生模式增加多评审者并行投票。
- 将项目记忆升级为可选语义检索，而不是只依赖单个 Markdown 文件。
- 接入小型回归评测，方便比较不同模型和 prompt 的实际效果。

## License

仅供个人学习与研究使用。使用第三方模型、搜索、论文、LMS、MCP 或代理服务时，请遵守对应服务条款。
