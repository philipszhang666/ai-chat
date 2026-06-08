"""
========================================================================
  LMS Helper - 西安交大学习管理系统命令行助手
========================================================================

使用方法（在 lms_tool/ 目录下运行）：

  python lms.py login              # 检查 Cookie 状态/有效期
  python lms.py courses            # 列出所有课程（按学年分组）
  python lms.py todos              # 列出未完成作业（按紧急度排序）
  python lms.py homework <hw_id>   # 查看某项作业的详细要求
  python lms.py materials <cid>    # 列出某门课的所有课件
  python lms.py download <upload_id> [文件名]    # 下载允许下载的文件
  python lms.py find <关键词>      # 在课程名里搜索（拿到 course_id）

第一次使用：
  1. 浏览器登录 LMS 后，按 F12 → Console 输入 copy(document.cookie)
  2. 二选一保存 Cookie：
     - 设置环境变量 LMS_COOKIE="..."
     - 或在 lms_tool/.lms_cookie 中写入 Cookie（已被 .gitignore 排除）
  3. 跑 python lms.py login 验证
"""

import sys
import io
import os
import json
import base64
import argparse
import re
from pathlib import Path
from datetime import datetime, timezone, timedelta
from collections import defaultdict

import requests

# Windows 控制台 UTF-8
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# ====================================================================
# 🔐 Cookie 加载（优先级：环境变量 LMS_COOKIE > 同目录 .lms_cookie 文件）
# 切勿把真实 Cookie 写在源码里！.lms_cookie 已加入 .gitignore。
#
# 配置方式（任选其一）：
#   1) 临时：  setx LMS_COOKIE "_ga=...; session=..."     (Windows)
#             export LMS_COOKIE="_ga=...; session=..."    (Linux/Mac)
#   2) 持久：  在 lms_tool/.lms_cookie 中写一行 Cookie 字符串
# ====================================================================

def _load_cookie() -> str:
    env = os.environ.get("LMS_COOKIE", "").strip()
    if env:
        return env
    cookie_file = Path(__file__).parent / ".lms_cookie"
    if cookie_file.exists():
        try:
            content = cookie_file.read_text(encoding="utf-8").strip()
            if content:
                return content
        except Exception as e:
            print(f"⚠️  读取 {cookie_file} 失败: {e}")
    print("❌ 未配置 Cookie。请二选一：")
    print('   ① 设置环境变量 LMS_COOKIE="..."')
    print(f"   ② 在 {cookie_file} 写入 Cookie 字符串")
    print("   获取方法：登录 lms.xjtu.edu.cn → F12 Console → copy(document.cookie)")
    sys.exit(1)


COOKIE_STR = _load_cookie()

BASE_URL  = "https://lms.xjtu.edu.cn"
CST       = timezone(timedelta(hours=8))
DATA_DIR  = Path(__file__).parent / "data"
DL_DIR    = Path(__file__).parent / "downloads"
DATA_DIR.mkdir(exist_ok=True)
DL_DIR.mkdir(exist_ok=True)


# ====================================================================
#                          基础工具函数
# ====================================================================

def build_session():
    """构造已登录的 session"""
    s = requests.Session()
    for kv in COOKIE_STR.split(";"):
        kv = kv.strip()
        if "=" in kv:
            k, v = kv.split("=", 1)
            s.cookies.set(k.strip(), v.strip())
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/148.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": f"{BASE_URL}/user/index",
        "X-Requested-With": "XMLHttpRequest",
    })
    return s


def api_get(session, path, **params):
    """统一 GET 请求"""
    url = f"{BASE_URL}{path}"
    r = session.get(url, params=params, timeout=20)
    if r.status_code == 200:
        try:
            return r.json()
        except json.JSONDecodeError:
            return None
    return None


def parse_time(s):
    """LMS UTC 时间 → 北京时间 datetime"""
    if not s:
        return None
    dt = datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return dt.astimezone(CST)


def fmt_size(b):
    if not b: return "0 B"
    if b < 1024:        return f"{b} B"
    if b < 1024**2:     return f"{b/1024:.1f} KB"
    if b < 1024**3:     return f"{b/1024**2:.1f} MB"
    return f"{b/1024**3:.2f} GB"


