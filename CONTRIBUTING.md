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

Use stable Rust and Git. Node.js 22.12+ is needed when rebuilding the frontend, not
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

The interface uses SolidJS, TypeScript, Vite, and Kobalte. Keep UI components in
`web/frontend/components/`, fine-grained view state in `state/`, and explicitly
imported business controllers in `runtime/`. Do not concatenate modules by
filename or leave same-named `.mjs` and `.ts` controller copies: Vite can resolve
the JavaScript copy first.

`models/` contains canonical checked document, navigation, library, workspace, and recovery
contracts; the public model modules are generated from these sources. HTTP JSON
enters `api/` as `unknown` and must pass a response decoder before use. Keep pure
business workflows in `services/`, with dependencies injected by the application
composition root. `npm --prefix web run check:architecture` enforces lower-layer
dependency directions and the editor's independence from the application.
Storage adapters in `storage/` follow the same no-UI dependency boundary.

`state/document.ts` owns the non-reactive document session. Replace documents,
advance edits, accept save baselines, and manage loads through its methods rather
than writable `AppState` fields. Its opaque session ID changes on every open or
close, including reopening the same resource; it is not the resource UUID sent
to the server. `services/document-saving.ts` owns save coalescing, uncertain
acknowledgements, verification, and conflict policy through injected ports.

`services/draft-repository.ts` captures recovery identity and immutable snapshots
before asynchronous work. Its durable write queue spans application remounts;
each repository owns its IndexedDB connection and drains accepted operations
before closing. Preserve generation-checked cleanup so old recovery records
cannot delete newer writes. Keep the version-one database schema and HKDF
purposes compatible with existing encrypted copies.

Draft recovery is a scoped document workflow, not an independent HTTP save.
Bind confirmation and disk reads to the current session, stage the recovered
source as an edit, and use the shared saver or durable collaborative-draft path.
Retain the original copy until that path succeeds. Canceling a view must not
silently cancel already accepted durable writes.

`runtime/core/bootstrap.ts` must not import business controllers. The application
entry composes `editor-host.ts` and layout initialization after creating context;
the architecture guard checks this boundary transitively.

`state/authentication.ts` separates account identity from credential request
scopes. Invalidate the previous scope before submitting credentials; retain the
old identity until its encrypted draft is preserved when changing accounts.
Account-bound workspace and project operations capture that scope when intent
is created, not when a queued callback eventually runs.
Use bounded transport deadlines for coalesced refreshes and serialized workspace
writes so a stalled response cannot permanently block subsequent intent.

`state/workspace.ts` owns immutable, principal-specific favorites and recent
notes. The workspace service coalesces refreshes and serializes copied mutation
intent; an old account's revision or queue must never affect a new owner.
Project transitions own cancelable leave intent, while committed activation
finishes only for the current account and project activation. Commit the route
before clearing the previous document so rejected history writes remain retryable.

`runtime/core/events.ts` is composition-only event wiring. Controllers use
`core/connection.ts` for connection workflows and `projects/permissions.ts` for
permission queries, rather than importing event initialization.

`state/projects.ts` is the authoritative, principal-owned project registry.
Project responses update their addressed record; they must never replace a
different active selection. Request tickets prevent old catalog/session reads
from rolling back confirmed or unconfirmed writes. All runtime project HTTP
requests go through `projects/gateway.ts` and the scoped, ordered project service;
the architecture guard rejects direct controller calls.

Project settings use field patches: omit unedited fields rather than sending an
old sharing value alongside a name or image-directory change. The server keeps
omitted project fields unchanged; legacy document-sharing updates still require
an explicit permission. Settings saves span independent project and preference
requests, not a transaction. Report partial success, retry only missing work,
and keep form edits made after submission. Preference defaults and decoding
belong to checked model/API modules, not UI initialization.

The library catalog belongs to `state/library.ts`; `FileTree.tsx` owns its keyed
DOM rows. Preserve resource UUIDs through refreshes and moves: a mutable path is
not document identity. Register listeners and resources with their owning
`Lifetime` immediately after creation, including during partial initialization.

Milkdown, CodeMirror, and collaborative documents own their editor DOM and stay
outside reactive stores. Dialog forms remain mounted while their Kobalte
interaction layers open and close. Use immutable result signals and virtualize
long collections rather than rebuilding the entire interface on input.
An editor's `clear()` retains reusable tools; its terminal `destroy()` releases
the instance's listeners, observers, floating UI, and editor session.

`web/editor/` is also strict TypeScript, including its build script, model tests,
and browser benchmarks. Its package exports and the application's editor alias
point to the implementation, not a parallel declaration stub. Use its `tsx`
package scripts to run TypeScript; only generated browser assets stay `.mjs`.

Run `npm --prefix web run check:types`, `npm --prefix web run check:architecture`,
and `npm --prefix web run format:check`
for typed frontend or editor changes. CSS sources belong in `web/frontend/styles/`;
`web/public/workspace.css` is copied during the build.

Interface icons share `web/editor/src/icons.ts`; use `data-icon` in templates and
`createIcon` for dynamic controls. Rebuild the brand PNG/ICO with
`npm --prefix web run icons`; pass `-- --channel=chrome` to use an installed Chrome.

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
