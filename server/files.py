# ============================================================
# server/files.py - 文件操作 mixin
# ============================================================
# 提供 FilesMixin，给 Handler 用。包含：
#   handle_read_file / handle_read_file_binary
#   handle_write_file / handle_append_file / handle_edit_file
#   handle_delete_file
#   handle_list_dir
#   handle_search
#   handle_file_info
# ============================================================

import base64
import datetime
import fnmatch
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil

from . import config
from .sandbox import check_path_or_error


def _strip_patch_path(path):
    path = (path or '').strip()
    if not path or path == '/dev/null':
        return path
    if path.startswith('"') and path.endswith('"'):
        path = path[1:-1]
    if path.startswith('a/') or path.startswith('b/'):
        path = path[2:]
    return path


def _parse_hunk_header(line):
    m = re.match(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', line)
    if not m:
        raise ValueError(f'无效 hunk 头: {line}')
    return {
        'old_start': int(m.group(1)),
        'old_count': int(m.group(2) or '1'),
        'new_start': int(m.group(3)),
        'new_count': int(m.group(4) or '1'),
        'lines': []
    }


def _parse_unified_patch(patch_text):
    lines = patch_text.splitlines()
    files = []
    current = None
    hunk = None
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('diff --git '):
            i += 1
            continue
        if line.startswith('--- '):
            old_path = _strip_patch_path(line[4:].split('\t', 1)[0].strip())
            if i + 1 >= len(lines) or not lines[i + 1].startswith('+++ '):
                raise ValueError(f'缺少 +++ 文件头: {line}')
            new_path = _strip_patch_path(lines[i + 1][4:].split('\t', 1)[0].strip())
            current = {
                'old_path': old_path,
                'new_path': new_path,
                'hunks': []
            }
            files.append(current)
            hunk = None
            i += 2
            continue
        if line.startswith('@@ '):
            if current is None:
                raise ValueError('hunk 出现在文件头之前')
            hunk = _parse_hunk_header(line)
            current['hunks'].append(hunk)
            i += 1
            continue
        if hunk is not None:
            if line.startswith((' ', '+', '-')):
                hunk['lines'].append(line)
            elif line.startswith('\\ No newline at end of file'):
                pass
            elif line.startswith(('index ', 'new file mode ', 'deleted file mode ', 'similarity index ')):
                pass
            else:
                raise ValueError(f'无法解析 patch 行: {line}')
        i += 1
    if not files:
        raise ValueError('未找到 unified diff 文件头（需要 --- / +++ / @@）')
    return files


def _find_hunk_position(content_lines, expected_old, expected_idx):
    if content_lines[expected_idx:expected_idx + len(expected_old)] == expected_old:
        return expected_idx
    matches = []
    max_start = len(content_lines) - len(expected_old)
    for start in range(max_start + 1):
        if content_lines[start:start + len(expected_old)] == expected_old:
            matches.append(start)
            if len(matches) > 1:
                break
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise ValueError('hunk 上下文不匹配，文件可能已变化')
    raise ValueError('hunk 上下文在文件中匹配多处，请提供更多上下文')


def _apply_file_patch(abs_path, file_patch):
    if file_patch['old_path'] == '/dev/null':
        content_lines = []
        existed = False
    else:
        if not os.path.exists(abs_path):
            raise ValueError(f'文件不存在: {abs_path}')
        with open(abs_path, 'r', encoding='utf-8', errors='replace') as f:
            content_lines = f.read().splitlines(keepends=True)
        existed = True

    out = list(content_lines)
    offset = 0
    added = 0
    removed = 0
    for hunk in file_patch['hunks']:
        old_lines = [(ln[1:] + '\n') for ln in hunk['lines'] if ln.startswith((' ', '-'))]
        new_lines = [(ln[1:] + '\n') for ln in hunk['lines'] if ln.startswith((' ', '+'))]
        expected_idx = max(0, hunk['old_start'] - 1 + offset)
        pos = _find_hunk_position(out, old_lines, expected_idx)
        out[pos:pos + len(old_lines)] = new_lines
        offset += len(new_lines) - len(old_lines)
        added += sum(1 for ln in hunk['lines'] if ln.startswith('+'))
        removed += sum(1 for ln in hunk['lines'] if ln.startswith('-'))

    return ''.join(out), {'existed': existed, 'added': added, 'removed': removed, 'hunks': len(file_patch['hunks'])}


def _checkpoint_base_dir():
    return os.path.join(config.WORKSPACE_ROOT, '.agent', 'checkpoints')


def _normalize_checkpoint_id(checkpoint_id):
    cid = str(checkpoint_id or '').strip()
    if not cid:
        return ''
    if not re.fullmatch(r'ckpt_[A-Za-z0-9_.-]{1,140}', cid):
        return ''
    return cid


def _new_checkpoint_id():
    stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    return f'ckpt_{stamp}_{secrets.token_hex(4)}'


def _workspace_rel_path(abs_path):
    try:
        return os.path.relpath(os.path.realpath(abs_path), config.WORKSPACE_ROOT).replace(os.sep, '/')
    except Exception:
        return os.path.basename(abs_path)


def _checkpoint_dir_for(checkpoint_id):
    return os.path.join(_checkpoint_base_dir(), checkpoint_id)


def _manifest_path(checkpoint_dir):
    return os.path.join(checkpoint_dir, 'manifest.json')


def _load_checkpoint_manifest(checkpoint_dir, checkpoint_id, session_id, reason):
    path = _manifest_path(checkpoint_dir)
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                data.setdefault('id', checkpoint_id)
                data.setdefault('files', [])
                return data
        except Exception:
            pass
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return {
        'id': checkpoint_id,
        'createdAt': now,
        'updatedAt': now,
        'reason': reason,
        'sessionId': session_id or '',
        'workspace': config.WORKSPACE_ROOT,
        'files': []
    }


def _write_checkpoint_manifest(checkpoint_dir, manifest):
    manifest['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with open(_manifest_path(checkpoint_dir), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def _is_inside_checkpoint_store(abs_path):
    try:
        real = os.path.realpath(abs_path)
        base = os.path.realpath(_checkpoint_base_dir())
        return os.path.commonpath([real, base]) == base
    except Exception:
        return False


def _ensure_prewrite_checkpoint(paths, checkpoint_id='', session_id='', reason='before_code_mutation'):
    unique_paths = []
    seen = set()
    for p in paths or []:
        if not p or _is_inside_checkpoint_store(p):
            continue
        real = os.path.realpath(p)
        key = real.lower() if os.name == 'nt' else real
        if key not in seen:
            seen.add(key)
            unique_paths.append(real)
    if not unique_paths:
        return None

    cid = _normalize_checkpoint_id(checkpoint_id) or _new_checkpoint_id()
    checkpoint_dir = _checkpoint_dir_for(cid)
    os.makedirs(os.path.join(checkpoint_dir, 'files'), exist_ok=True)
    manifest = _load_checkpoint_manifest(checkpoint_dir, cid, session_id, reason)

    existing = set()
    for item in manifest.get('files', []):
        rel = str(item.get('path') or '')
        existing.add(rel.lower() if os.name == 'nt' else rel)

    added_entries = []
    for abs_path in unique_paths:
        rel_path = _workspace_rel_path(abs_path)
        rel_key = rel_path.lower() if os.name == 'nt' else rel_path
        if rel_key in existing:
            continue

        existed = os.path.exists(abs_path)
        is_file = os.path.isfile(abs_path)
        is_dir = os.path.isdir(abs_path)
        snapshot_rel = None
        sha_before = None
        size_before = None
        if is_file:
            snapshot_rel = '/'.join(['files', rel_path])
            snapshot_abs = os.path.join(checkpoint_dir, *snapshot_rel.split('/'))
            os.makedirs(os.path.dirname(snapshot_abs), exist_ok=True)
            shutil.copy2(abs_path, snapshot_abs)
            sha_before = _sha256_file(abs_path)
            size_before = os.path.getsize(abs_path)

        entry = {
            'path': rel_path,
            'absPath': abs_path,
            'existed': bool(existed),
            'type': 'file' if is_file else ('directory' if is_dir else 'missing'),
            'snapshotPath': snapshot_rel,
            'sha256Before': sha_before,
            'sizeBefore': size_before
        }
        manifest.setdefault('files', []).append(entry)
        existing.add(rel_key)
        added_entries.append(entry)

    _write_checkpoint_manifest(checkpoint_dir, manifest)
    return {
        'id': cid,
        'dir': checkpoint_dir,
        'manifestPath': _manifest_path(checkpoint_dir),
        'files': added_entries,
        'totalFiles': len(manifest.get('files', []))
    }


def _public_checkpoint_manifest(checkpoint_id, manifest, checkpoint_dir):
    files = manifest.get('files', []) if isinstance(manifest, dict) else []
    return {
        'id': checkpoint_id,
        'createdAt': manifest.get('createdAt') if isinstance(manifest, dict) else None,
        'updatedAt': manifest.get('updatedAt') if isinstance(manifest, dict) else None,
        'reason': manifest.get('reason') if isinstance(manifest, dict) else '',
        'sessionId': manifest.get('sessionId') if isinstance(manifest, dict) else '',
        'workspace': manifest.get('workspace') if isinstance(manifest, dict) else config.WORKSPACE_ROOT,
        'dir': checkpoint_dir,
        'manifestPath': _manifest_path(checkpoint_dir),
        'fileCount': len(files),
        'files': [{
            'path': item.get('path'),
            'existed': bool(item.get('existed')),
            'type': item.get('type') or 'missing',
            'snapshotPath': item.get('snapshotPath'),
            'sha256Before': item.get('sha256Before'),
            'sizeBefore': item.get('sizeBefore')
        } for item in files if isinstance(item, dict)]
    }


def _read_checkpoint(checkpoint_id):
    cid = _normalize_checkpoint_id(checkpoint_id)
    if not cid:
        raise ValueError('checkpoint_id 无效')
    checkpoint_dir = _checkpoint_dir_for(cid)
    manifest_file = _manifest_path(checkpoint_dir)
    if not os.path.isfile(manifest_file):
        raise FileNotFoundError(f'checkpoint 不存在: {cid}')
    with open(manifest_file, 'r', encoding='utf-8') as f:
        manifest = json.load(f)
    if not isinstance(manifest, dict):
        raise ValueError('checkpoint manifest 格式无效')
    manifest.setdefault('id', cid)
    manifest.setdefault('files', [])
    return cid, checkpoint_dir, manifest


def _list_checkpoints(limit=20):
    base = _checkpoint_base_dir()
    if not os.path.isdir(base):
        return []
    rows = []
    for name in os.listdir(base):
        cid = _normalize_checkpoint_id(name)
        if not cid:
            continue
        checkpoint_dir = _checkpoint_dir_for(cid)
        manifest_file = _manifest_path(checkpoint_dir)
        if not os.path.isfile(manifest_file):
            continue
        try:
            with open(manifest_file, 'r', encoding='utf-8') as f:
                manifest = json.load(f)
            public = _public_checkpoint_manifest(cid, manifest, checkpoint_dir)
            public['_mtime'] = os.path.getmtime(manifest_file)
            rows.append(public)
        except Exception:
            continue
    rows.sort(key=lambda x: x.get('_mtime') or 0, reverse=True)
    for row in rows:
        row.pop('_mtime', None)
    return rows[:max(1, min(int(limit or 20), 100))]


def _restore_checkpoint(checkpoint_id, force=False, session_id=''):
    cid, checkpoint_dir, manifest = _read_checkpoint(checkpoint_id)
    files = [x for x in manifest.get('files', []) if isinstance(x, dict)]
    if not files:
        return {
            'id': cid,
            'restored': [],
            'deleted': [],
            'skipped': [],
            'conflicts': [],
            'safetyCheckpoint': None
        }

    targets = []
    for item in files:
        rel_path = item.get('path') or ''
        if not rel_path:
            continue
        target, err = check_path_or_error(rel_path, must_exist=False)
        if err:
            raise ValueError(err)
        targets.append((item, target))

    conflicts = []
    for item, target in targets:
        existed_before = bool(item.get('existed'))
        sha_before = item.get('sha256Before')
        current_exists = os.path.exists(target)
        if existed_before:
            if current_exists and os.path.isfile(target) and sha_before:
                try:
                    if _sha256_file(target) != sha_before:
                        conflicts.append({
                            'path': item.get('path'),
                            'reason': 'current_file_changed_after_checkpoint'
                        })
                except Exception:
                    conflicts.append({
                        'path': item.get('path'),
                        'reason': 'cannot_hash_current_file'
                    })
            elif current_exists and not os.path.isfile(target):
                conflicts.append({
                    'path': item.get('path'),
                    'reason': 'current_path_is_not_file'
                })
        else:
            if current_exists:
                conflicts.append({
                    'path': item.get('path'),
                    'reason': 'new_path_exists_and_would_be_deleted'
                })

    if conflicts and not force:
        return {
            'id': cid,
            'ok': False,
            'needs_force': True,
            'conflicts': conflicts,
            'restored': [],
            'deleted': [],
            'skipped': [],
            'safetyCheckpoint': None
        }

    safety = _ensure_prewrite_checkpoint(
        [target for _, target in targets],
        session_id=session_id,
        reason=f'before_restore_checkpoint:{cid}'
    )

    restored = []
    deleted = []
    skipped = []
    for item, target in targets:
        rel_path = item.get('path') or ''
        existed_before = bool(item.get('existed'))
        snapshot_rel = item.get('snapshotPath')
        if existed_before:
            if not snapshot_rel:
                skipped.append({'path': rel_path, 'reason': 'missing_snapshot'})
                continue
            snapshot_abs = os.path.join(checkpoint_dir, *str(snapshot_rel).split('/'))
            if not os.path.isfile(snapshot_abs):
                skipped.append({'path': rel_path, 'reason': 'snapshot_file_missing'})
                continue
            parent = os.path.dirname(target)
            if parent:
                os.makedirs(parent, exist_ok=True)
            shutil.copy2(snapshot_abs, target)
            restored.append({'path': rel_path})
        else:
            if os.path.exists(target):
                if os.path.isfile(target):
                    os.remove(target)
                    deleted.append({'path': rel_path})
                elif os.path.isdir(target) and not os.listdir(target):
                    os.rmdir(target)
                    deleted.append({'path': rel_path, 'type': 'dir'})
                else:
                    skipped.append({'path': rel_path, 'reason': 'target_not_empty_or_not_file'})
            else:
                skipped.append({'path': rel_path, 'reason': 'already_absent'})

    return {
        'id': cid,
        'ok': True,
        'restored': restored,
        'deleted': deleted,
        'skipped': skipped,
        'conflicts': conflicts,
        'safetyCheckpoint': safety,
        'checkpoint': _public_checkpoint_manifest(cid, manifest, checkpoint_dir)
    }


class FilesMixin:
    """Handler mixin：所有文件 CRUD 和搜索"""

    # ============ 读文件（文本） ============
    def _checkpoint_before_mutation(self, paths, body, action):
        return _ensure_prewrite_checkpoint(
            paths,
            checkpoint_id=(body or {}).get('checkpoint_id') or (body or {}).get('checkpointId'),
            session_id=getattr(self, 'session_id', ''),
            reason=action or 'before_code_mutation'
        )

    def handle_read_file(self, body):
        path, err = check_path_or_error(body.get('path', ''))
        if err: return self._send_json(200, {'ok': False, 'error': err})
        print(f'📖 [读文件] {path}')
        if not os.path.exists(path):
            return self._send_json(200, {'ok': False, 'error': f'文件不存在: {path}'})
        if not os.path.isfile(path):
            return self._send_json(200, {'ok': False, 'error': f'不是文件: {path}'})
        try:
            start_line = body.get('start_line')
            end_line = body.get('end_line')
            has_range = start_line is not None or end_line is not None
            if has_range:
                try:
                    start = max(1, int(start_line or 1))
                    end = int(end_line) if end_line is not None else None
                except (TypeError, ValueError):
                    return self._send_json(200, {'ok': False, 'error': 'start_line/end_line 必须是数字'})
                if end is not None and end < start:
                    return self._send_json(200, {'ok': False, 'error': 'end_line 不能小于 start_line'})
            else:
                start, end = 1, None

            size = os.path.getsize(path)
            max_read_chars = 1024 * 1024
            if size > max_read_chars and not has_range:
                return self._send_json(200, {
                    'ok': False,
                    'error': f'文件过大（{size}字节）。请指定 start_line/end_line 分段读取；如果是图片/PDF，请用 attach_file 工具。'
                })

            if has_range and size > max_read_chars:
                parts = []
                total = 0
                truncated = False
                with open(path, 'r', encoding='utf-8', errors='replace') as f:
                    for line_no, line in enumerate(f, 1):
                        if line_no < start:
                            continue
                        if end is not None and line_no > end:
                            break
                        remaining = max_read_chars - total
                        if remaining <= 0:
                            truncated = True
                            break
                        if len(line) > remaining:
                            parts.append(line[:remaining])
                            total += remaining
                            truncated = True
                            break
                        parts.append(line)
                        total += len(line)
                content = ''.join(parts)
                if truncated:
                    content += '\n\n[内容已截断：单次 read_note 最多返回约 1MB。请缩小 start_line/end_line 范围继续读取。]'
                return self._send_json(200, {
                    'ok': True,
                    'path': path,
                    'content': content,
                    'size': size,
                    'start_line': start,
                    'end_line': end,
                    'truncated': truncated
                })

            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            if has_range:
                lines = content.split('\n')
                s = start - 1
                e = min(len(lines), end or len(lines))
                content = '\n'.join(lines[s:e])
            self._send_json(200, {'ok': True, 'path': path, 'content': content, 'size': size})
        except Exception as e:
            self._send_json(200, {'ok': False, 'error': str(e)})

    # ============ 读文件（二进制 → base64） ============
    def handle_read_file_binary(self, body):
        """读取任意文件并返回 base64（用于图片/PDF 等二进制文件）"""
        path, err = check_path_or_error(body.get('path', ''))
        if err: return self._send_json(200, {'ok': False, 'error': err})
        if not os.path.exists(path):
            return self._send_json(200, {'ok': False, 'error': f'文件不存在: {path}'})
        if not os.path.isfile(path):
            return self._send_json(200, {'ok': False, 'error': f'不是文件: {path}'})

        try:
            size = os.path.getsize(path)
            max_size = 20 * 1024 * 1024
            if size > max_size:
                return self._send_json(200, {
                    'ok': False,
                    'error': f'文件过大（{size / 1024 / 1024:.1f}MB），上限 {max_size / 1024 / 1024:.0f}MB'
                })

            with open(path, 'rb') as f:
                content = f.read()
            b64 = base64.b64encode(content).decode('ascii')

            # 猜测 MIME 类型
            mime, _ = mimetypes.guess_type(path)
            if not mime:
                ext = os.path.splitext(path)[1].lower()
                mime_map = {
                    '.pdf': 'application/pdf',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.webp': 'image/webp',
                    '.bmp': 'image/bmp',
                    '.svg': 'image/svg+xml',
                    '.tiff': 'image/tiff', '.tif': 'image/tiff',
                    '.ico': 'image/x-icon',
                    '.mp3': 'audio/mpeg',
                    '.wav': 'audio/wav',
                    '.ogg': 'audio/ogg',
                    '.m4a': 'audio/mp4',
                    '.mp4': 'video/mp4',
                    '.avi': 'video/x-msvideo',
                    '.mov': 'video/quicktime',
                    '.webm': 'video/webm',
                    '.zip': 'application/zip',
                    '.rar': 'application/x-rar-compressed',
                    '.7z': 'application/x-7z-compressed',
                    '.tar': 'application/x-tar',
                    '.gz': 'application/gzip',
                    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                    '.doc': 'application/msword',
                    '.xls': 'application/vnd.ms-excel',
                    '.ppt': 'application/vnd.ms-powerpoint',
                }
                mime = mime_map.get(ext, 'application/octet-stream')

            name = os.path.basename(path)
            is_image = mime.startswith('image/')

            print(f'📎 [读取二进制] {path}')
            print(f'   📦 大小: {size} 字节 ({size / 1024:.1f} KB)')
            print(f'   🏷️  MIME: {mime}')
            print(f'   🖼️  是图片: {is_image}')

            self._send_json(200, {
                'ok': True,
                'path': path,
                'name': name,
                'size': size,
                'mime': mime,
                'is_image': is_image,
                'data': f'data:{mime};base64,{b64}'
            })
        except Exception as e:
            print(f'   ❌ 失败: {e}')
            self._send_json(200, {'ok': False, 'error': str(e)})

    # ============ 写文件 ============
    def handle_write_file(self, body):
        path, err = check_path_or_error(body.get('path', ''))
        if err: return self._send_json(200, {'ok': False, 'error': err})
        content = body.get('content', '')
        print(f'✍️  [写文件] {path} ({len(content)} 字符)')
        try:
            checkpoint = self._checkpoint_before_mutation([path], body, 'write_file')
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            existed = os.path.exists(path)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            print(f'   ✅ 成功！')
            self._send_json(200, {
                'ok': True, 'path': path,
                'action': '覆盖' if existed else '创建',
                'bytes_written': len(content.encode('utf-8')),
                'checkpoint_id': checkpoint['id'] if checkpoint else None,
                'checkpoint': checkpoint
            })
        except Exception as e:
            print(f'   ❌ 失败: {e}')
            self._send_json(200, {'ok': False, 'error': str(e)})

    # ============ 追加文件 ============
    def handle_append_file(self, body):
        path, err = check_path_or_error(body.get('path', ''))
        if err: return self._send_json(200, {'ok': False, 'error': err})
        content = body.get('content', '')
        print(f'📝 [追加] {path} (+{len(content)} 字符)')
        try:
            checkpoint = self._checkpoint_before_mutation([path], body, 'append_file')
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(path, 'a', encoding='utf-8') as f:
                f.write(content)
            self._send_json(200, {
                'ok': True, 'path': path,
                'bytes_appended': len(content.encode('utf-8')),
                'checkpoint_id': checkpoint['id'] if checkpoint else None,
                'checkpoint': checkpoint
            })
        except Exception as e:
            self._send_json(200, {'ok': False, 'error': str(e)})

    # ============ 精确编辑 ============
    def handle_edit_file(self, body):
        path, err = check_path_or_error(body.get('path', ''))
        if err: return self._send_json(200, {'ok': False, 'error': err})
        old_text = body.get('old_text', '')
        new_text = body.get('new_text', '')
        print(f'✏️  [编辑] {path}')
        if not os.path.exists(path):
            return self._send_json(200, {'ok': False, 'error': f'文件不存在: {path}'})
        if not old_text:
            return self._send_json(200, {'ok': False, 'error': 'old_text 不能为空'})
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            count = content.count(old_text)
            if count == 0:
                return self._send_json(200, {'ok': False, 'error': f'未找到要替换的文本'})
            if count > 1:
                return self._send_json(200, {
                    'ok': False,
                    'error': f'找到 {count} 处匹配，请提供更具体的上下文'
                })
            new_content = content.replace(old_text, new_text, 1)
            checkpoint = self._checkpoint_before_mutation([path], body, 'edit_file')
            with open(path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            self._send_json(200, {
                'ok': True,
                'path': path,
                'checkpoint_id': checkpoint['id'] if checkpoint else None,
                'checkpoint': checkpoint
            })
        except Exception as e:
            self._send_json(200, {'ok': False, 'error': str(e)})

    # ============ Patch 编辑 ============
    def handle_apply_patch(self, body):
        patch_text = body.get('patch', '')
        dry_run = bool(body.get('dry_run', False))
        if not patch_text.strip():
            return self._send_json(200, {'ok': False, 'error': 'patch 不能为空'})
        print(f'🧩 [Apply Patch] dry_run={dry_run}, {len(patch_text)} 字符')
        try:
            file_patches = _parse_unified_patch(patch_text)
            prepared = []
            for fp in file_patches:
                target_rel = fp['new_path'] if fp['new_path'] != '/dev/null' else fp['old_path']
                target, err = check_path_or_error(target_rel, must_exist=False)
                if err:
                    return self._send_json(200, {'ok': False, 'error': err})
                if fp['new_path'] == '/dev/null':
                    return self._send_json(200, {'ok': False, 'error': '当前 apply_patch 暂不支持删除文件，请使用 delete_note'})
                new_content, stats = _apply_file_patch(target, fp)
                prepared.append({
                    'path': target,
                    'rel_path': target_rel,
                    'content': new_content,
                    'stats': stats
                })

            checkpoint = None
            if not dry_run:
                checkpoint = self._checkpoint_before_mutation(
                    [item['path'] for item in prepared],
                    body,
                    'apply_patch'
                )
                for item in prepared:
                    parent = os.path.dirname(item['path'])
                    if parent:
                        os.makedirs(parent, exist_ok=True)
                    with open(item['path'], 'w', encoding='utf-8') as f:
                        f.write(item['content'])

            files = [{
                'path': item['path'],
                'added': item['stats']['added'],
                'removed': item['stats']['removed'],
                'hunks': item['stats']['hunks'],
                'action': '修改' if item['stats']['existed'] else '创建'
            } for item in prepared]
            return self._send_json(200, {
                'ok': True,
                'dry_run': dry_run,
                'files': files,
                'checkpoint_id': checkpoint['id'] if checkpoint else None,
                'checkpoint': checkpoint,
                'message': ('Patch 预检通过' if dry_run else 'Patch 已应用')
            })
        except Exception as e:
            return self._send_json(200, {'ok': False, 'error': str(e)})

    # ============ 删除 ============
    def handle_list_checkpoints(self, body):
        try:
            limit = body.get('limit', 20)
            checkpoints = _list_checkpoints(limit)
            return self._send_json(200, {
                'ok': True,
                'checkpoints': checkpoints,
                'count': len(checkpoints)
            })
        except Exception as e:
            return self._send_json(200, {'ok': False, 'error': str(e)})

    def handle_restore_checkpoint(self, body):
        checkpoint_id = body.get('checkpoint_id') or body.get('checkpointId') or ''
        force = bool(body.get('force', False))
        if not checkpoint_id:
            return self._send_json(200, {'ok': False, 'error': 'checkpoint_id 不能为空'})
        try:
            result = _restore_checkpoint(
                checkpoint_id,
                force=force,
                session_id=getattr(self, 'session_id', '')
            )
            ok = bool(result.get('ok'))
            return self._send_json(200, {
                'ok': ok,
                **result
            })
        except Exception as e:
            return self._send_json(200, {'ok': False, 'error': str(e)})

    def handle_delete_file(self, body):
        path, err = check_path_or_error(body.get('path', ''))
        if err: return self._send_json(200, {'ok': False, 'error': err})
        print(f'🗑️  [删除] {path}')
        if not os.path.exists(path):
            return self._send_json(200, {'ok': False, 'error': '路径不存在'})
        try:
            checkpoint = self._checkpoint_before_mutation([path], body, 'delete_file')
            if os.path.isfile(path):
                os.remove(path)
                self._send_json(200, {
                    'ok': True,
                    'path': path,
                    'type': 'file',
                    'checkpoint_id': checkpoint['id'] if checkpoint else None,
                    'checkpoint': checkpoint
                })
            elif os.path.isdir(path):
                if os.listdir(path):
                    return self._send_json(200, {'ok': False, 'error': '目录非空'})
                os.rmdir(path)
                self._send_json(200, {
                    'ok': True,
                    'path': path,
                    'type': 'dir',
                    'checkpoint_id': checkpoint['id'] if checkpoint else None,
                    'checkpoint': checkpoint
                })
        except Exception as e:
            self._send_json(200, {'ok': False, 'error': str(e)})

    # ============ 列目录 ============
    def handle_list_dir(self, body):
        path, err = check_path_or_error(body.get('path', '') or '.')
        if err: return self._send_json(200, {'ok': False, 'error': err})
        print(f'📁 [列目录] {path}')
        if not os.path.isdir(path):
            return self._send_json(200, {'ok': False, 'error': f'不是目录: {path}'})
        try:
            entries = []
            for name in sorted(os.listdir(path)):
                full = os.path.join(path, name)
                try:
                    is_dir = os.path.isdir(full)
                    size = 0 if is_dir else os.path.getsize(full)
                    entries.append({
                        'name': name,
                        'type': 'dir' if is_dir else 'file',
                        'size': size
                    })
                except:
                    pass
            self._send_json(200, {'ok': True, 'path': path, 'entries': entries})
        except Exception as e:
            self._send_json(200, {'ok': False, 'error': str(e)})

    # ============ 搜索 ============
    def handle_search(self, body):
        path, err = check_path_or_error(body.get('path', '') or '.')
        if err: return self._send_json(200, {'ok': False, 'error': err})
        pattern = body.get('pattern', '')
        file_glob = body.get('file_glob', '*')
        max_results = min(int(body.get('max_results', 50)), 200)
        print(f'🔍 [搜索] "{pattern}" in {path}')
        if not pattern:
            return self._send_json(200, {'ok': False, 'error': 'pattern 不能为空'})
        try:
            regex = re.compile(pattern, re.IGNORECASE)
        except:
            regex = None
        results = []
        try:
            for root, dirs, files in os.walk(path):
                dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules', '__pycache__', '.venv', 'venv')]
                for fname in files:
                    if not fnmatch.fnmatch(fname, file_glob):
                        continue
                    fpath = os.path.join(root, fname)
                    try:
                        if os.path.getsize(fpath) > 512 * 1024:
                            continue
                        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                            for line_no, line in enumerate(f, 1):
                                if (regex and regex.search(line)) or (not regex and pattern.lower() in line.lower()):
                                    results.append({
                                        'file': fpath,
                                        'line': line_no,
                                        'content': line.rstrip()[:200]
                                    })
                                    if len(results) >= max_results:
                                        break
                    except:
                        pass
                    if len(results) >= max_results:
                        break
                if len(results) >= max_results:
                    break
            self._send_json(200, {'ok': True, 'pattern': pattern, 'results': results})
        except Exception as e:
            self._send_json(200, {'ok': False, 'error': str(e)})

    # ============ 文件信息 ============
    def handle_file_info(self, body):
        path, err = check_path_or_error(body.get('path', ''))
        if err: return self._send_json(200, {'ok': False, 'error': err})
        if not os.path.exists(path):
            return self._send_json(200, {'ok': False, 'error': '路径不存在'})
        try:
            st = os.stat(path)
            self._send_json(200, {
                'ok': True,
                'path': path,
                'type': 'dir' if os.path.isdir(path) else 'file',
                'size': st.st_size,
                'modified': st.st_mtime
            })
        except Exception as e:
            self._send_json(200, {'ok': False, 'error': str(e)})
