# ============================================================
# server/web.py - 网络搜索 & 网页抓取
# ============================================================
# 提供 WebMixin。包含：
#   handle_web_search - 5 引擎自动回退（bing-cn/360/sogou/bing-global/百度）
#   handle_fetch_url  - 抓取并提取网页正文
#
# 依赖第三方库 requests（仅这里和 LMS 教务工具用到）
# ============================================================

import os
import re
from html import unescape
from urllib.parse import quote_plus


class WebMixin:
    """Handler mixin：网络搜索 + 网页抓取"""

    # ============ 🌐 网络搜索（多引擎五级回退） ============
    def handle_web_search(self, body):
        """网页搜索，返回标题 + URL + 摘要列表。不需要任何 API Key。

        引擎按可用性排序（自动回退）：
          1. Bing 国内 (cn.bing.com)   — 默认主力
          2. 搜狗 (sogou.com)          — 裸访问，结构稳定
          3. 360 (so.com)              — 裸访问，有 data-mdurl 直接拿真实 URL
          4. 百度 (baidu.com)          — 需先访问首页拿 Cookie
          5. Bing 国际 (www.bing.com)  — 兜底，海外内容更全

        region:
          - 'cn' / 'cn-zh' / 'zh-cn' / 缺省 → 国内引擎优先
          - 'global' / 'us-en' / 'wt-wt' / 'en' → Bing 国际优先
        """
        query = (body.get('query') or '').strip()
        max_results = min(int(body.get('max_results', 8)), 20)
        region = (body.get('region') or 'cn').lower()

        if not query:
            return self._send_json(200, {'ok': False, 'error': 'query 不能为空'})

        print(f'🌐 [网络搜索] "{query}" (max={max_results}, region={region})')

        try:
            import requests
        except ImportError:
            return self._send_json(200, {'ok': False, 'error': '后端缺少 requests 模块，请运行：pip install requests'})

        UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
        BASE_HEADERS = {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            # ⭐ 不要写 br！requests 默认不支持 Brotli 解压，会拿到二进制乱码
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        }

        # 通用工具：去 HTML 标签 + HTML 实体解码 + 折叠空白
        def _clean(s):
            if not s:
                return ''
            s = re.sub(r'<[^>]+>', '', s)
            s = unescape(s)
            s = re.sub(r'\s+', ' ', s).strip()
            return s

        # ===== Bing 国内 / 国际版 =====
        def search_bing(base_url, mkt='zh-CN'):
            url = f'{base_url}/search?q={quote_plus(query)}&mkt={mkt}&count={max_results}'
            resp = requests.get(url, headers=BASE_HEADERS, timeout=10)
            html = resp.text
            out = []
            for m in re.finditer(
                r'<li[^>]*\bclass="[^"]*b_algo[^"]*"[^>]*>(.*?)</li>',
                html, flags=re.S
            ):
                block = m.group(1)
                tm = re.search(r'<h2[^>]*>\s*<a[^>]*\shref="([^"]+)"[^>]*>(.*?)</a>',
                               block, flags=re.S)
                if not tm:
                    continue
                raw_url, raw_title = tm.group(1), tm.group(2)
                if not raw_url.startswith('http'):
                    continue
                sm = re.search(r'<p[^>]*\bclass="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)</p>',
                               block, flags=re.S)
                if not sm:
                    sm = re.search(r'<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>.*?<p[^>]*>(.*?)</p>',
                                   block, flags=re.S)
                snippet = _clean(sm.group(1)) if sm else ''
                title = _clean(raw_title)
                if title:
                    out.append({'title': title, 'url': raw_url, 'snippet': snippet})
                if len(out) >= max_results:
                    break
            return out

        # ===== 搜狗 =====
        def search_sogou():
            url = f'https://www.sogou.com/web?query={quote_plus(query)}'
            resp = requests.get(url, headers=BASE_HEADERS, timeout=10)
            html = resp.text
            out = []
            for tm in re.finditer(
                r'<h3[^>]*\bclass="(?:pt|vr-title)"[^>]*>\s*(?:<!--[^>]*-->)?\s*<a[^>]*\sname="dttl"[^>]*\shref="([^"]+)"[^>]*>(.*?)</a>',
                html, flags=re.S
            ):
                raw_url, raw_title = tm.group(1), tm.group(2)
                if raw_url.startswith('/'):
                    raw_url = 'https://www.sogou.com' + raw_url
                elif not raw_url.startswith('http'):
                    continue
                tail = html[tm.end():tm.end() + 3500]
                sm = re.search(r'<div[^>]*\bclass="[^"]*\b(?:ft|fz-mid|space-txt|str_info|str-text-info)[^"]*"[^>]*>(.*?)</div>',
                               tail, flags=re.S)
                if not sm:
                    sm = re.search(r'<div[^>]*\bclass="text-layout"[^>]*>.*?<p[^>]*>(.*?)</p>',
                                   tail, flags=re.S)
                snippet = _clean(sm.group(1)) if sm else ''
                title = _clean(raw_title)
                if title:
                    out.append({'title': title, 'url': raw_url, 'snippet': snippet})
                if len(out) >= max_results:
                    break
            return out

        # ===== 360 =====
        def search_360():
            url = f'https://www.so.com/s?q={quote_plus(query)}'
            resp = requests.get(url, headers=BASE_HEADERS, timeout=10)
            html = resp.text
            out = []
            for tm in re.finditer(
                r'<h3[^>]*\bclass="[^"]*res-title[^"]*"[^>]*>\s*<a([^>]+)>(.*?)</a>',
                html, flags=re.S
            ):
                a_attrs, raw_title = tm.group(1), tm.group(2)
                mu = re.search(r'\bdata-mdurl="([^"]+)"', a_attrs)
                if mu:
                    real_url = mu.group(1)
                else:
                    hm = re.search(r'\shref="([^"]+)"', a_attrs)
                    if not hm:
                        continue
                    real_url = hm.group(1)
                if not real_url.startswith('http'):
                    continue
                tail = html[tm.end():tm.end() + 3000]
                sm = re.search(r'<p[^>]*\bclass="[^"]*res-desc[^"]*"[^>]*>(.*?)</p>',
                               tail, flags=re.S)
                if not sm:
                    sm = re.search(r'<div[^>]*\bclass="[^"]*res-rich-desc[^"]*"[^>]*>(.*?)</div>',
                                   tail, flags=re.S)
                if not sm:
                    sm = re.search(r'<p[^>]*\bclass="[^"]*res-comm-con[^"]*"[^>]*>(.*?)</p>',
                                   tail, flags=re.S)
                snippet = _clean(sm.group(1)) if sm else ''
                title = _clean(raw_title)
                if title:
                    out.append({'title': title, 'url': real_url, 'snippet': snippet})
                if len(out) >= max_results:
                    break
            return out

        # ===== 百度（必须先拿 Cookie）=====
        def search_baidu():
            sess = requests.Session()
            sess.headers.update(BASE_HEADERS)
            try:
                sess.get('https://www.baidu.com/', timeout=5)
            except Exception:
                pass
            url = f'https://www.baidu.com/s?wd={quote_plus(query)}&rn={max_results}'
            resp = sess.get(url, timeout=10, headers={'Referer': 'https://www.baidu.com/'})
            html = resp.text
            out = []
            for tm in re.finditer(
                r'<h3[^>]*\bclass="[^"]*\bt\b[^"]*"[^>]*>\s*<a[^>]*\shref="(https?://[^"]*baidu\.com/link\?[^"]+)"[^>]*>(.*?)</a>\s*</h3>',
                html, flags=re.S
            ):
                raw_url, raw_title = tm.group(1), tm.group(2)
                tail = html[tm.end():tm.end() + 4000]
                sm = re.search(r'<span[^>]*\bclass="[^"]*content-right[^"]*"[^>]*>(.*?)</span>',
                               tail, flags=re.S)
                if not sm:
                    sm = re.search(r'<div[^>]*\bclass="[^"]*c-abstract[^"]*"[^>]*>(.*?)</div>',
                                   tail, flags=re.S)
                if not sm:
                    sm = re.search(r'<span[^>]*\bdata-module="abstract"[^>]*>(.*?)</span>',
                                   tail, flags=re.S)
                snippet = _clean(sm.group(1)) if sm else ''
                title = _clean(raw_title)
                if title:
                    out.append({'title': title, 'url': raw_url, 'snippet': snippet})
                if len(out) >= max_results:
                    break
            return out

        # ===== 按 region 决定回退顺序 =====
        if region in ('global', 'us-en', 'wt-wt', 'en'):
            engines = [
                ('bing-global', lambda: search_bing('https://www.bing.com', 'en-US')),
                ('bing-cn',     lambda: search_bing('https://cn.bing.com',  'zh-CN')),
                ('360',         search_360),
                ('sogou',       search_sogou),
            ]
        else:  # cn / 缺省
            engines = [
                ('bing-cn',     lambda: search_bing('https://cn.bing.com',  'zh-CN')),
                ('360',         search_360),
                ('sogou',       search_sogou),
                ('bing-global', lambda: search_bing('https://www.bing.com', 'zh-CN')),
                ('baidu',       search_baidu),
            ]

        # ===== 逐个尝试 =====
        errors = []
        for name, fn in engines:
            try:
                results = fn()
                if results:
                    print(f'✅ [网络搜索] {name} 命中 {len(results)} 条')
                    return self._send_json(200, {
                        'ok': True,
                        'query': query,
                        'engine': name,
                        'count': len(results),
                        'results': results
                    })
                else:
                    errors.append(f'{name}: 0 条结果')
                    print(f'⚠️ [网络搜索] {name} 无结果')
            except Exception as e:
                errors.append(f'{name}: {type(e).__name__}')
                print(f'⚠️ [网络搜索] {name} 失败: {e}')

        return self._send_json(200, {
            'ok': False,
            'error': f'所有搜索引擎都未返回结果。{" | ".join(errors)}'
        })

    # ============ 🌐 抓取网页正文 ============
    def handle_fetch_url(self, body):
        """抓取指定 URL 的文本/HTML，可选择提取正文（去除 script/style/导航）。"""
        url = (body.get('url') or '').strip()
        extract_text = body.get('extract_text', True)
        max_chars = min(int(body.get('max_chars', 8000)), 50000)

        if not url:
            return self._send_json(200, {'ok': False, 'error': 'url 不能为空'})
        if not (url.startswith('http://') or url.startswith('https://')):
            return self._send_json(200, {'ok': False, 'error': 'URL 必须以 http:// 或 https:// 开头'})

        print(f'🌐 [抓取] {url}  extract={extract_text}')

        try:
            import requests
        except ImportError:
            return self._send_json(200, {'ok': False, 'error': '后端缺少 requests 模块，请运行：pip install requests'})

        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                              '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            }
            resp = requests.get(url, headers=headers, timeout=15, allow_redirects=True)
            content_type = resp.headers.get('content-type', '')
            if not resp.encoding or resp.encoding.lower() == 'iso-8859-1':
                resp.encoding = resp.apparent_encoding or 'utf-8'
            raw = resp.text

            if not extract_text or 'text/html' not in content_type.lower():
                truncated = raw[:max_chars]
                self._send_json(200, {
                    'ok': True,
                    'url': resp.url,
                    'status': resp.status_code,
                    'content_type': content_type,
                    'length': len(raw),
                    'content': truncated,
                    'truncated': len(raw) > max_chars
                })
                return

            # —— 提取 HTML 正文 ——
            text = raw
            text = re.sub(r'<script\b[^>]*>.*?</script>', ' ', text, flags=re.S | re.I)
            text = re.sub(r'<style\b[^>]*>.*?</style>', ' ', text, flags=re.S | re.I)
            text = re.sub(r'<noscript\b[^>]*>.*?</noscript>', ' ', text, flags=re.S | re.I)
            title_m = re.search(r'<title[^>]*>(.*?)</title>', text, flags=re.S | re.I)
            title = unescape(re.sub(r'\s+', ' ', title_m.group(1)).strip()) if title_m else ''
            text = re.sub(r'</?(p|div|li|tr|h[1-6]|br|hr|article|section)[^>]*>', '\n', text, flags=re.I)
            text = re.sub(r'<[^>]+>', '', text)
            text = unescape(text)
            text = re.sub(r'[ \t\r\f\v]+', ' ', text)
            text = re.sub(r'\n\s*\n+', '\n\n', text).strip()

            truncated_text = text[:max_chars]
            self._send_json(200, {
                'ok': True,
                'url': resp.url,
                'status': resp.status_code,
                'title': title,
                'length': len(text),
                'content': truncated_text,
                'truncated': len(text) > max_chars
            })
        except Exception as e:
            self._send_json(200, {'ok': False, 'error': f'抓取失败：{e}'})
