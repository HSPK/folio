<p align="center">
  <img src="docs/assets/banner.svg" alt="Folio — 自由书写，文件仍属于你。本地优先的 Markdown 工作台。" width="100%">
</p>

<p align="center">
  <a href="https://github.com/HSPK/folio/releases"><img src="https://img.shields.io/github/v/release/HSPK/folio?style=flat-square&color=292929" alt="最新版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-292929?style=flat-square" alt="MIT 许可证"></a>
  <a href="https://github.com/HSPK/folio/releases"><img src="https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-292929?style=flat-square" alt="支持 Windows、macOS 和 Linux"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong><br>
  <a href="https://hspk.github.io/folio/zh.html">产品主页</a> ·
  <a href="#安装">安装</a> ·
  <a href="https://github.com/HSPK/folio/releases">下载</a> ·
  <a href="https://github.com/HSPK/folio/issues">反馈</a>
</p>

# Folio

**自由书写，文件仍属于你。**

Folio 是一个开源、本地优先的 Markdown 工作台，适合写作、研究和整理个人知识。
打开一个文件夹，在排版好的页面里直接编辑，笔记仍然是普通的 `.md` 文件。
可以继续用 Git、文本编辑器和自己的备份工具，不必从专有笔记库里导出。

轻量 Rust 服务与 Windows/macOS 原生启动器，借助**你已有的浏览器**打开编辑器；Linux 使用 CLI。
不打包浏览器内核，不要求注册托管账号，也不依赖订阅服务。

![Folio 的 Live 编辑器，展示真实运行的示例 Markdown 工作区](docs/assets/live-light.png)

## 为什么选择 Folio？

| 你需要的 | Folio 提供的 |
| --- | --- |
| 一个安静的写作空间 | **Live** 实时编辑、大纲、可收起的侧栏和明暗主题。 |
| 随时掌握 Markdown 原文 | **Source** 源码、并排 **Compare** 对照、只读 **Read**。 |
| 逐步连成知识库的笔记 | 全文搜索、YAML 标签、双链、反向链接和收藏。 |
| 少一些丢稿的担忧 | 版本历史、回收站、本机恢复与外部修改冲突检查。 |
| 需要时才开启的共同写作 | 项目、页面权限、公开链接与实时协作。 |
| 能融入 Git 的笔记工作流 | 查看差异、暂存、提交，以及可选的定时提交推送。 |

内置表格、任务清单、代码块、可编辑的 LaTeX 公式、笔记模板和图片粘贴/拖放。
可以独自写作，也可以明确共享项目或页面；不会给每篇文档强制开启协作。

<details>
<summary><strong>看看 Markdown 原文与预览对照</strong></summary>

![深色主题下的 Folio Compare 视图](docs/assets/compare-dark.png)

同一份文件，两种视角。需要精确控制语法时用 Source，想专注内容时用 Live。
</details>

## 安装

