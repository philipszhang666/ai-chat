# ============================================================
# server/screenshot.py - 屏幕/窗口截图 mixin
# ============================================================
# 提供 ScreenshotMixin，给 Handler 用。
# action: screenshot
# 参数：
#   mode 可选：auto/window/fullscreen
#   window_title/process_name/hwnd 可选：用于指定窗口截图。
#   all_screens 可选，默认 True，尽量覆盖多显示器。
# 截图自动保存到当前工作目录，返回本地文件路径。
# ============================================================

import base64
import os
import sys
import time
import uuid
from io import BytesIO


class ScreenshotMixin:
    """Handler mixin：屏幕/窗口截图。"""

    def _save_and_encode_response(self, img, *, source, window_info=None,
                                   strategy=None, warnings=None):
        """保存截图到当前工作目录并返回路径信息。"""
        from . import config

        ts = time.strftime('%Y%m%d_%H%M%S')
        name = f'screenshot_{ts}_{source}_{uuid.uuid4().hex[:8]}.png'
        # ⭐ 兜底：若 current_cwd 不是有效目录，回退到 os.getcwd()
        save_dir = config.get_current_cwd()
        if not os.path.isdir(save_dir):
            save_dir = os.getcwd()
        save_path = os.path.join(save_dir, name)
        abs_path = os.path.abspath(save_path)

        # 保存 PNG 到文件
        img.save(abs_path, format='PNG')

        # 读取并编码 base64（前端预览用）
        with open(abs_path, 'rb') as f:
            raw = f.read()
        b64 = base64.b64encode(raw).decode('ascii')

        payload = {
            'ok': True,
            'name': name,
            'path': abs_path,
            'dir': save_dir,
            'mime': 'image/png',
            'size': len(raw),
            'width': img.size[0],
            'height': img.size[1],
            'source': source,
            'strategy': strategy or source,
            'window': window_info,
            'warnings': warnings or [],
            'is_image': True,
            'data': 'data:image/png;base64,' + b64
        }
        self._send_json(200, payload)

    def _grab_fullscreen(self, body):
        try:
            from PIL import ImageGrab
        except Exception as e:
            raise RuntimeError('截图依赖 Pillow 未安装或不可用。请先运行：pip install pillow\n' + str(e))
        all_screens = body.get('all_screens', True)
        try:
            return ImageGrab.grab(all_screens=bool(all_screens))
        except TypeError:
            return ImageGrab.grab()

    def _find_windows_win32(self, title=None, process_name=None, hwnd=None):
        if sys.platform != 'win32':
            return []
        import win32gui
        import win32process
        matches = []
        title_l = (title or '').lower().strip()
        proc_l = (process_name or '').lower().strip()

        def get_proc_name(pid):
            if not proc_l:
                return ''
            try:
                import psutil
                p = psutil.Process(pid)
                return (p.name() or '').lower()
            except Exception:
                return ''

        if hwnd:
            try:
                hwnd_i = int(hwnd)
                if win32gui.IsWindow(hwnd_i):
                    text = win32gui.GetWindowText(hwnd_i)
                    _, pid = win32process.GetWindowThreadProcessId(hwnd_i)
                    return [{'hwnd': hwnd_i, 'title': text, 'pid': pid, 'process_name': get_proc_name(pid)}]
            except Exception:
                return []

        def enum_cb(h, _):
            try:
                if not win32gui.IsWindow(h):
                    return
                text = win32gui.GetWindowText(h) or ''
                if not text.strip():
                    return
                if not win32gui.IsWindowVisible(h):
                    return
                if title_l and title_l not in text.lower():
                    return
                _, pid = win32process.GetWindowThreadProcessId(h)
                pname = get_proc_name(pid)
                if proc_l and pname and proc_l not in pname:
                    return
                matches.append({'hwnd': h, 'title': text, 'pid': pid, 'process_name': pname})
            except Exception:
                pass

        win32gui.EnumWindows(enum_cb, None)
        return matches

    def _capture_window_win32(self, body):
        """窗口截图：双路径策略。
        
        PrintWindow 路径（离屏渲染）→ 支持后台截图，但对 GPU 加速窗口（浏览器）无效。
        ImageGrab 路径（屏幕裁剪）→ 需窗口在前台，对所有窗口都有效。
        
        策略：
        - use_printwindow=true → PrintWindow 优先，检测到黑屏自动回退 ImageGrab
        - use_printwindow=false/不传 → 直接 ImageGrab（默认）
        """
        if sys.platform != 'win32':
            raise RuntimeError('当前系统暂不支持后台窗口截图，仅 Windows 支持 window 模式；请改用 fullscreen。')
        try:
            import win32gui
            from PIL import ImageGrab, Image
        except Exception as e:
            raise RuntimeError('窗口截图依赖 pywin32/Pillow。请先运行：pip install pywin32 pillow\n' + str(e))

        wins = self._find_windows_win32(
            title=body.get('window_title'),
            process_name=body.get('process_name'),
            hwnd=body.get('hwnd')
        )
        if not wins:
            raise RuntimeError('未找到匹配的目标窗口')
        info = wins[0]
        hwnd = int(info['hwnd'])
        use_printwindow = body.get('use_printwindow', False)
        
        warnings = []
        
        # ⭐ 获取窗口精确可见边界（排除 DWM 隐形阴影）
        try:
            import ctypes
            from ctypes import wintypes
            
            class RECT(ctypes.Structure):
                _fields_ = [
                    ('left',   wintypes.LONG),
                    ('top',    wintypes.LONG),
                    ('right',  wintypes.LONG),
                    ('bottom', wintypes.LONG),
                ]
            
            DWMWA_EXTENDED_FRAME_BOUNDS = 9
            rect = RECT()
            dwmapi = ctypes.windll.dwmapi
            hr = dwmapi.DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                ctypes.byref(rect),
                ctypes.sizeof(rect)
            )
            if hr == 0:
                left, top, right, bottom = rect.left, rect.top, rect.right, rect.bottom
            else:
                left, top, right, bottom = win32gui.GetWindowRect(hwnd)
                warnings.append(f'DwmGetWindowAttribute 失败 (hr={hr})，回退到 GetWindowRect。')
        except Exception:
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            warnings.append('DwmGetWindowAttribute 不可用，回退到 GetWindowRect。')
        
        width = right - left
        height = bottom - top
        if width <= 0 or height <= 0:
            raise RuntimeError('目标窗口尺寸无效，可能已最小化')
        
        img = None
        method = ''
        
        # === 路径 1：PrintWindow 离屏渲染（支持后台截图）===
        if use_printwindow:
            try:
                import win32con
                import win32ui
                
                hwnd_dc = win32gui.GetWindowDC(hwnd)
                mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
                save_dc = mfc_dc.CreateCompatibleDC()
                bitmap = win32ui.CreateBitmap()
                bitmap.CreateCompatibleBitmap(mfc_dc, width, height)
                save_dc.SelectObject(bitmap)
                
                try:
                    flags = 2  # PW_CLIENTONLY，只截客户区
                    try:
                        result = win32gui.PrintWindow(hwnd, save_dc.GetSafeHdc(), flags)
                    except AttributeError:
                        result = ctypes.windll.user32.PrintWindow(hwnd, save_dc.GetSafeHdc(), flags)
                        if result == 0:
                            result = False
                    
                    if result:
                        bmpinfo = bitmap.GetInfo()
                        bmpstr = bitmap.GetBitmapBits(True)
                        img = Image.frombuffer(
                            'RGB',
                            (bmpinfo['bmWidth'], bmpinfo['bmHeight']),
                            bmpstr, 'raw', 'BGRX', 0, 1
                        )
                        
                        # ⭐ 检测黑屏：GPU 加速窗口 PrintWindow 返回全黑位图
                        #    采样边缘和中心像素，如果平均亮度 < 8 则判定为黑屏
                        sample_pixels = [
                            img.getpixel((width//2, height//2)),
                            img.getpixel((10, 10)),
                            img.getpixel((width-10, 10)),
                            img.getpixel((10, height-10)),
                            img.getpixel((width-10, height-10)),
                        ]
                        avg_brightness = sum(p[0] + p[1] + p[2] for p in sample_pixels) / (len(sample_pixels) * 3)
                        if avg_brightness < 8:
                            img = None  # 黑屏，回退到 ImageGrab
                            warnings.append('PrintWindow 返回黑屏（疑似 GPU 加速窗口），回退到屏幕裁剪。')
                        else:
                            method = 'printwindow'
                    else:
                        warnings.append('PrintWindow 返回失败，回退到屏幕裁剪。')
                finally:
                    win32gui.DeleteObject(bitmap.GetHandle())
                    save_dc.DeleteDC()
                    mfc_dc.DeleteDC()
                    win32gui.ReleaseDC(hwnd, hwnd_dc)
            except Exception as e:
                warnings.append(f'PrintWindow 路径异常：{e}，回退到屏幕裁剪。')
        
        # === 路径 2：ImageGrab 屏幕像素裁剪（需窗口在前台）===
        if img is None:
            try:
                img = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
            except TypeError:
                img = ImageGrab.grab(bbox=(left, top, right, bottom))
            method = method or 'screengrab'

        if img is None:
            raise RuntimeError('截图失败：所有路径均无法获取图像')

        info.update({'rect': [left, top, right, bottom], 'method': method})
        return img, info, warnings

    def handle_screenshot(self, body):
        try:
            mode = (body.get('mode') or 'auto').lower().strip()
            has_window_hint = any(body.get(k) for k in ('window_title', 'process_name', 'hwnd'))
            strategy = []
            warnings = []
            source = 'fullscreen'
            window_info = None

            img = None
            if mode in ('auto', 'window') and has_window_hint:
                strategy.append('priority_1_window')
                try:
                    img, window_info, win_warnings = self._capture_window_win32(body)
                    warnings.extend(win_warnings or [])
                    source = 'window'
                except Exception as e:
                    if mode == 'window':
                        return self._send_json(200, {'ok': False, 'error': f'指定窗口截图失败：{e}', 'source': 'window'})
                    warnings.append(f'优先级 1 指定窗口截图失败：{e}；已进入优先级 2 全屏截图。')

            if img is None:
                strategy.append('priority_2_fullscreen')
                img = self._grab_fullscreen(body)
                source = 'fullscreen'

            self._save_and_encode_response(
                img,
                source=source,
                window_info=window_info,
                strategy=' -> '.join(strategy) if strategy else source,
                warnings=warnings
            )
        except Exception as e:
            self._send_json(200, {
                'ok': False,
                'error': f'截图失败：{e}',
                'fallback': '请将目标窗口置于前台后重试，或改用全屏截图。'
            })

    def handle_list_windows(self, body):
        try:
            title = body.get('window_title') or body.get('title')
            process_name = body.get('process_name')
            wins = self._find_windows_win32(title=title, process_name=process_name)
            self._send_json(200, {'ok': True, 'windows': wins, 'count': len(wins), 'platform': sys.platform})
        except Exception as e:
            self._send_json(200, {'ok': False, 'error': f'列出窗口失败：{e}', 'platform': sys.platform})
