# ============================================================
# server/mcp_skills.py - MCP stdio client + local skill loader
# ============================================================

import json
import os
import queue
import re
import shlex
import subprocess
import threading
import time

from . import config
from .sandbox import check_path_or_error, is_inside_workspace, resolve_path


MCP_PROTOCOL_VERSION = '2024-11-05'
SKILL_MAX_BYTES = 160 * 1024
SKILL_MAX_COUNT = 200


class _McpStdioSession:
    def __init__(self, server):
        self.server = server or {}
        self.proc = None
        self.stdout_q = queue.Queue()
        self.stderr = []
        self.next_id = 1

    def _server_command(self):
        command = str(self.server.get('command') or '').strip()
        if not command:
            raise ValueError('MCP server command is empty')

        args = self.server.get('args') or []
        if isinstance(args, str):
            args = shlex.split(args, posix=(os.name != 'nt'))
        if not isinstance(args, list):
            raise ValueError('MCP server args must be a list or string')
        args = [str(a) for a in args]
        return [command] + args

    def _server_cwd(self):
        cwd = self.server.get('cwd') or config.WORKSPACE_ROOT
        cwd_abs = resolve_path(cwd) if not os.path.isabs(cwd) else os.path.expanduser(cwd)
        if not is_inside_workspace(cwd_abs):
            raise ValueError(f'MCP cwd is outside workspace: {cwd_abs}')
        if not os.path.isdir(cwd_abs):
            raise ValueError(f'MCP cwd does not exist: {cwd_abs}')
        return cwd_abs

    def start(self):
        cmd = self._server_command()
        cwd = self._server_cwd()
        env = os.environ.copy()
        extra_env = self.server.get('env') or {}
        if isinstance(extra_env, dict):
            for k, v in extra_env.items():
                if k:
                    env[str(k)] = str(v)

        creationflags = 0
        if os.name == 'nt' and hasattr(subprocess, 'CREATE_NO_WINDOW'):
            creationflags = subprocess.CREATE_NO_WINDOW

        self.proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1,
            creationflags=creationflags,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def close(self):
        if not self.proc:
            return
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        except Exception:
            pass

    def _read_stdout(self):
        try:
            for line in self.proc.stdout:
                if line.strip():
                    self.stdout_q.put(line)
        except Exception as e:
            self.stdout_q.put(json.dumps({'_reader_error': str(e)}))

    def _read_stderr(self):
        try:
            for line in self.proc.stderr:
                if line:
                    self.stderr.append(line.rstrip())
                    if len(self.stderr) > 80:
                        self.stderr = self.stderr[-80:]
        except Exception:
            pass

    def send(self, payload):
        if not self.proc or self.proc.poll() is not None:
            raise RuntimeError('MCP server process is not running')
        raw = json.dumps(payload, ensure_ascii=False)
        self.proc.stdin.write(raw + '\n')
        self.proc.stdin.flush()

    def request(self, method, params=None, timeout=20):
        req_id = self.next_id
        self.next_id += 1
        self.send({
            'jsonrpc': '2.0',
            'id': req_id,
            'method': method,
            'params': params or {},
        })
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc and self.proc.poll() is not None and self.stdout_q.empty():
                err = '\n'.join(self.stderr[-20:])
                raise RuntimeError(f'MCP server exited early ({self.proc.returncode}). {err}')
            try:
                line = self.stdout_q.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get('_reader_error'):
                raise RuntimeError(msg['_reader_error'])
            if msg.get('id') != req_id:
                continue
            if 'error' in msg:
                raise RuntimeError(json.dumps(msg['error'], ensure_ascii=False))
            return msg.get('result')
        err = '\n'.join(self.stderr[-20:])
        raise TimeoutError(f'MCP request timed out: {method}. {err}')

    def notify(self, method, params=None):
        self.send({
            'jsonrpc': '2.0',
            'method': method,
            'params': params or {},
        })


def _mcp_initialize(session):
    return session.request('initialize', {
        'protocolVersion': MCP_PROTOCOL_VERSION,
        'capabilities': {},
        'clientInfo': {
            'name': 'aichat-local-agent',
            'version': '1.0',
        },
    }, timeout=20)


def _mcp_with_session(server, fn, timeout=30):
    session = _McpStdioSession(server)
    try:
        session.start()
        init_result = _mcp_initialize(session)
        try:
            session.notify('notifications/initialized')
        except Exception:
            pass
        result = fn(session)
        return init_result, result
    finally:
        session.close()


def _mcp_content_to_text(result):
    if result is None:
        return ''
    if isinstance(result, str):
        return result
    content = result.get('content') if isinstance(result, dict) else None
    if not isinstance(content, list):
        return json.dumps(result, ensure_ascii=False, indent=2)

    parts = []
    for item in content:
        if not isinstance(item, dict):
            parts.append(str(item))
            continue
        typ = item.get('type')
        if typ == 'text':
            parts.append(item.get('text') or '')
        elif typ == 'resource':
            resource = item.get('resource') or {}
            text = resource.get('text')
            uri = resource.get('uri') or ''
            parts.append(text if text is not None else f'[resource] {uri}')
        elif typ == 'image':
            mime = item.get('mimeType') or 'image/*'
            data = item.get('data') or ''
            parts.append(f'[image {mime}, base64 {len(data)} chars]')
        else:
            parts.append(json.dumps(item, ensure_ascii=False))
    return '\n'.join(p for p in parts if p)


