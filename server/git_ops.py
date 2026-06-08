# ============================================================
# server/git_ops.py - Git 集成 + 敏感信息扫描
# ============================================================
# 提供 GitMixin。包含：
#   handle_git - 统一的 Git 入口，按 subcommand 分发
#                check / init / config_* / status / log / diff /
#                add / unstage / commit / checkout_file / show_file /
#                branch_* / revert / reset_mixed / reset_hard /
#                remote_* / fetch / pull / push / scan_diff
#
#   内部工具：
#     _git_run               - 安全执行 git 命令（禁交互、UTF-8、超时）
#     _default_gitignore     - 默认 .gitignore 模板
#     _is_safe_remote_url    - 仅允许 https:// / git@host: / ssh://
#     _scan_sensitive_in_diff - 推送前扫描 API Key / Token / 密码
# ============================================================

import os
import re
import subprocess

from . import config
from .sandbox import is_inside_workspace, resolve_path


# ============ 敏感信息扫描规则 ============
# 高置信度低误报：只命中明显的密钥格式
_SENSITIVE_PATTERNS = [
    ('OpenAI Key',          re.compile(r'sk-(?:proj-)?[A-Za-z0-9_\-]{20,}'),                  'OpenAI API Key'),
    ('Anthropic Key',       re.compile(r'sk-ant-(?:api|admin)\d*-[A-Za-z0-9_\-]{20,}'),       'Anthropic API Key'),
    ('GitHub Classic Token',re.compile(r'\bgh[pousr]_[A-Za-z0-9]{36}\b'),                     'GitHub Personal Access Token'),
    ('GitHub Fine PAT',     re.compile(r'\bgithub_pat_[A-Za-z0-9_]{82}\b'),                   'GitHub Fine-grained PAT'),
    ('AWS Access Key',      re.compile(r'\bAKIA[0-9A-Z]{16}\b'),                              'AWS Access Key ID'),
    ('AWS Secret',          re.compile(r'aws_secret_access_key\s*=\s*["\']?[A-Za-z0-9/+=]{40}["\']?', re.I), 'AWS Secret Access Key'),
    ('Google API Key',      re.compile(r'\bAIza[0-9A-Za-z_\-]{35}\b'),                        'Google API Key'),
    ('Slack Token',         re.compile(r'\bxox[baprs]-[0-9A-Za-z\-]{10,}\b'),                 'Slack Token'),
    ('JWT',                 re.compile(r'\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b'), 'JSON Web Token'),
    ('Private Key',         re.compile(r'-----BEGIN (?:RSA |DSA |EC |OPENSSH |)PRIVATE KEY-----'), '私钥块'),
    ('Password 字段',       re.compile(r'''(?:password|passwd|pwd)\s*[:=]\s*["'][^"'\s]{6,}["']''', re.I), '密码字段'),
    ('数据库 URI',          re.compile(r'(?:mysql|postgres|postgresql|mongodb(?:\+srv)?|redis)://[^\s:"\'<>]+:[^@\s]+@'), '带密码的连接串'),
]


