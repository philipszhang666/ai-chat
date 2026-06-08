# 🎓 LMS Helper（教务系统助手示例）

一个学校学习管理系统（LMS）的个人命令行助手示例。
一个 `.py` 文件，零依赖（除了 `requests`），快速查作业、查课件、下载文件。

> ⚠️ 内置示例 `BASE_URL` 指向某高校的 LMS 接口。如果你的学校用的是别的系统，
> 请修改 `lms.py` 顶部的 `BASE_URL` 和相关 API 路径以适配。

## 📦 安装

```bash
pip install requests
```

## 🔑 配置 Cookie（第一次使用）

1. 浏览器登录你学校的 LMS 网站
2. 按 `F12` → 切到 **Console（控制台）**
3. 输入 `copy(document.cookie)` 回车
4. **二选一**保存 Cookie：
   - 设环境变量：`export LMS_COOKIE="粘贴的内容"` （Windows: `setx LMS_COOKIE "..."`）
   - 或新建文件 `lms_tool/.lms_cookie`，把 Cookie 粘进去（参考 `.lms_cookie.example`）
5. 运行 `python lms.py login` 验证

> ⏰ Cookie 通常一天左右过期，过期后重新走一遍即可。
> 🔒 `.lms_cookie` 已加入 `.gitignore`，不会泄漏到 Git 仓库。

## 🚀 命令一览

| 命令 | 作用 |
|------|------|
| `python lms.py login` | 检查 Cookie 状态 + 过期时间 |
| `python lms.py courses` | 列出全部课程（按学年分组） |
| `python lms.py todos` | 列出未完成作业（按截止排序） |
| `python lms.py homework <hw_id>` | 查看某项作业详细要求 |
| `python lms.py materials <cid>` | 列出某门课的所有课件 |
| `python lms.py download <upload_id> [文件名]` | 下载文件 |
| `python lms.py find <关键词>` | 在课程名中搜索 |

## 🛠 典型工作流

```bash
# 早上看看有什么作业
python lms.py todos

# 看某个作业要交啥
python lms.py homework 1021271

# 找到某门课的 course_id
python lms.py find 操作系统

# 列出该课程所有课件
python lms.py materials 21406

# 下载第10章 PPT
python lms.py download 3951
```

## 📁 目录结构

```
lms_tool/
├── lms.py              # 主程序
├── README.md           # 本文档
├── data/               # 自动缓存的 JSON 数据
└── downloads/          # 下载文件的保存目录
```

## ⚠️ 使用守则（自律）

- ✅ 仅查询/下载**自己账号**下的数据
- ✅ 控制请求频率，不写自动定时刷新
- ❌ 不爬别人的数据
- ❌ 不绕过下载限制
- ❌ 不公开 Cookie，不上传到 GitHub

## 🔐 隐私

- Cookie 仅保存在本地（环境变量或本地文件）
- 所有 API 请求直接发往学校服务器，不经过任何第三方
- 缓存数据存在 `data/` 目录，自己看着办

## 📜 License

仅供个人学习使用。