def _parse_skill_frontmatter(text, fallback_name):
    name = fallback_name
    description = ''
    body = text
    if text.startswith('---'):
        end = text.find('\n---', 3)
        if end != -1:
            fm = text[3:end].strip()
            body = text[end + 4:].lstrip()
            for line in fm.splitlines():
                if ':' not in line:
                    continue
                key, value = line.split(':', 1)
                value = value.strip().strip('"').strip("'")
                if key.strip() == 'name' and value:
                    name = value
                elif key.strip() == 'description' and value:
                    description = value
    if not description:
        for line in body.splitlines():
            line = line.strip()
            if line and not line.startswith('#'):
                description = line[:180]
                break
    return name, description


def _read_skill_file(path):
    with open(path, 'rb') as f:
        raw = f.read(SKILL_MAX_BYTES + 1)
    truncated = len(raw) > SKILL_MAX_BYTES
    text = raw[:SKILL_MAX_BYTES].decode('utf-8', errors='replace')
    fallback = os.path.basename(os.path.dirname(path)) or 'skill'
    name, description = _parse_skill_frontmatter(text, fallback)
    rel = os.path.relpath(path, config.WORKSPACE_ROOT).replace('\\', '/')
    return {
        'id': rel,
        'name': name,
        'description': description,
        'path': rel,
        'content': text,
        'truncated': truncated,
    }


class McpSkillsMixin:
    def handle_mcp_list_tools(self, body):
        server = body.get('server') or {}
        try:
            _, result = _mcp_with_session(
                server,
                lambda s: s.request('tools/list', {}, timeout=30),
            )
            tools = result.get('tools', []) if isinstance(result, dict) else []
            return self._send_json(200, {'ok': True, 'tools': tools, 'raw': result})
        except Exception as e:
            return self._send_json(200, {'ok': False, 'error': str(e)})

    def handle_mcp_call_tool(self, body):
        server = body.get('server') or {}
        tool_name = body.get('tool_name') or ''
        arguments = body.get('arguments') or {}
        if not tool_name:
            return self._send_json(200, {'ok': False, 'error': 'tool_name is required'})
        try:
            _, result = _mcp_with_session(
                server,
                lambda s: s.request('tools/call', {
                    'name': tool_name,
                    'arguments': arguments,
                }, timeout=60),
            )
            text = _mcp_content_to_text(result)
            is_error = bool(isinstance(result, dict) and result.get('isError'))
            return self._send_json(200, {
                'ok': not is_error,
                'isError': is_error,
                'text': text,
                'result': result,
            })
        except Exception as e:
            return self._send_json(200, {'ok': False, 'error': str(e)})

    def handle_skill_list(self, body):
        roots = body.get('roots') or []
        if isinstance(roots, str):
            roots = [x.strip() for x in re.split(r'[\n,;]+', roots) if x.strip()]
        if not roots:
            roots = ['skill']

        skills = []
        errors = []
        seen = set()

        for root in roots:
            root_path, err = check_path_or_error(root, must_exist=False)
            if err:
                errors.append({'root': root, 'error': err})
                continue
            if not os.path.exists(root_path):
                continue

            candidates = []
            if os.path.isfile(root_path) and os.path.basename(root_path).lower() == 'skill.md':
                candidates.append(root_path)
            elif os.path.isdir(root_path):
                direct = os.path.join(root_path, 'SKILL.md')
                if os.path.isfile(direct):
                    candidates.append(direct)
                for cur, dirs, files in os.walk(root_path):
                    dirs[:] = [
                        d for d in dirs
                        if d not in ('.git', 'node_modules', '__pycache__', '.venv', 'venv')
                    ]
                    if 'SKILL.md' in files:
                        candidates.append(os.path.join(cur, 'SKILL.md'))
                    if len(candidates) + len(skills) >= SKILL_MAX_COUNT:
                        break

            for path in candidates:
                real = os.path.realpath(path)
                if real in seen or not is_inside_workspace(real):
                    continue
                seen.add(real)
                try:
                    skills.append(_read_skill_file(real))
                except Exception as e:
                    errors.append({'root': root, 'path': path, 'error': str(e)})
                if len(skills) >= SKILL_MAX_COUNT:
                    break

        return self._send_json(200, {'ok': True, 'skills': skills, 'errors': errors})

    def handle_skill_read(self, body):
        path = body.get('path') or ''
        abs_path, err = check_path_or_error(path, must_exist=True)
        if err:
            return self._send_json(200, {'ok': False, 'error': err})
        if os.path.basename(abs_path).lower() != 'skill.md':
            return self._send_json(200, {'ok': False, 'error': 'Only SKILL.md files can be read as skills'})
        try:
            return self._send_json(200, {'ok': True, 'skill': _read_skill_file(abs_path)})
        except Exception as e:
            return self._send_json(200, {'ok': False, 'error': str(e)})