class GitMixin:
    """Handler mixin：Git 集成"""

    def handle_git(self, body):
        """统一的 Git 入口，子命令分发。
        所有 git 命令强制在沙箱根目录或其子目录执行。
        """
        sub = body.get('subcommand') or body.get('sub') or ''
        ALLOWED = {
            'check', 'status', 'log', 'diff', 'add', 'unstage', 'commit',
            'checkout_file', 'show_file', 'init', 'config_get', 'config_set',
            'branch_list', 'branch_create', 'branch_switch',
            'revert', 'reset_mixed', 'reset_hard',
            'branch_delete', 'branch_rename',
            'remote_list', 'remote_add', 'remote_remove', 'remote_set_url',
            'push', 'pull', 'fetch',
            'scan_diff',
        }
        if sub not in ALLOWED:
            return self._send_json(200, {'ok': False, 'error': f'未知 git 子命令: {sub}'})

        # 工作目录：默认沙箱根
        cwd_param = body.get('cwd') or config.WORKSPACE_ROOT
        cwd_abs = resolve_path(cwd_param) if not os.path.isabs(cwd_param) else os.path.expanduser(cwd_param)
        if not is_inside_workspace(cwd_abs):
            return self._send_json(200, {'ok': False, 'error': f'🚫 cwd 越界：{cwd_abs}\n沙箱根: {config.WORKSPACE_ROOT}'})
        if not os.path.isdir(cwd_abs):
            return self._send_json(200, {'ok': False, 'error': f'目录不存在: {cwd_abs}'})

        try:
            # ===== check =====
            if sub == 'check':
                return self._git_check(cwd_abs)

            # ===== init =====
            if sub == 'init':
                return self._git_init(body, cwd_abs)

            # ===== config_get / config_set =====
            if sub == 'config_get':
                key = body.get('key', '')
                if not key:
                    return self._send_json(200, {'ok': False, 'error': '缺少 key'})
                r = self._git_run(['git', 'config', '--get', key], cwd_abs, timeout=5)
                return self._send_json(200, {'ok': True, 'value': r['stdout'].strip() if r['ok'] else ''})
            if sub == 'config_set':
                key = body.get('key', '')
                value = body.get('value', '')
                if not key:
                    return self._send_json(200, {'ok': False, 'error': '缺少 key'})
                r = self._git_run(['git', 'config', key, value], cwd_abs, timeout=5)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True})

            # —— 以下子命令都要求已在仓库内 ——
            in_repo = self._git_run(['git', 'rev-parse', '--is-inside-work-tree'], cwd_abs, timeout=5)
            if not (in_repo['ok'] and in_repo['stdout'].strip() == 'true'):
                return self._send_json(200, {'ok': False, 'error': '当前目录不是 Git 仓库（请先初始化）'})

            # ===== status =====
            if sub == 'status':
                return self._git_status(cwd_abs)

            # ===== log =====
            if sub == 'log':
                return self._git_log(body, cwd_abs)

            # ===== diff =====
            if sub == 'diff':
                return self._git_diff(body, cwd_abs)

            # ===== add / unstage =====
            if sub == 'add':
                files = body.get('files') or []
                if not isinstance(files, list) or not files:
                    return self._send_json(200, {'ok': False, 'error': '需要 files 数组'})
                cmd = ['git', 'add', '--'] + files
                r = self._git_run(cmd, cwd_abs, timeout=30)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True})
            if sub == 'unstage':
                files = body.get('files') or []
                if not isinstance(files, list) or not files:
                    return self._send_json(200, {'ok': False, 'error': '需要 files 数组'})
                cmd = ['git', 'reset', 'HEAD', '--'] + files
                r = self._git_run(cmd, cwd_abs, timeout=15)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True})

            # ===== commit =====
            if sub == 'commit':
                msg = (body.get('message') or '').strip()
                if not msg:
                    return self._send_json(200, {'ok': False, 'error': '提交信息不能为空'})
                cmd = ['git', 'commit', '-m', msg]
                if body.get('all'):
                    cmd.insert(2, '-a')
                r = self._git_run(cmd, cwd_abs, timeout=20)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True, 'output': r['stdout']})

            # ===== checkout_file =====
            if sub == 'checkout_file':
                files = body.get('files') or []
                if not isinstance(files, list) or not files:
                    return self._send_json(200, {'ok': False, 'error': '需要 files 数组'})
                commit = body.get('commit') or 'HEAD'
                if commit != 'HEAD' and not re.match(r'^[0-9a-f]{4,40}$', commit):
                    return self._send_json(200, {'ok': False, 'error': '无效的 commit hash'})
                cmd = ['git', 'checkout', commit, '--'] + files
                r = self._git_run(cmd, cwd_abs, timeout=15)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True})

            # ===== show_file =====
            if sub == 'show_file':
                commit = body.get('commit') or 'HEAD'
                path = body.get('path') or ''
                if commit != 'HEAD' and not re.match(r'^[0-9a-f]{4,40}$', commit):
                    return self._send_json(200, {'ok': False, 'error': '无效的 commit hash'})
                if not path or '..' in path.split('/') or path.startswith('/'):
                    return self._send_json(200, {'ok': False, 'error': '无效的文件路径'})
                r = self._git_run(['git', 'cat-file', '-e', f'{commit}:{path}'], cwd_abs, timeout=5)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': '在指定快照中找不到该文件'})
                return self._send_json(200, {'ok': True, 'exists': True})

            # ===== 分支 =====
            if sub == 'branch_list':
                r = self._git_run(['git', 'branch', '--list', '--format=%(refname:short)|%(HEAD)|%(upstream:short)'], cwd_abs, timeout=10)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                branches = []
                for line in r['stdout'].splitlines():
                    parts = line.split('|')
                    if not parts[0]: continue
                    branches.append({
                        'name': parts[0],
                        'current': len(parts) > 1 and parts[1].strip() == '*',
                        'upstream': parts[2] if len(parts) > 2 else '',
                    })
                return self._send_json(200, {'ok': True, 'branches': branches})

            if sub == 'branch_create':
                name = (body.get('name') or '').strip()
                if not name or not re.match(r'^[A-Za-z0-9_\-./]+$', name):
                    return self._send_json(200, {'ok': False, 'error': '分支名只能包含字母数字 _ - . /'})
                r = self._git_run(['git', 'checkout', '-b', name], cwd_abs, timeout=10)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True})

            if sub == 'branch_switch':
                name = (body.get('name') or '').strip()
                if not name or not re.match(r'^[A-Za-z0-9_\-./]+$', name):
                    return self._send_json(200, {'ok': False, 'error': '无效的分支名'})
                r = self._git_run(['git', 'checkout', name], cwd_abs, timeout=10)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True})

            # ========== Phase 2：版本回退 ==========
            if sub == 'revert':
                commit = (body.get('commit') or '').strip()
                if not re.match(r'^[0-9a-f]{4,40}$', commit):
                    return self._send_json(200, {'ok': False, 'error': '无效的 commit hash'})
                r = self._git_run(['git', 'revert', '--no-edit', commit], cwd_abs, timeout=20)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True, 'output': r['stdout']})

            if sub == 'reset_mixed':
                commit = (body.get('commit') or '').strip()
                if not re.match(r'^[0-9a-f]{4,40}$', commit):
                    return self._send_json(200, {'ok': False, 'error': '无效的 commit hash'})
                r = self._git_run(['git', 'reset', '--mixed', commit], cwd_abs, timeout=20)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True, 'output': r['stdout']})

            if sub == 'reset_hard':
                commit = (body.get('commit') or '').strip()
                if not re.match(r'^[0-9a-f]{4,40}$', commit):
                    return self._send_json(200, {'ok': False, 'error': '无效的 commit hash'})
                if body.get('confirm') != '我确定':
                    return self._send_json(200, {'ok': False, 'error': '需要确认（confirm="我确定"）'})
                r = self._git_run(['git', 'reset', '--hard', commit], cwd_abs, timeout=20)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True, 'output': r['stdout']})

            # ========== Phase 2：分支删除/重命名 ==========
            if sub == 'branch_delete':
                name = (body.get('name') or '').strip()
                if not name or not re.match(r'^[A-Za-z0-9_\-./]+$', name):
                    return self._send_json(200, {'ok': False, 'error': '无效的分支名'})
                force = bool(body.get('force'))
                if force and body.get('confirm') != '我确定':
                    return self._send_json(200, {'ok': False, 'error': '强制删除需要确认（confirm="我确定"）'})
                flag = '-D' if force else '-d'
                r = self._git_run(['git', 'branch', flag, name], cwd_abs, timeout=10)
                if not r['ok']:
                    err = r['stderr'] or r['stdout']
                    not_merged = 'not fully merged' in err.lower() or 'is not fully merged' in err.lower()
                    return self._send_json(200, {'ok': False, 'error': err, 'notMerged': not_merged})
                return self._send_json(200, {'ok': True})

            if sub == 'branch_rename':
                old = (body.get('old') or '').strip()
                new = (body.get('new') or '').strip()
                if not new or not re.match(r'^[A-Za-z0-9_\-./]+$', new):
                    return self._send_json(200, {'ok': False, 'error': '新分支名只能包含字母数字 _ - . /'})
                if old and not re.match(r'^[A-Za-z0-9_\-./]+$', old):
                    return self._send_json(200, {'ok': False, 'error': '无效的旧分支名'})
                cmd = ['git', 'branch', '-m']
                if old:
                    cmd += [old, new]
                else:
                    cmd += [new]
                r = self._git_run(cmd, cwd_abs, timeout=10)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True})

            # ========== Phase 2：远程仓库管理 ==========
            if sub == 'remote_list':
                r = self._git_run(['git', 'remote', '-v'], cwd_abs, timeout=5)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                seen = {}
                for line in r['stdout'].splitlines():
                    parts = line.split()
                    if len(parts) < 2: continue
                    nm, url = parts[0], parts[1]
                    if nm not in seen:
                        seen[nm] = url
                remotes = [{'name': k, 'url': v} for k, v in seen.items()]
                return self._send_json(200, {'ok': True, 'remotes': remotes})

            if sub == 'remote_add':
                name = (body.get('name') or '').strip()
                url = (body.get('url') or '').strip()
                if not name or not re.match(r'^[A-Za-z0-9_\-]+$', name):
                    return self._send_json(200, {'ok': False, 'error': '远程名只能包含字母数字 _ -'})
                if not self._is_safe_remote_url(url):
                    return self._send_json(200, {'ok': False, 'error': '只支持 https:// 或 git@host:path 形式的 URL'})
                r = self._git_run(['git', 'remote', 'add', name, url], cwd_abs, timeout=10)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True})

            if sub == 'remote_remove':
                name = (body.get('name') or '').strip()
                if not name or not re.match(r'^[A-Za-z0-9_\-]+$', name):
                    return self._send_json(200, {'ok': False, 'error': '无效的远程名'})
                r = self._git_run(['git', 'remote', 'remove', name], cwd_abs, timeout=10)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True})

            if sub == 'remote_set_url':
                name = (body.get('name') or '').strip()
                url = (body.get('url') or '').strip()
                if not name or not re.match(r'^[A-Za-z0-9_\-]+$', name):
                    return self._send_json(200, {'ok': False, 'error': '无效的远程名'})
                if not self._is_safe_remote_url(url):
                    return self._send_json(200, {'ok': False, 'error': '只支持 https:// 或 git@host:path 形式的 URL'})
                r = self._git_run(['git', 'remote', 'set-url', name, url], cwd_abs, timeout=10)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True})

            # ========== Phase 2：推送 / 拉取 / 抓取 ==========
            if sub == 'fetch':
                remote = (body.get('remote') or 'origin').strip()
                if not re.match(r'^[A-Za-z0-9_\-]+$', remote):
                    return self._send_json(200, {'ok': False, 'error': '无效的远程名'})
                r = self._git_run(['git', 'fetch', remote], cwd_abs, timeout=60)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True, 'output': r['stdout'] + r['stderr']})

            if sub == 'pull':
                remote = (body.get('remote') or 'origin').strip()
                branch = (body.get('branch') or '').strip()
                if not re.match(r'^[A-Za-z0-9_\-]+$', remote):
                    return self._send_json(200, {'ok': False, 'error': '无效的远程名'})
                if branch and not re.match(r'^[A-Za-z0-9_\-./]+$', branch):
                    return self._send_json(200, {'ok': False, 'error': '无效的分支名'})
                cmd = ['git', 'pull', remote]
                if branch: cmd.append(branch)
                r = self._git_run(cmd, cwd_abs, timeout=60)
                if not r['ok']:
                    return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
                return self._send_json(200, {'ok': True, 'output': r['stdout'] + r['stderr']})

            if sub == 'push':
                remote = (body.get('remote') or 'origin').strip()
                branch = (body.get('branch') or '').strip()
                force_lease = bool(body.get('forceWithLease'))
                if not re.match(r'^[A-Za-z0-9_\-]+$', remote):
                    return self._send_json(200, {'ok': False, 'error': '无效的远程名'})
                if branch and not re.match(r'^[A-Za-z0-9_\-./]+$', branch):
                    return self._send_json(200, {'ok': False, 'error': '无效的分支名'})
                if force_lease and body.get('confirm') != '我确定':
                    return self._send_json(200, {'ok': False, 'error': '强制推送需要确认（confirm="我确定"）'})
                cmd = ['git', 'push']
                if force_lease:
                    cmd.append('--force-with-lease')
                cmd.append(remote)
                if branch: cmd.append(branch)
                r = self._git_run(cmd, cwd_abs, timeout=120)
                if not r['ok']:
                    err = r['stderr'] or r['stdout']
                    auth_fail = ('authentication failed' in err.lower()
                                 or 'could not read username' in err.lower()
                                 or 'permission denied' in err.lower())
                    return self._send_json(200, {'ok': False, 'error': err, 'authFailed': auth_fail})
                return self._send_json(200, {'ok': True, 'output': r['stdout'] + r['stderr']})

            # ========== Phase 2：敏感信息扫描 ==========
            if sub == 'scan_diff':
                return self._git_scan_diff(body, cwd_abs)

        except Exception as e:
            return self._send_json(200, {'ok': False, 'error': f'git 内部错误: {e}'})

    # ============ 子命令拆出来的辅助 ============
    def _git_check(self, cwd_abs):
        git_ver = self._git_run(['git', '--version'], cwd_abs, timeout=5)
        if not git_ver['ok']:
            return self._send_json(200, {
                'ok': False,
                'gitInstalled': False,
                'error': '系统未安装 Git，或不在 PATH 中。请先安装 Git：https://git-scm.com/'
            })
        in_repo = self._git_run(['git', 'rev-parse', '--is-inside-work-tree'], cwd_abs, timeout=5)
        if in_repo['ok'] and in_repo['stdout'].strip() == 'true':
            top = self._git_run(['git', 'rev-parse', '--show-toplevel'], cwd_abs, timeout=5)
            branch = self._git_run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd_abs, timeout=5)
            user_name = self._git_run(['git', 'config', '--get', 'user.name'], cwd_abs, timeout=5)
            user_email = self._git_run(['git', 'config', '--get', 'user.email'], cwd_abs, timeout=5)
            return self._send_json(200, {
                'ok': True,
                'gitInstalled': True,
                'inRepo': True,
                'version': git_ver['stdout'].strip(),
                'topLevel': top['stdout'].strip(),
                'branch': branch['stdout'].strip() if branch['ok'] else '',
                'userName': user_name['stdout'].strip() if user_name['ok'] else '',
                'userEmail': user_email['stdout'].strip() if user_email['ok'] else '',
            })
        return self._send_json(200, {
            'ok': True,
            'gitInstalled': True,
            'inRepo': False,
            'version': git_ver['stdout'].strip(),
        })

    def _git_init(self, body, cwd_abs):
        if os.path.isdir(os.path.join(cwd_abs, '.git')):
            return self._send_json(200, {'ok': False, 'error': '此目录已是 Git 仓库'})
        r = self._git_run(['git', 'init'], cwd_abs, timeout=15)
        if not r['ok']:
            return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
        uname = (body.get('userName') or '').strip()
        uemail = (body.get('userEmail') or '').strip()
        if uname:
            self._git_run(['git', 'config', 'user.name', uname], cwd_abs, timeout=5)
        if uemail:
            self._git_run(['git', 'config', 'user.email', uemail], cwd_abs, timeout=5)
        if body.get('createGitignore'):
            gi_path = os.path.join(cwd_abs, '.gitignore')
            if not os.path.exists(gi_path):
                try:
                    with open(gi_path, 'w', encoding='utf-8') as f:
                        f.write(self._default_gitignore())
                except Exception:
                    pass
        if body.get('createInitialCommit'):
            self._git_run(['git', 'add', '.'], cwd_abs, timeout=30)
            self._git_run(['git', 'commit', '-m', body.get('initialCommitMessage') or 'Initial commit'], cwd_abs, timeout=15)
        return self._send_json(200, {'ok': True, 'message': '✅ Git 仓库已初始化'})

    def _git_status(self, cwd_abs):
        r = self._git_run(['git', 'status', '--porcelain=v1', '-b', '--untracked-files=all'], cwd_abs, timeout=10)
        if not r['ok']:
            return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
        lines = r['stdout'].splitlines()
        branch = ''
        ahead = behind = 0
        staged = []
        unstaged = []
        untracked = []
        for line in lines:
            if line.startswith('##'):
                rest = line[3:].strip()
                m = re.match(r'^([^.]+?)(?:\.\.\.([^\s]+))?(?:\s+\[(.+)\])?$', rest)
                if m:
                    branch = m.group(1)
                    extras = m.group(3) or ''
                    am = re.search(r'ahead\s+(\d+)', extras)
                    bm = re.search(r'behind\s+(\d+)', extras)
                    ahead = int(am.group(1)) if am else 0
                    behind = int(bm.group(1)) if bm else 0
                continue
            if len(line) < 3:
                continue
            x, y, path = line[0], line[1], line[3:]
            if ' -> ' in path:
                path = path.split(' -> ', 1)[1]
            if path.startswith('"') and path.endswith('"'):
                path = path[1:-1]
            if x == '?' and y == '?':
                untracked.append({'path': path, 'status': '?'})
            else:
                if x != ' ' and x != '?':
                    staged.append({'path': path, 'status': x})
                if y != ' ' and y != '?':
                    unstaged.append({'path': path, 'status': y})
        return self._send_json(200, {
            'ok': True,
            'branch': branch, 'ahead': ahead, 'behind': behind,
            'staged': staged, 'unstaged': unstaged, 'untracked': untracked,
            'clean': not (staged or unstaged or untracked),
        })

    def _git_log(self, body, cwd_abs):
        limit = max(1, min(int(body.get('limit', 50)), 500))
        fmt = '%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1e'
        cmd = ['git', 'log', f'--max-count={limit}', f'--format={fmt}']
        if body.get('file'):
            cmd += ['--', body.get('file')]
        r = self._git_run(cmd, cwd_abs, timeout=15)
        if not r['ok']:
            if 'does not have any commits' in (r['stderr'] or '') or 'bad default revision' in (r['stderr'] or ''):
                return self._send_json(200, {'ok': True, 'commits': []})
            return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
        commits = []
        for rec in r['stdout'].split('\x1e'):
            rec = rec.strip('\n\r')
            if not rec:
                continue
            parts = rec.split('\x1f')
            if len(parts) < 6:
                continue
            commits.append({
                'hash': parts[0],
                'shortHash': parts[1],
                'author': parts[2],
                'email': parts[3],
                'ts': int(parts[4]) if parts[4].isdigit() else 0,
                'subject': parts[5],
            })
        return self._send_json(200, {'ok': True, 'commits': commits})

    def _git_diff(self, body, cwd_abs):
        mode = body.get('mode', 'working')
        file = body.get('file')
        if mode == 'commit':
            commit = body.get('commit', '')
            if not commit or not re.match(r'^[0-9a-f]{4,40}$', commit):
                return self._send_json(200, {'ok': False, 'error': '无效的 commit hash'})
            cmd = ['git', 'show', '--format=fuller', commit]
            if file:
                cmd += ['--', file]
        elif mode == 'staged':
            cmd = ['git', 'diff', '--cached']
            if file: cmd += ['--', file]
        else:
            cmd = ['git', 'diff']
            if file: cmd += ['--', file]
        r = self._git_run(cmd, cwd_abs, timeout=15, max_output=2 * 1024 * 1024)
        if not r['ok']:
            return self._send_json(200, {'ok': False, 'error': r['stderr'] or r['stdout']})
        return self._send_json(200, {'ok': True, 'diff': r['stdout'], 'mode': mode, 'file': file})

    def _git_scan_diff(self, body, cwd_abs):
        remote = (body.get('remote') or 'origin').strip()
        branch = (body.get('branch') or '').strip()
        if not re.match(r'^[A-Za-z0-9_\-]+$', remote):
            return self._send_json(200, {'ok': False, 'error': '无效的远程名'})
        if branch and not re.match(r'^[A-Za-z0-9_\-./]+$', branch):
            return self._send_json(200, {'ok': False, 'error': '无效的分支名'})
        # 先 fetch 一下，确保远程引用是最新的（失败不致命）
        self._git_run(['git', 'fetch', remote], cwd_abs, timeout=30)
        range_ref = f'{remote}/{branch}..HEAD' if branch else f'{remote}/HEAD..HEAD'
        r = self._git_run(['git', 'diff', range_ref], cwd_abs, timeout=20, max_output=4 * 1024 * 1024)
        if not r['ok']:
            r2 = self._git_run(['git', 'diff', '--root', 'HEAD'], cwd_abs, timeout=20, max_output=4 * 1024 * 1024)
            if not r2['ok']:
                return self._send_json(200, {'ok': True, 'findings': [], 'note': '无法获取 diff，跳过扫描'})
            diff_text = r2['stdout']
        else:
            diff_text = r['stdout']
        file_list_cmd = ['git', 'diff', '--name-only', range_ref]
        fr = self._git_run(file_list_cmd, cwd_abs, timeout=10)
        file_names = [ln.strip() for ln in (fr['stdout'].splitlines() if fr['ok'] else []) if ln.strip()]
        findings = self._scan_sensitive_in_diff(diff_text, file_names)
        return self._send_json(200, {'ok': True, 'findings': findings})

    # ============ 通用工具 ============
    def _git_run(self, cmd, cwd, timeout=10, max_output=512 * 1024):
        """运行 git 命令，返回 dict(ok, stdout, stderr)。强制不走交互、强制 UTF-8。"""
        env = os.environ.copy()
        env['GIT_TERMINAL_PROMPT'] = '0'
        env['LC_ALL'] = 'C.UTF-8'
        env['LANG'] = 'C.UTF-8'
        try:
            proc = subprocess.run(
                cmd, cwd=cwd, timeout=timeout,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=env,
            )
            stdout = proc.stdout.decode('utf-8', errors='replace')
            stderr = proc.stderr.decode('utf-8', errors='replace')
            if max_output and len(stdout) > max_output:
                stdout = stdout[:max_output] + f'\n\n... (输出已截断，原长度 {len(stdout)} 字节)'
            return {'ok': proc.returncode == 0, 'stdout': stdout, 'stderr': stderr, 'returncode': proc.returncode}
        except subprocess.TimeoutExpired:
            return {'ok': False, 'stdout': '', 'stderr': f'命令超时（{timeout}s）'}
        except FileNotFoundError:
            return {'ok': False, 'stdout': '', 'stderr': 'git 命令未找到（请安装 Git 并确保在 PATH 中）'}
        except Exception as e:
            return {'ok': False, 'stdout': '', 'stderr': str(e)}

    def _default_gitignore(self):
        return (
            "# Python\n"
            "__pycache__/\n*.py[cod]\n*.egg-info/\n.venv/\nvenv/\n\n"
            "# Node\nnode_modules/\nnpm-debug.log\n\n"
            "# IDE\n.vscode/\n.idea/\n*.swp\n\n"
            "# OS\n.DS_Store\nThumbs.db\n\n"
            "# Secrets / local config\n.env\n.lms_cookie\n*.local.json\n\n"
            "# Build artifacts\ndist/\nbuild/\n*.log\n"
        )

    def _is_safe_remote_url(self, url):
        """只允许 https:// 或 git@host:path 形式的 URL，防止 file:// / ssh:// 等被滥用。"""
        if not url or len(url) > 500:
            return False
        if re.match(r'^https://[A-Za-z0-9\.\-]+(:\d+)?(/[A-Za-z0-9_\-./~%]*)?$', url):
            return True
        if re.match(r'^git@[A-Za-z0-9\.\-]+:[A-Za-z0-9_\-./~]+$', url):
            return True
        if re.match(r'^ssh://[A-Za-z0-9_\-.@]+(:\d+)?/[A-Za-z0-9_\-./~]+$', url):
            return True
        return False

    def _scan_sensitive_in_diff(self, diff_text, file_names):
        """扫描 diff 文本和文件名，返回潜在敏感信息清单。
        只看 + 开头的新增行（避免误报已存在的内容）。
        """
        findings = []
        # ① 文件名命中（.env 等）
        for fn in (file_names or []):
            base = os.path.basename(fn).lower()
            if base == '.env' or base.startswith('.env.') or fn.lower().endswith('.pem') or fn.lower().endswith('.key'):
                findings.append({
                    'type': '敏感文件',
                    'file': fn,
                    'line': 0,
                    'desc': f'文件 {fn} 看起来包含凭证（建议加入 .gitignore）',
                    'snippet': fn,
                })
        # ② diff 内容扫描
        if not diff_text:
            return findings
        current_file = ''
        line_no = 0
        for raw in diff_text.split('\n'):
            if raw.startswith('+++ b/'):
                current_file = raw[6:].strip()
                line_no = 0
                continue
            if raw.startswith('+++ '):
                current_file = raw[4:].strip().lstrip('b/')
                line_no = 0
                continue
            if raw.startswith('@@'):
                m = re.search(r'\+(\d+)', raw)
                if m:
                    line_no = int(m.group(1)) - 1
                continue
            if raw.startswith('+') and not raw.startswith('+++'):
                line_no += 1
                content = raw[1:]
                for cat_name, pattern, desc in _SENSITIVE_PATTERNS:
                    m = pattern.search(content)
                    if m:
                        matched = m.group(0)
                        if len(matched) > 12:
                            masked = matched[:6] + '***' + matched[-4:]
                        else:
                            masked = matched[:2] + '***'
                        findings.append({
                            'type': cat_name,
                            'file': current_file,
                            'line': line_no,
                            'desc': desc,
                            'snippet': content.strip()[:200],
                            'matched': masked,
                        })
                        break
            elif raw.startswith(' '):
                line_no += 1
            elif raw.startswith('-'):
                pass
        return findings
