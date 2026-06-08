# ============================================================
# server/proxy.py - LLM/LMS 代理 + 静态文件 + 公开端点
# ============================================================
# 提供 ProxyMixin。包含：
#   handle_llm_proxy_post  - POST /llm-proxy   绕过浏览器 CORS 转发到 LLM 中转商
#   handle_lms_proxy_get   - GET  /lms-proxy   代理学校 LMS API
#   handle_static_file     - GET  /xxx.html|js|css   本地静态文件托管（白名单扩展名）
#   handle_token_request   - GET  /token       浏览器自动拉取 Token
#   handle_workspace_info  - GET  /workspace   公开沙箱信息（不含 token）
#
# 这些端点在 handler.py 的路由分发里被调用。
# ============================================================

import json
import mimetypes
import os

from . import config


class ProxyMixin:
    """Handler mixin：所有代理/静态/公开端点"""

    # ============ GET /token ============
    def handle_token_request(self):
        """本地项目：file:// 双击 / localhost 访问，直接发 Token，不再要求终端按 y。
        非本机来源（理论上不会发生在本地项目）才弹终端二次确认。
        """
        origin = self.headers.get('Origin', '')
        is_local_origin = (
            not origin
            or origin == 'null'
            or origin.startswith('http://localhost')
            or origin.startswith('http://127.0.0.1')
            or origin.startswith('https://localhost')
            or origin.startswith('https://127.0.0.1')
        )
        if is_local_origin:
            print(f'🔑 [Token] 自动授权（来源={origin or "file://"}）')
            self._send_json(200, {'ok': True, 'token': config.TOKEN,
                                  'cwd': config.get_current_cwd(), 'workspace': config.WORKSPACE_ROOT})
            return

        # 非本机来源：保留终端确认
        ua = self.headers.get('User-Agent', '(unknown)')
        with config.INPUT_LOCK:
            print('\n' + '=' * 60)
            print('🔔 非本机来源在请求 Token')
            print(f'   Origin    : {origin}')
            print(f'   User-Agent: {ua[:80]}')
            print(f'   Client IP : {self.client_address[0]}')
            print('=' * 60)
            try:
                ans = input('是否授权？输入 y 同意 > ').strip().lower()
            except EOFError:
                ans = ''
        if ans != 'y':
            self._send_json(403, {'ok': False, 'error': '用户在终端拒绝授权'})
            return
        self._send_json(200, {'ok': True, 'token': config.TOKEN,
                              'cwd': config.get_current_cwd(), 'workspace': config.WORKSPACE_ROOT})

    # ============ GET /workspace ============
    def handle_workspace_info(self):
        """公开端点，不含 Token"""
        self._send_json(200, {
            'ok': True,
            'workspace': config.WORKSPACE_ROOT,
            'cwd': config.get_current_cwd()
        })

    # ============ GET /xxx 静态文件 ============
    def handle_static_file(self):
        """安全的静态文件服务（只允许放出白名单扩展名，禁止越权）"""
        from urllib.parse import urlparse, unquote
        path = urlparse(self.path).path
        # 默认首页：找当前目录下唯一的 HTML（或固定文件名）
        if path == '/' or path == '':
            preferred = 'AI-Chat-大模型对话助手.html'
            script_dir = os.path.dirname(os.path.abspath(__file__))
            # ⭐ 拆分后，HTML 在父目录（项目根），不在 server/ 里
            project_root = os.path.dirname(script_dir)
            target = os.path.join(project_root, preferred)
            if not os.path.isfile(target):
                htmls = [f for f in os.listdir(project_root) if f.lower().endswith('.html')]
                if not htmls:
                    self._send_json(404, {'ok': False, 'error': '未找到任何 HTML 文件'})
                    return
                target = os.path.join(project_root, htmls[0])
            base_dir = project_root
        else:
            rel = unquote(path.lstrip('/'))
            script_dir = os.path.dirname(os.path.abspath(__file__))
            project_root = os.path.dirname(script_dir)
            target = os.path.realpath(os.path.join(project_root, rel))
            # 不能跳出项目根目录
            project_root_real = os.path.realpath(project_root)
            try:
                inside_project = os.path.commonpath([target, project_root_real]) == project_root_real
            except ValueError:
                inside_project = False
            if not inside_project:
                self._send_json(403, {'ok': False, 'error': '路径越界'})
                return
            base_dir = project_root

        # 白名单扩展名
        ALLOWED_EXTS = {
            '.html', '.htm', '.js', '.css', '.json', '.svg',
            '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
            '.woff', '.woff2', '.ttf', '.map', '.txt', '.md'
        }
        ext = os.path.splitext(target)[1].lower()
        if ext not in ALLOWED_EXTS:
            self._send_json(403, {'ok': False, 'error': f'不允许的文件类型: {ext}'})
            return

        if not os.path.isfile(target):
            self._send_json(404, {'ok': False, 'error': f'文件不存在: {path}'})
            return

        ctype, _ = mimetypes.guess_type(target)
        if not ctype:
            ctype = 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype = ctype + '; charset=utf-8'

        try:
            with open(target, 'rb') as f:
                data = f.read()
        except Exception as e:
            self._send_json(500, {'ok': False, 'error': f'读取失败: {e}'})
            return

        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        origin = self.headers.get('Origin', '')
        if config.is_allowed_origin(origin) and origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        # 开发体验：禁缓存，避免改完 JS 浏览器吃旧版
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.end_headers()
        try: self.wfile.write(data)
        except Exception: pass

    # ============ POST /llm-proxy ============
    def handle_llm_proxy_post(self):
        """LLM 代理（支持流式）。

        Header（来自浏览器）:
          X-Token          : 本地服务的鉴权 token
          X-Target-Url     : 目标完整 URL
          X-Target-Headers : JSON 字符串，要透传给目标的请求头（Authorization 等）
          X-Target-Method  : 可选，默认 POST；GET 用于拉取 /models
        Body : 原样转发给目标
        """
        import urllib.request
        import urllib.error

        origin = self.headers.get('Origin', '')

        token = self.headers.get('X-Token', '')
        if token != config.TOKEN:
            self._send_json(403, {'ok': False, 'error': 'Token 错误'})
            return

        target_url = self.headers.get('X-Target-Url', '').strip()
        if not target_url or not (target_url.startswith('http://') or target_url.startswith('https://')):
            self._send_json(400, {'ok': False, 'error': '缺少或非法的 X-Target-Url 头'})
            return

        target_headers_raw = self.headers.get('X-Target-Headers', '')
        try:
            target_headers = json.loads(target_headers_raw) if target_headers_raw else {}
            if not isinstance(target_headers, dict):
                raise ValueError('X-Target-Headers 必须是 JSON 对象')
        except Exception as e:
            self._send_json(400, {'ok': False, 'error': f'X-Target-Headers 解析失败: {e}'})
            return

        try:
            length = int(self.headers.get('Content-Length', 0))
            req_body = self.rfile.read(length) if length > 0 else b''
        except Exception as e:
            self._send_json(400, {'ok': False, 'error': f'读取请求体失败: {e}'})
            return

        if not any(k.lower() == 'content-type' for k in target_headers):
            target_headers['Content-Type'] = 'application/json'
        target_headers.setdefault('User-Agent', 'Mozilla/5.0 LLM-Proxy/1.0')

        target_method = (self.headers.get('X-Target-Method', 'POST') or 'POST').strip().upper()
        if target_method not in ('GET', 'POST', 'PUT', 'DELETE', 'PATCH'):
            target_method = 'POST'
        if target_method == 'GET':
            req_body = b''
            target_headers.pop('Content-Type', None)

        import time as _time
        print(f'\n🤖 [LLM 代理] {target_method} {target_url}')
        if req_body:
            size_mb = len(req_body) / 1024 / 1024
            print(f'   请求体大小: {len(req_body)} 字节 ({size_mb:.2f} MB)')
            if size_mb > 1:
                print(f'   ⏳ 正在上传 + 等待上游响应头...（大请求可能需 10-90s）', flush=True)

        req = urllib.request.Request(
            target_url,
            data=(req_body if req_body else None),
            method=target_method,
            headers=target_headers,
        )

        _t_send = _time.time()
        try:
            upstream = urllib.request.urlopen(req, timeout=600)
            _t_headers = _time.time()
            print(f'   📡 收到上游响应头，耗时 {_t_headers - _t_send:.2f}s', flush=True)
        except urllib.error.HTTPError as e:
            err_body = b''
            try: err_body = e.read()
            except Exception: pass
            up_ct = e.headers.get('Content-Type', 'text/plain; charset=utf-8') if e.headers else 'text/plain'
            print(f'   ⚠️ 上游 HTTP {e.code}: {err_body[:300]}')
            self.send_response(e.code)
            self.send_header('Content-Type', up_ct)
            self.send_header('X-Upstream-Status', str(e.code))
            self._write_cors_headers(origin)
            self.send_header('Content-Length', str(len(err_body)))
            self.end_headers()
            try: self.wfile.write(err_body)
            except Exception: pass
            return
        except Exception as e:
            print(f'   ❌ 连接上游失败: {e}')
            self._send_json(502, {'ok': False, 'error': f'代理失败：{e}'})
            return

        status = upstream.status
        up_ct = upstream.headers.get('Content-Type', 'application/octet-stream')
        is_stream = ('event-stream' in up_ct.lower()) or ('stream' in up_ct.lower() and 'json' not in up_ct.lower())

        print(f'   ✅ 上游 {status} | Content-Type: {up_ct} | 流式: {is_stream}')

        if is_stream:
            self.send_response(status)
            self.send_header('Content-Type', up_ct)
            self.send_header('X-Upstream-Status', str(status))
            self._write_cors_headers(origin)
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'close')
            self.end_headers()
            _t_first_chunk = None
            _total_bytes = 0
            _last_log = _time.time()
            try:
                while True:
                    chunk = upstream.read(1024)
                    if not chunk:
                        break
                    if _t_first_chunk is None:
                        _t_first_chunk = _time.time()
                        print(f'   🎯 首字 chunk 到达，距请求头 {_t_first_chunk - _t_headers:.2f}s', flush=True)
                    _total_bytes += len(chunk)
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        print('   ⚠️ 浏览器断开了流式连接')
                        break
                    # 每 5s 打一次进度，避免长流式看起来死掉
                    if _time.time() - _last_log > 5:
                        print(f'   📤 已转发 {_total_bytes} 字节', flush=True)
                        _last_log = _time.time()
                _dur = _time.time() - (_t_first_chunk or _t_headers)
                print(f'   ✅ 流式完成，共 {_total_bytes} 字节，流持续 {_dur:.2f}s', flush=True)
            except Exception as e:
                print(f'   ⚠️ 流式转发中断: {e}')
            finally:
                try: upstream.close()
                except Exception: pass
        else:
            try:
                body = upstream.read()
            except Exception as e:
                try: upstream.close()
                except Exception: pass
                self._send_json(502, {'ok': False, 'error': f'读取上游响应失败: {e}'})
                return
            finally:
                try: upstream.close()
                except Exception: pass
            self.send_response(status)
            self.send_header('Content-Type', up_ct)
            self.send_header('X-Upstream-Status', str(status))
            self._write_cors_headers(origin)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try: self.wfile.write(body)
            except Exception: pass

    # ============ GET /lms-proxy ============
    def handle_lms_proxy_get(self):
        """LMS 代理。

        Header:
          X-Token       : 后端鉴权 token（同其他接口）
          X-LMS-Cookie  : 用户的 LMS 会话 cookie 字符串
        Query:
          path  : LMS API 路径，如 /api/todos
          raw   : =1 时不解析 JSON，直接透传响应体
        """
        from urllib.parse import urlparse, parse_qs, urlencode
        import urllib.request
        import urllib.error

        token = self.headers.get('X-Token', '')
        if token != config.TOKEN:
            self._send_json(403, {'ok': False, 'error': 'Token 错误'})
            return

        cookie = self.headers.get('X-LMS-Cookie', '').strip()
        if not cookie:
            self._send_json(400, {'ok': False, 'error': '缺少 X-LMS-Cookie 头'})
            return

        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        lms_path = (qs.get('path', [''])[0] or '').strip()
        raw_mode = qs.get('raw', ['0'])[0] == '1'

        if not lms_path.startswith('/'):
            self._send_json(400, {'ok': False, 'error': 'path 必须以 / 开头'})
            return

        passthrough = {k: v for k, v in qs.items() if k not in ('path', 'raw')}
        extra = ('&' + urlencode(passthrough, doseq=True)) if passthrough else ''
        target_url = f'https://lms.xjtu.edu.cn{lms_path}'
        if '?' in lms_path:
            target_url = target_url + extra
        elif extra:
            target_url = target_url + '?' + extra[1:]

        print(f'🎓 [LMS 代理] GET {target_url}')

        req = urllib.request.Request(target_url, headers={
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/148.0.0.0 Safari/537.36'
            ),
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': 'https://lms.xjtu.edu.cn/user/index',
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': cookie,
        })

        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read()
                status = resp.status
                ct = resp.headers.get('Content-Type', '')
        except urllib.error.HTTPError as e:
            try:
                body_text = e.read().decode('utf-8', errors='replace')
            except Exception:
                body_text = str(e)
            print(f'  ⚠️ HTTP {e.code}: {body_text[:200]}')
            self._send_json(200, {
                'ok': False,
                'status': e.code,
                'error': f'LMS 返回 {e.code}',
                'body': body_text[:2000]
            })
            return
        except Exception as e:
            print(f'  ❌ 请求失败: {e}')
            self._send_json(200, {'ok': False, 'error': f'请求失败: {e}'})
            return

        if not raw_mode and 'json' in ct.lower():
            try:
                data = json.loads(body.decode('utf-8'))
                self._send_json(200, {'ok': True, 'status': status, 'data': data})
                return
            except Exception:
                pass

        try:
            text = body.decode('utf-8', errors='replace')
        except Exception:
            text = ''
        self._send_json(200, {
            'ok': True, 'status': status,
            'content_type': ct,
            'text': text[:200000]
        })