当前版本：**[0.1.0](https://github.com/HSPK/folio/releases/tag/v0.1.0)**。
Windows、macOS 和 Linux 均提供 **x64 / ARM64** 安装包。

**Linux / macOS**

```sh
curl -fsSL https://github.com/HSPK/folio/releases/latest/download/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/HSPK/folio/releases/latest/download/install.ps1 | iex
```

安装脚本自动选择架构、校验发布包的 SHA-256，并安装到当前用户目录，**无需管理员权限**。
可以先阅读 [install.sh](install.sh) / [install.ps1](install.ps1)，再执行；
也可以从 [Releases](https://github.com/HSPK/folio/releases) 手动下载发布包和 `SHA256SUMS`。
校验和用于检查下载内容是否匹配，不等同于独立的发布者签名。

| 平台 | 默认安装位置 | 启动 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Programs\Folio` | 从开始菜单打开 **Folio**。 |
| macOS | `~/Applications/Folio.app` | 从 Applications 打开 **Folio**。 |
| Linux | `~/.local/bin/folio` | 执行 `folio --serve /path/to/markdown`。 |

Linux 用户请按需把 `~/.local/bin` 加入 `PATH`。macOS 发布包采用 **ad-hoc 签名，尚未公证**；
首次运行可能需要在「**系统设置 → 隐私与安全性**」中批准。安装脚本不会关闭 Gatekeeper。

<details>
<summary>固定版本或指定安装目录</summary>

```sh
curl -fsSL https://github.com/HSPK/folio/releases/download/v0.1.0/install.sh |
  FOLIO_VERSION=0.1.0 FOLIO_INSTALL_DIR="$HOME/.local/bin" sh
```

```powershell
$env:FOLIO_VERSION = "0.1.0"
$env:FOLIO_INSTALL_DIR = "$env:LOCALAPPDATA\Programs\Folio"
irm https://github.com/HSPK/folio/releases/download/v0.1.0/install.ps1 | iex
```

macOS 中，`FOLIO_INSTALL_DIR` 是放置 `Folio.app` 的父目录。
更新前请保存未保存内容并退出旧程序。
</details>

## 一分钟上手

1. **打开 Markdown 文件夹。** Windows/macOS 启动 Folio 后选择目录；Linux 执行上面的启动命令。
2. **创建本机管理员。** 首次打开浏览器页面时设置用户名和密码，账号属于自己的服务，不是 Folio 云端账号。
3. **开始写。** 打开已有笔记或新建一篇，在 Live 中直接编辑排版后的内容并自动保存；随时切换 Source 查看原文。

用 **Ctrl/Cmd+P** 搜索，在 Live 空段落中输入 `/` 插入块，按 **Ctrl/Cmd+S** 立即保存。

## 本地优先，也说明边界

- **笔记是文件。** Markdown 和附件保存在文件夹里；账号、索引、历史与协作状态使用独立的本机存储，备份时需要另外包含这些数据。
- **默认不对外开放。** 服务默认绑定 `127.0.0.1`，分享需要明确配置权限，并保证接收方能够访问当前服务地址。
- **不是托管同步服务。** Folio 不替你部署公网服务、TLS 或跨设备连接。Git 同步需要主动开启，并自行配置仓库和凭据。
- **源码始终可用。** 仅打开文档不会改写文件；Live 编辑可能规范化 Markdown 写法，要求逐字控制时请用 Source。

Folio 仍处于**早期阶段**。重要笔记请备份，开启 Git 自动推送前请检查配置与改动范围。
目前单篇 Markdown 上限为 4 MiB，文件列表上限为 5,000 篇。
使用细节、功能限制、网络配置和旧版本迁移见[完整指南](docs/guide.zh-CN.md)。

## 一起把它打磨好

一份 Rust 核心支撑原生启动器与网页工作台；可复用的
[`@folio/editor`](web/editor/README.md) 使用 Milkdown、CodeMirror 和 KaTeX，协作使用 Yjs/Yrs。
浏览器资源随应用发布，不依赖运行时 CDN。

```sh
cargo build --locked --release -p folio-cli --target-dir build/rust
./build/rust/release/folio-core --serve /path/to/markdown
```

修改前端需要 Node.js 22+：

```sh
npm --prefix web ci
npm --prefix web run build
npm --prefix web test
```

平台构建、测试和贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
遇到问题可以[报告 Bug](https://github.com/HSPK/folio/issues/new/choose)，
也欢迎[提出建议](https://github.com/HSPK/folio/issues/new/choose)。
如果它适合你的工作流，点一颗 Star，或分享给写 Markdown 的朋友，都能帮助更多人发现它。

## 许可证

[MIT](LICENSE) · 作者：[HSPK](https://github.com/HSPK)。
第三方依赖保留各自许可证，见[第三方声明](web/public/THIRD-PARTY-LICENSES.txt)。

想在社区介绍 Folio？[中英文宣传素材包](docs/press-kit.md)提供截图、简短介绍与可改写的发布文案。
