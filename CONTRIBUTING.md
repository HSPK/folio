# Contributing to Folio

[English overview](README.md) · [中文介绍](README.zh-CN.md) · [详细中文开发指南](docs/guide.zh-CN.md)

Folio is early-stage software. Focused bug reports, small fixes, documentation
improvements and reproducible examples are especially useful.

## Before you start

- Search [existing issues](https://github.com/HSPK/folio/issues) before filing a new one.
- Use the bug-report or feature-request form; English and Chinese are both welcome.
- Discuss substantial behavior changes in an issue before building them.
- Use synthetic Markdown examples. Do not upload personal notes, access tokens,
  passwords, private repository URLs or account databases.

## Build

Use stable Rust and Git. Node.js 22+ is needed when rebuilding the frontend, not
for a normal Rust build using the checked-in browser assets.

```sh
git clone https://github.com/HSPK/folio.git
cd folio
cargo build --locked -p folio-cli --target-dir build/rust
./build/rust/debug/folio-core --serve /path/to/test-notes
```

Frontend:

```sh
npm --prefix web ci
npm --prefix web run build
npm --prefix web test
```

Commit generated assets in `web/public/` together with their corresponding source
changes. The app shell is generated from `web/frontend/`; do not edit the generated
`web/public/app.mjs` or `styles.css` directly.

Native Windows build (PowerShell; MSVC plus Windows SDK, or GNU plus MinGW-w64):

```powershell
.\apps\windows\Scripts\build.ps1 -Runtime win-x64 -Toolchain msvc
```

Native macOS build (macOS 13+, Rust and Xcode Command Line Tools):

```sh
make app
```

## Check your change

Run the smallest relevant checks first. These cover the shared workspace:

```sh
cargo fmt --all -- --check
cargo test --locked --workspace --target-dir build/rust
npm --prefix web run check:lines
npm --prefix web test
```

Browser tests need a built debug CLI and Playwright Chromium (Windows uses Edge):

```sh
cd web
npx playwright install chromium
npx playwright test --grep "name of the affected test"
```

Installer tests use isolated, synthetic assets:

```sh
npm --prefix web run test:installers
```

Capture the README screenshots with:

```sh
npm --prefix web run capture:product
```

The capture script uses an isolated example workspace, never your real notes.
Set `FOLIO_CAPTURE_EXE` to a specific built CLI when capturing a different version.

## Website and launch materials

The static product pages live in `docs/site/`, with shared images in `docs/assets/`.
GitHub Pages deploys through `.github/workflows/pages.yml`. Keep English and Chinese
claims, install commands and version information aligned; do not add tracking
scripts or testimonials that cannot be verified.

The [press kit](docs/press-kit.md) contains community launch copy and a social-preview
image. External posts and directory submissions are up to the author; preparing
copy does not imply publication or acceptance by those communities.

## Pull requests

Explain the user-visible change, link any related issue, and describe the checks
you ran. Add a regression test for a bug when practical. Keep unrelated cleanup
out of the same pull request and preserve file safety, explicit error feedback
and existing permissions.

Folio is licensed under [MIT](LICENSE). Contributions are submitted under that
license; third-party code and assets must retain their required notices.

## 中文简要说明

欢迎用中文或英文反馈问题。请附上版本、系统、复现步骤和可公开的最小 Markdown
示例，不要上传真实笔记、密码或 token。大改动请先通过 Issue 讨论。

日常 Cargo 构建无需 Node.js；修改前端后需重新运行 `npm --prefix web run build`，
并一并提交生成资源。截图脚本只使用独立示例目录，不读取真实笔记。
