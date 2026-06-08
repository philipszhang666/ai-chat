# ============================================================
# server/config.py - 全局配置 & 启动时初始化
# ============================================================
# 这里持有所有"进程级单例"：监听端口、Token、沙箱根目录、当前 cwd。
# 其他模块通过 from server import config 然后 config.TOKEN / config.WORKSPACE_ROOT 访问。
#
# 注意 current_cwd 是会被 cd 命令修改的可变状态，必须通过模块属性访问
# （直接 from .config import current_cwd 会拿到导入瞬间的快照，会读到旧值）。
# ============================================================

import contextvars
import os
import re
import secrets
import sys
import threading

# ⭐ DPI 感知：必须在任何 GDI/窗口操作之前设置，否则 GetWindowRect / ImageGrab
#   在高 DPI 显示器（125%/150%/200% 缩放）上坐标对不上，截图会错位或残缺。
#   PER_MONITOR_AWARE_V2 (2) 是最新模式，每个显示器独立缩放。
if sys.platform == 'win32':
    try:
        import ctypes
        # Windows 10 1703+ 首选
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE_V2
    except Exception:
        try:
            # Windows 8.1 备用
            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # PER_MONITOR_AWARE
        except Exception:
            try:
                # Vista/7 兜底
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass

# ---------- 网络配置 ----------
PORT = 8765
HOST = '127.0.0.1'

# ---------- Token 自动生成/加载 ----------
# 放在用户主目录，所有工作区共享一个 token
TOKEN_FILE = os.path.join(os.path.expanduser('~'), '.aichat_terminal_token')


def _load_or_create_token():
    if os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE) as f:
                tk = f.read().strip()
                if tk:
                    return tk
        except Exception:
            pass
    tk = secrets.token_urlsafe(24)
    try:
        with open(TOKEN_FILE, 'w') as f:
            f.write(tk)
        try:
            os.chmod(TOKEN_FILE, 0o600)  # Unix 设为仅用户可读
        except Exception:
            pass
    except Exception as e:
        print(f'⚠️  无法写入 token 文件: {e}')
    return tk


TOKEN = _load_or_create_token()

# ---------- 沙箱根目录（启动后锁定） ----------
# WORKSPACE_ROOT 在启动后不再变化，所有文件操作必须在此目录内。
# 用 realpath 解析以防 symlink 越狱。
# 默认值 = 启动时的 cwd，可通过 set_workspace() 在启动早期覆盖（CLI --workspace 参数）。
WORKSPACE_ROOT = os.path.realpath(os.getcwd())

# ---------- 可变状态 ----------
# current_cwd 保留为默认会话的 cwd，兼容旧前端和公开状态接口。
# 真正的工具请求通过 session_id 绑定到 SESSION_CWDS，避免多标签/多任务互相串目录。
current_cwd = os.getcwd()
_request_cwd = contextvars.ContextVar('request_cwd', default=None)
SESSION_CWDS = {}
SESSION_LOCK = threading.Lock()
DEFAULT_SESSION_ID = 'default'

# input() 锁（避免多个并发请求同时弹终端确认）
INPUT_LOCK = threading.Lock()


def set_workspace(path: str) -> None:
    """启动早期调用，把沙箱根目录覆盖为指定路径。
    用 realpath 防 symlink 越狱；目录不存在会抛 FileNotFoundError。
    会同步：WORKSPACE_ROOT / current_cwd / 进程 cwd（让相对路径命令也正确）。
    """
    global WORKSPACE_ROOT, current_cwd
    p = os.path.realpath(os.path.expanduser(path))
    if not os.path.isdir(p):
        raise FileNotFoundError(f'workspace 目录不存在: {p}')
    WORKSPACE_ROOT = p
    current_cwd = p
    with SESSION_LOCK:
        SESSION_CWDS.clear()
    try:
        os.chdir(p)  # 让 subprocess 默认继承此 cwd
    except Exception:
        pass


def normalize_session_id(session_id: str) -> str:
    """把浏览器传来的 session_id 收敛成短的本地键名。"""
    sid = str(session_id or '').strip()
    if not sid:
        return DEFAULT_SESSION_ID
    sid = re.sub(r'[^A-Za-z0-9_.:-]+', '_', sid)
    return sid[:160] or DEFAULT_SESSION_ID


def get_session_cwd(session_id: str = '') -> str:
    sid = normalize_session_id(session_id)
    if sid == DEFAULT_SESSION_ID:
        return current_cwd
    with SESSION_LOCK:
        return SESSION_CWDS.get(sid, WORKSPACE_ROOT)


def set_session_cwd(session_id: str, cwd: str) -> None:
    """更新指定会话 cwd；默认会话同步到旧的 current_cwd。"""
    global current_cwd
    sid = normalize_session_id(session_id)
    if sid == DEFAULT_SESSION_ID:
        current_cwd = cwd
        return
    with SESSION_LOCK:
        SESSION_CWDS[sid] = cwd


def bind_request_cwd(cwd: str):
    """给当前请求线程/上下文绑定 cwd，供 sandbox.resolve_path 使用。"""
    return _request_cwd.set(cwd or WORKSPACE_ROOT)


def reset_request_cwd(token) -> None:
    try:
        _request_cwd.reset(token)
    except Exception:
        pass


def get_current_cwd() -> str:
    return _request_cwd.get() or current_cwd


# ---------- CORS 策略 ----------
def is_allowed_origin(origin: str) -> bool:
    """本地项目，所有 Origin 都放行（含 'null' 对应 file:// 双击）。"""
    return True
