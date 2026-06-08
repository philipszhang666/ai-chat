"""
本地 Agent 服务 - 主入口

🚀 启动方式
─────────────────────────────────────────────────────────────
方式 1：在工作目录里运行（沙箱根 = 当前目录，最常用）
    cd D:\\项目A
    python C:\\path\\to\\agent\\local_terminal_server.py

方式 2：显式指定工作目录（代码本体与工作目录解耦）
    python C:\\path\\to\\agent\\local_terminal_server.py --workspace D:\\项目A
    python C:\\path\\to\\agent\\local_terminal_server.py -w .

方式 3：用启动器脚本（推荐，零记忆负担）
    把仓库根目录的 start_agent.bat / start_agent.sh 复制到任何工作文件夹
    双击即可启动，自动锁定沙箱根 = 该文件夹

🧱 业务实现已拆分到 server/ 包：
    config / sandbox / handler / exec / files / web / git_ops / proxy
本文件只负责：解析 CLI 参数 + banner + 启动 HTTP 服务。
"""
import argparse
import os
import sys
from http.server import ThreadingHTTPServer

# Windows 控制台默认编码常为 GBK，输出 emoji 会 UnicodeEncodeError，
# 重定向到文件或在某些终端里尤其常见。这里在 import 后立刻把 stdout/stderr 切到 utf-8。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from server import Handler, config


def _parse_args(argv):
    p = argparse.ArgumentParser(
        prog='local_terminal_server',
        description='Local Agent 后端服务（终端 + 文件 + Git + 网络 + LLM 代理）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='示例:\n'
               '  python local_terminal_server.py                       # 沙箱根 = 当前目录\n'
               '  python local_terminal_server.py -w D:\\项目A           # 沙箱根 = D:\\项目A\n'
               '  python local_terminal_server.py --workspace .         # 沙箱根 = 当前目录（显式）\n'
               '  python local_terminal_server.py -w ~/work --port 9000 # 自定义端口\n'
    )
    p.add_argument(
        '-w', '--workspace',
        metavar='DIR',
        default=None,
        help='指定沙箱根目录（默认 = 启动时的当前目录）。所有文件操作都被锁定在此目录内。'
    )
    p.add_argument(
        '--host',
        default=None,
        metavar='HOST',
        help=f'监听地址（默认 {config.HOST}）'
    )
    p.add_argument(
        '--port',
        type=int,
        default=None,
        metavar='PORT',
        help=f'监听端口（默认 {config.PORT}）'
    )
    return p.parse_args(argv)


def _print_banner():
    print('=' * 60)
    print('🚀 本地 Agent 服务（终端 + 文件系统 + 静态托管 + LLM 代理）')
    print('=' * 60)
    print(f'服务地址    : http://{config.HOST}:{config.PORT}')
    print()
    print('🌐 在浏览器打开：')
    print(f'   👉  http://{config.HOST}:{config.PORT}/')
    print('   （从这里打开页面，不再有任何 CORS 问题）')
    print()
    print(f'🏠 沙箱根目录: {config.WORKSPACE_ROOT}')
    print(f'   工作目录 : {config.get_current_cwd()}')
    print(f'Token 文件  : {config.TOKEN_FILE}')
    print(f'\n🔑 Token: {config.TOKEN}\n')
    print('🛡️  沙箱防护:')
    print('   L1 路径越界检测  - 所有文件操作必须在沙箱内')
    print('   L2 cd 越界拦截   - 不允许 cd 出沙箱')
    print('   L3 危险命令黑名单 - rm -rf / format / fork bomb / sudo 等')
    print('\n📦 支持的操作:')
    print('   - GET  /token      浏览器自动拉取 Token（本机自动授权）')
    print('   - GET  /workspace  查询当前沙箱目录（公开，无需鉴权）')
    print('   - GET  /lms-proxy  代理 LMS API 请求（需 X-Token + X-LMS-Cookie）')
    print('   - POST /llm-proxy  代理 LLM 请求（绕过浏览器 CORS）')
    print('   - execute          执行 shell 命令')
    print('   - read_file        读取文本文件')
    print('   - read_file_binary 读取二进制文件（图片/PDF）')
    print('   - write_file       写/覆盖文件')
    print('   - append_file      追加内容')
    print('   - edit_file        精确替换')
    print('   - delete_file      删除文件/空目录')
    print('   - list_dir         列目录')
    print('   - search           搜索文件内容')
    print('   - web_search       🌐 网络搜索（多引擎自动回退）')
    print('   - fetch_url        🌐 抓取网页正文')
    print('   - file_info        查看文件信息')
    print('   - git              🌿 Git 集成（status/log/diff/add/commit/checkout/branch...）')
    print('\n💡 提示: 用 -w / --workspace 指定任意目录作为沙箱根，无需复制代码！')
    print('         详见 README.md 的"启动器"章节，或运行 --help 查看完整参数。')
    print('\n⚠️ 修改 server/*.py 后必须 Ctrl+C 重启服务！')
    print('=' * 60)


def main(argv=None):
    args = _parse_args(argv if argv is not None else sys.argv[1:])

    # --- 应用 CLI 参数（必须在启动 HTTP 服务前完成）---
    if args.workspace:
        try:
            config.set_workspace(args.workspace)
        except FileNotFoundError as e:
            print(f'❌ {e}', file=sys.stderr)
            sys.exit(2)
        except Exception as e:
            print(f'❌ 设置 workspace 失败: {e}', file=sys.stderr)
            sys.exit(2)

    if args.host:
        config.HOST = args.host
    if args.port:
        config.PORT = args.port

    _print_banner()
    try:
        ThreadingHTTPServer((config.HOST, config.PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print('\n👋 服务已停止')
    except OSError as e:
        # 端口被占用的友好提示
        if 'Address already in use' in str(e) or getattr(e, 'errno', None) in (48, 98, 10048):
            print(f'\n❌ 端口 {config.PORT} 已被占用。请用 --port 指定其他端口，或停掉占用进程。', file=sys.stderr)
            sys.exit(1)
        raise


if __name__ == '__main__':
    main()
