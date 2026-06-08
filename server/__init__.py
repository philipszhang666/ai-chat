# ============================================================
# 本地 Agent 服务 - server 包
# ============================================================
# 这个包把原本 1900+ 行的 local_terminal_server.py 按职责拆开：
#
#   config.py    - 全局配置（端口、Token、沙箱根）+ 启动时初始化
#   sandbox.py   - 路径校验、危险命令黑名单
#   handler.py   - HTTP Handler 主类（路由分发 + CORS 工具 + OPTIONS/GET）
#   exec.py      - execute_action（命令执行 + cd 拦截）
#   files.py     - 文件读/写/追加/编辑/删除/列目录/搜索/信息/二进制读
#   web.py       - web_search（多引擎回退）+ fetch_url
#   git_ops.py   - Git 集成（status/log/diff/branch/remote/push/scan_diff...）
#   proxy.py     - LLM 代理 + LMS 代理 + /token + /workspace + 静态文件
#
# 外部只需 from server import Handler, config 即可启动。
# ============================================================

from . import config
from .handler import Handler

__all__ = ['Handler', 'config']