def fmt_remain(end_dt, now=None):
    """格式化截止剩余时间"""
    if not end_dt:
        return "⏳ 无截止"
    now = now or datetime.now(CST)
    delta = end_dt - now
    total = delta.total_seconds()
    if total < 0:
        return f"⛔ 已逾期 {-delta.days} 天"
    days  = delta.days
    hours = int((total % 86400) // 3600)
    if days >= 30:  return f"📅 还有 {days} 天"
    if days >= 7:   return f"📌 还有 {days} 天"
    if days >= 3:   return f"⚠️  还有 {days} 天 {hours} 小时"
    if days >= 1:   return f"🔥 仅剩 {days} 天 {hours} 小时"
    return f"🚨 仅剩 {hours} 小时！"


def safe_get(obj, key, default=""):
    if not obj: return default
    return obj.get(key, default) or default


def strip_html(html):
    """简单去 HTML 标签，把作业说明转纯文本"""
    if not html: return ""
    text = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    text = re.sub(r"</p>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    # 解 HTML 实体
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", '"').replace("&#39;", "'"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ====================================================================
#                          命令实现
# ====================================================================

def cmd_login(args):
    """检查 Cookie 是否有效 + 显示过期时间"""
    print("=" * 60)
    print("🔐 Cookie 状态检查")
    print("=" * 60)

    # 解析 session cookie 拿过期时间
    session_val = ""
    for kv in COOKIE_STR.split(";"):
        kv = kv.strip()
        if kv.startswith("session="):
            session_val = kv.split("=", 1)[1]
            break

    if not session_val:
        print("❌ 没找到 session cookie，请检查 COOKIE_STR")
        return

    try:
        parts = session_val.split(".")
        uid = base64.urlsafe_b64decode(parts[1] + "==").decode()
        expire_ts = int(parts[2]) / 1000
        expire_dt = datetime.fromtimestamp(expire_ts, tz=CST)
        now = datetime.now(CST)
        delta = expire_dt - now

        print(f"👤 用户 ID  : {uid}")
        print(f"⏰ 过期时间 : {expire_dt.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"📊 剩余    : {delta}")
        if delta.total_seconds() < 0:
            print("⛔ Cookie 已过期，请重新登录获取！")
            return
    except Exception as e:
        print(f"⚠️ 解析失败: {e}")

    # 实际请求测试
    s = build_session()
    data = api_get(s, "/api/todos")
    if data is not None:
        n = len(data.get("todo_list", []))
        print(f"\n✅ Cookie 有效，可正常调用 API（当前 {n} 项待办）")
    else:
        print("\n❌ API 调用失败，Cookie 可能已失效")


def cmd_courses(args):
    """列出所有课程"""
    s = build_session()
    data = api_get(s, "/api/my-courses")
    if not data:
        print("❌ 获取课程列表失败")
        return

    courses = data.get("courses", [])
    # 缓存
    (DATA_DIR / "courses.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    by_term = defaultdict(list)
    for c in courses:
        year = safe_get(c.get("academic_year"), "name", "其他")
        by_term[year].append(c)

    print(f"\n📚 共 {len(courses)} 门课程\n")
    for term in sorted(by_term.keys(), reverse=True):
        lst = by_term[term]
        print(f"📅 【{term}】 ({len(lst)} 门)")
        print("-" * 70)
        for c in lst:
            cid    = c.get("id")
            name   = c.get("name", "?")
            credit = c.get("credit", "")
            credit_str = f"  {credit}学分" if credit else ""
            print(f"  [{cid:>6}] {name}{credit_str}")
        print()


def cmd_todos(args):
    """列出未完成作业"""
    s = build_session()
    data = api_get(s, "/api/todos")
    if not data:
        print("❌ 获取待办失败")
        return

    todos = data.get("todo_list", [])
    (DATA_DIR / "todos.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    now = datetime.now(CST)
    items = []
    for t in todos:
        items.append({
            "id":     t.get("id"),
            "title":  t.get("title", "?"),
            "course": t.get("course_name", "?"),
            "cid":    t.get("course_id"),
            "type":   t.get("type", "?"),
            "end":    parse_time(t.get("end_time")),
            "start":  parse_time(t.get("start_time")),
        })
    items.sort(key=lambda x: (x["end"] is None, x["end"] or now))

    print(f"\n📝 未完成作业（{len(items)} 项）  ⏰ {now.strftime('%Y-%m-%d %H:%M')}\n")
    if not items:
        print("🎉 暂无未完成作业~")
        return

    for i, x in enumerate(items, 1):
        end_str = x["end"].strftime("%Y-%m-%d %H:%M") if x["end"] else "—"
        print(f"【{i}】{x['title']}")
        print(f"     📚 {x['course']}  |  🆔 hw_id={x['id']}")
        print(f"     🔴 截止: {end_str}   {fmt_remain(x['end'], now)}")
        print(f"     🔗 https://lms.xjtu.edu.cn/course/{x['cid']}/homework/{x['id']}")
        print(f"     💡 查看详情: python lms.py homework {x['id']}")
        print()


def cmd_homework(args):
    """查看某项作业的详细要求"""
    hw_id = args.id
    s = build_session()
    data = api_get(s, f"/api/homework-activities/{hw_id}")
    if not data:
        print(f"❌ 未找到作业 {hw_id}")
        return

    (DATA_DIR / f"homework_{hw_id}.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    title    = data.get("title", "?")
    start    = parse_time(data.get("start_time"))
    end      = parse_time(data.get("end_time"))
    sub_type = data.get("data", {}).get("homework_type", "?")
    desc     = strip_html(data.get("data", {}).get("description", ""))
    uploads  = data.get("uploads", []) or []

    print("=" * 70)
    print(f"📝 {title}")
    print("=" * 70)
    print(f"🟢 开始: {start.strftime('%Y-%m-%d %H:%M') if start else '—'}")
    print(f"🔴 截止: {end.strftime('%Y-%m-%d %H:%M') if end else '—'}   ({fmt_remain(end)})")
    print(f"📤 提交方式: {sub_type}")

    print("\n" + "─" * 70)
    print("📜 作业要求：")
    print("─" * 70)
    print(desc if desc else "(老师未填写说明)")

    if uploads:
        print("\n" + "─" * 70)
        print(f"📎 附件 ({len(uploads)} 个)：")
        print("─" * 70)
        for u in uploads:
            flag = "✅可下载" if u.get("allow_download") else "🔒仅在线"
            print(f"  📄 {u.get('name')}  ({fmt_size(u.get('size', 0))})  [{flag}]  id={u.get('id')}")
            if u.get("allow_download"):
                print(f"     💡 下载: python lms.py download {u.get('id')}")
    print()


def cmd_materials(args):
    """列出某门课的所有课件"""
    cid = args.cid
    s = build_session()
    acts_data = api_get(s, f"/api/courses/{cid}/activities")
    mods_data = api_get(s, f"/api/courses/{cid}/modules")
    if not acts_data:
        print(f"❌ 无法获取课程 {cid} 的活动列表")
        return

    acts = acts_data.get("activities", [])
    mods = (mods_data or {}).get("modules", [])
    mod_name = {m["id"]: m.get("name", "未分组") for m in mods}

    materials = [a for a in acts if a.get("type") == "material"]

    groups = defaultdict(list)
    for m in materials:
        groups[m.get("module_id", 0)].append(m)

    total_files, total_size = 0, 0
    print(f"\n📚 课程 {cid} 的课件（{len(materials)} 项）\n")

    for mid, items in groups.items():
        print(f"📁 【{mod_name.get(mid, '未分组')}】")
        print("-" * 70)
        for m in items:
            uploads = m.get("uploads", []) or []
            dl = all(u.get("allow_download") for u in uploads) if uploads else False
            flag = "✅可下载" if dl else "🔒仅在线"
            print(f"  ▸ {m.get('title')}  [{flag}]")
            for u in uploads:
                total_files += 1
                total_size += u.get("size", 0)
                hint = ""
                if u.get("allow_download"):
                    hint = f"  💡 python lms.py download {u.get('id')}"
                print(f"      📄 {u.get('name')}  ({fmt_size(u.get('size', 0))})  id={u.get('id')}{hint}")
        print()

    print("─" * 70)
    print(f"📊 共 {total_files} 个文件，总大小 {fmt_size(total_size)}")
    print("─" * 70)


def cmd_download(args):
    """下载一个文件（需要 allow_download=true 才能成功）"""
    upload_id = args.id
    s = build_session()

    # 第 1 步：获取签名 URL
    print(f"📡 获取下载链接（upload_id={upload_id}）...")
    data = api_get(s, f"/api/uploads/{upload_id}/url")
    if not data or not data.get("url"):
        print("❌ 该文件不允许下载（老师设置了禁止下载）")
        return

    real_url = data["url"]

    # 文件名：参数指定 > URL 里的 name= > 默认
    fname = args.name
    if not fname:
        m = re.search(r"name=([^&]+)", real_url)
        if m:
            from urllib.parse import unquote
            fname = unquote(m.group(1))
        else:
            fname = f"upload_{upload_id}.bin"

    out = DL_DIR / fname
    print(f"📥 下载中: {fname}")

    r = s.get(real_url, timeout=120, stream=True)
    if r.status_code != 200:
        print(f"❌ 下载失败 ({r.status_code})")
        return

    total = int(r.headers.get("Content-Length", 0))
    written = 0
    with open(out, "wb") as f:
        for chunk in r.iter_content(16384):
            f.write(chunk)
            written += len(chunk)
            if total:
                pct = written / total * 100
                bar = "█" * int(pct / 2) + "·" * (50 - int(pct / 2))
                print(f"\r  [{bar}] {pct:5.1f}%  {fmt_size(written)}/{fmt_size(total)}", end="")
    print(f"\n✅ 完成: {out}  ({fmt_size(written)})")


def cmd_find(args):
    """在课程名中搜索关键词，拿到 course_id"""
    kw = args.keyword
    s = build_session()
    data = api_get(s, "/api/my-courses")
    if not data:
        print("❌ 获取课程失败")
        return
    courses = data.get("courses", [])
    hits = [c for c in courses if kw.lower() in c.get("name", "").lower()]
    print(f"\n🔍 搜索 \"{kw}\" 找到 {len(hits)} 门课程：\n")
    for c in hits:
        cid  = c.get("id")
        name = c.get("name")
        year = safe_get(c.get("academic_year"), "name", "?")
        print(f"  [{cid:>6}] {name}  ({year})")
        print(f"         💡 python lms.py materials {cid}")
    print()


# ====================================================================
#                          命令分发
# ====================================================================

def main():
    parser = argparse.ArgumentParser(
        prog="lms",
        description="🎓 西安交大 LMS 命令行助手",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("使用方法", 1)[1] if "使用方法" in __doc__ else "",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("login",   help="检查 Cookie 状态")
    sub.add_parser("courses", help="列出全部课程")
    sub.add_parser("todos",   help="列出未完成作业")

    p_hw = sub.add_parser("homework", help="查看作业详情")
    p_hw.add_argument("id", type=int, help="作业 ID（用 todos 查到）")

    p_mat = sub.add_parser("materials", help="列出课件")
    p_mat.add_argument("cid", type=int, help="课程 ID（用 courses / find 查到）")

    p_dl = sub.add_parser("download", help="下载文件")
    p_dl.add_argument("id", type=int, help="upload_id")
    p_dl.add_argument("name", nargs="?", default=None, help="自定义保存文件名（可选）")

    p_fn = sub.add_parser("find", help="搜索课程")
    p_fn.add_argument("keyword", help="课程名关键词")

    args = parser.parse_args()
    {
        "login":     cmd_login,
        "courses":   cmd_courses,
        "todos":     cmd_todos,
        "homework":  cmd_homework,
        "materials": cmd_materials,
        "download":  cmd_download,
        "find":      cmd_find,
    }[args.cmd](args)


if __name__ == "__main__":
    main()
