import { chromium } from "@playwright/test";
import { test, expect, fs, path, root, confirmDialog, openFixture, openMoreAction, userResourceId } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

import { workbook, largePdf } from "./panel-fixture.mjs";

test("project switches discard the previous file link instead of failing to connect", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  try {
    const [page] = library.pages;
    await fs.writeFile(path.join(library.notes, "Previous.xlsx"), workbook());
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("button", { name: "Previous.xlsx", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect(page).toHaveURL(/asset=/);
    const previousFile = new URL(page.url()).searchParams.get("asset");
    const response = await page.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "create", name: "Empty destination", kind: "new" },
    });
    expect(response.ok()).toBe(true);
    const project = await response.json();
    await page.locator("#projects-open").click();
    await page.locator(`.project-open[data-project="${project.id}"]`).click();
    await expect(page.locator("#tree-message")).toHaveText("No notes yet");
    expect(new URL(page.url()).searchParams.has("asset")).toBe(false);
    await expect(page.locator("#connection-message")).toBeHidden();
    await page.reload();
    await expect(page.locator("#tree-message")).toHaveText("No notes yet");
    await expect(page.locator("#connection-message")).toBeHidden();
    const stale = new URL("/", library.url);
    stale.searchParams.set("project", project.id);
    stale.searchParams.set("asset", previousFile);
    await page.goto(stale.href);
    await expect(page.locator("#document-message")).toContainText("Cannot open file");
    await expect(page.locator("#connection-message")).toBeHidden();
    await expect(page.locator("#tree-message")).toHaveText("No notes yet");
    expect(new URL(page.url()).searchParams.has("asset")).toBe(false);
  } finally { await library.close(); }
});

test("fresh file links select their project after login and folders only open when requested", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  const guest = await browser.newContext();
  try {
    const [owner] = library.pages;
    const response = await owner.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "create", name: "File project", kind: "new" },
    });
    expect(response.ok()).toBe(true);
    const project = await response.json();
    await fs.writeFile(path.join(project.root, "Resume.xlsx"), workbook());
    for (let i = 0; i < 8; i++) {
      await fs.mkdir(path.join(project.root, `Group ${i}`, "Inner"), { recursive: true });
      await fs.writeFile(path.join(project.root, `Group ${i}`, "Inner", `Deep ${i}.md`), `# Deep ${i}\n`);
    }
    const id = await userResourceId(owner.context(), library.url, "Resume.xlsx", "asset", project.id);
    const url = new URL("/", library.url);
    url.searchParams.set("asset", id);
    const page = await guest.newPage();
    await page.route("**/api/projects", async route => {
      const response = await route.fetch();
      const projects = await response.json();
      projects.sort((a, b) => Number(b.id === "default") - Number(a.id === "default"));
      await route.fulfill({ response, json: projects });
    });
    await page.goto(url.href);
    await page.locator("#auth-username").fill("alice");
    await page.locator("#auth-password").fill("alice test password long enough");
    await page.locator("#auth-submit").click();
    await expect(page.locator("#projects-open")).toHaveText("File project");
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect(page.locator("#connection-message")).toBeHidden();
    const folders = page.locator('details.directory[data-path^="Group "]');
    await expect(folders).toHaveCount(16);
    await expect(page.locator('details.directory[open]')).toHaveCount(0);
    const group = page.locator('details.directory[data-path="Group 0"]');
    const inner = page.locator('details.directory[data-path="Group 0/Inner"]');
    await group.locator(":scope > summary").click();
    await inner.locator(":scope > summary").click();
    await expect(page.locator("details.directory[open]")).toHaveCount(2);
    await page.reload();
    await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect(page.locator("details.directory[open]")).toHaveCount(2);
    await fs.mkdir(path.join(project.root, "New group"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator('details.directory[data-path="New group"]')).toHaveJSProperty("open", false);
    await page.locator("#file-filter").fill("Deep 7");
    await expect(page.getByRole("button", { name: "Group 7/Inner/Deep 7.md", exact: true })).toBeVisible();
    await page.locator("#file-filter").fill("");
    await expect(page.locator("details.directory[open]")).toHaveCount(2);
  } finally { await guest.close(); await library.close(); }
});

test("an invalid file bookmark does not turn a healthy workspace into a connection failure", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1 });
  try {
    const [page] = library.pages;
    const document = await userResourceId(page.context(), library.url, "Shared.md");
    const url = new URL("/", library.url);
    url.searchParams.set("project", "default");
    url.searchParams.set("asset", document);
    const missing = new URL("/", library.url);
    missing.searchParams.set("asset", "00000000-0000-7000-8000-000000000000");
    for (const target of [url, missing]) {
      await page.goto(target.href);
      await expect(page.getByRole("button", { name: "Shared.md", exact: true })).toBeVisible();
      await expect(page.locator("#document-message")).toContainText("file", { ignoreCase: true });
      await expect(page.locator("#connection-message")).toBeHidden();
      await expect(page.locator("#connection-label")).toHaveAttribute("data-state", "ready");
      await page.getByRole("button", { name: "Shared.md", exact: true }).click();
      await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
      await expect(page.locator("#connection-message")).toBeHidden();
    }
  } finally { await library.close(); }
});

test("file menus share read-only PDF, XLSX and code links without exposing the workspace", async ({ browser }) => {
  test.setTimeout(60_000);
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private" });
  const guestBrowser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium" });
  const guest = await guestBrowser.newContext();
  try {
    const [owner] = library.pages;
    const pdf = await owner.pdf(), book = workbook();
    const fixtures = [
      ["Report.xlsx", book],
      ["Report.pdf", pdf],
      ["example.py", Buffer.from("print(42)\n")],
    ];
    for (const [name, bytes] of fixtures) await fs.writeFile(path.join(library.notes, name), bytes);
    await owner.evaluate(() => window.dispatchEvent(new Event("focus")));
    const menu = owner.getByRole("menu", { name: "File actions" });
    const row = name => owner.locator(`[data-entry-path="${name}"]`);
    const errors = [];
    const page = await guest.newPage();
    page.on("pageerror", error => errors.push(error.message));
    const unexpected = [];
    page.on("request", request => {
      if (/^\/api\/(?:public\/)?(?:tree|workspace|auth\/status|preferences|projects|appearance|document)\b/.test(new URL(request.url()).pathname))
        unexpected.push(request.url());
    });
    await owner.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async text => { window.copiedLink = text; },
      } });
    });
    for (const [name, bytes] of fixtures) {
      await row(name).click();
      await expect(owner.locator("#panel-title")).toHaveText(name);
      await owner.locator("#panel-more").click();
      await owner.locator("#panel-more").click();
      await expect(menu).toBeHidden();
      await owner.locator("#panel-more").click();
      await expect(menu.getByRole("menuitem", { name: "Share file", exact: true })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
      await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
      await expect.poll(() => owner.evaluate(() => window.copiedLink)).toMatch(/asset=[a-f0-9-]+/);
      const internal = await owner.evaluate(() => window.copiedLink);
      const other = await owner.context().newPage();
      await other.goto(internal);
      await expect(other.locator("#panel-title")).toHaveText(name);
      await expect(other.locator("#workspace-file-panel")).toBeVisible();
      await other.close();
      await row(name).click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Favorite", exact: true }).click();
      await expect.poll(async () => {
        const response = await owner.request.get(new URL("/api/workspace", library.url).href);
        return (await response.json()).workspace.favorites.some(file => file.path === name);
      }).toBe(true);
      await owner.locator("#panel-more").click();
      await expect(menu.getByRole("menuitem", { name: "Unfavorite", exact: true })).toBeVisible();
      await expect(menu.locator("button:visible:not(:has(.menu-icon))")).toHaveCount(0);
      if (name.endsWith(".xlsx")) await owner.screenshot({ path: test.info().outputPath("file-actions.png") });
      await menu.getByRole("menuitem", { name: "Edit tags", exact: true }).click();
      await expect(owner.locator("#file-property-tags")).toBeFocused();
      await owner.locator("#file-property-tags").fill("shared, test");
      await owner.locator("#file-properties-save").click();
      await owner.locator("#panel-more").click();
      await menu.getByRole("menuitem", { name: "Share file", exact: true }).click();
      await expect(owner.locator("#sharing-title")).toHaveText("File permissions");
      await owner.locator("#sharing-level").selectOption("publicRead");
      await expect(owner.locator("#sharing-public-edit")).toBeHidden();
      await owner.locator("#sharing-save").click();
      await expect(owner.locator("#sharing-public-url")).toHaveValue(/\/s\/[A-Za-z0-9_-]{8}$/);
      const url = await owner.locator("#sharing-public-url").inputValue(), share = new URL(url).pathname.slice(3);
      await page.goto(url);
      await expect(page.locator("#panel-title")).toHaveText(name);
      await expect(page.locator("#auth-screen")).toBeHidden();
      await expect(page.locator("#sidebar")).toBeHidden();
      await expect(page.locator("#document-panes")).toBeHidden();
      if (name.endsWith(".xlsx")) {
        await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
        await page.getByRole("tab", { name: "South", exact: true }).click();
        await expect(page.getByRole("cell", { name: "Region 2" })).toBeVisible();
      } else if (name.endsWith(".pdf")) await expect(page.locator("#panel-body iframe")).toHaveAttribute("src", /^\/api\/public\/panel-file\?/);
      else {
        await expect(page.locator(".folio-code-source .cm-content")).toContainText("print(42)");
        await expect(page.locator(".folio-code-source .cm-content")).toHaveAttribute("contenteditable", "false");
        await expect(page.locator("#panel-tools button")).toHaveCount(0);
      }
      await page.locator("#panel-more").click();
      const publicMenu = page.getByRole("menu", { name: "File actions" });
      await expect(publicMenu.getByRole("menuitem")).toHaveCount(3);
      await expect(publicMenu.getByRole("menuitem", { name: "Download", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#panel-more")).toBeFocused();
      const headers = { "X-Folio-Share": share };
      const download = await guest.request.get(new URL(`/api/public/panel-file?${new URLSearchParams({ path: name, download: "true" })}`, url).href, { headers });
      expect(download.ok(), await download.text()).toBe(true);
      expect(await download.body()).toEqual(bytes);
      for (const forbidden of ["Other.md", ...fixtures.map(([file]) => file).filter(file => file !== name)]) {
        const denied = await guest.request.get(new URL(`/api/public/panel-file?${new URLSearchParams({ path: forbidden })}`, url).href, { headers });
        expect(denied.ok(), forbidden).toBe(false);
      }
      expect((await guest.request.get(new URL("/api/tree", url).href, { headers })).status()).toBe(401);
      expect((await guest.request.put(new URL("/api/public/panel-file", url).href, { headers, data: { path: name, content: "hacked", version: "0" } })).ok()).toBe(false);
      expect((await guest.request.post(new URL("/api/public/collaboration/join", url).href, { headers, data: { document: new URL(internal).searchParams.get("asset") } })).ok()).toBe(false);
      await page.reload();
      await expect(page.locator("#panel-title")).toHaveText(name);
      await expect(page.locator("#panel-status")).not.toContainText(/error|failed|unavailable/i);
      await owner.locator("#sharing-cancel").click();
      expect(await fs.readFile(path.join(library.notes, name))).toEqual(bytes);
    }
    await row("Shared.md").click();
    await openMoreAction(owner, "workspace-open");
    await owner.locator("#workspace-kind").selectOption("favorites");
    await owner.locator("#workspace-list .workspace-item-name").filter({ hasText: "Report.xlsx" }).click();
    await expect(owner.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await expect.poll(() => owner.url()).toContain("asset=");
    await owner.reload();
    await expect(owner.locator("#panel-title")).toHaveText("Report.xlsx");
    await expect(owner.getByRole("cell", { name: "Region 1" })).toBeVisible();
    await owner.goto(library.url);
    await expect(owner.locator("#panel-title")).toHaveText("Report.xlsx");
    await expect(owner.getByRole("cell", { name: "Region 1" })).toBeVisible();
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await guestBrowser.close(); await library.close(); }
});

for (const extension of ["xlsx", "pdf"]) test(`file sharing honors passwords, identity moves, expiration, reset and revocation (${extension})`, async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private" });
  const guest = await browser.newContext();
  try {
    const [owner] = library.pages;
    const name = `Protected.${extension}`, renamed = `Renamed.${extension}`;
    await fs.writeFile(path.join(library.notes, name), extension === "pdf" ? await owner.pdf() : workbook());
    const identity = await owner.request.post(new URL("/api/resources/resolve", library.url).href, {
      data: { path: name, kind: "asset" }, headers: { "X-Folio-Project": "default" },
    });
    expect(identity.ok(), await identity.text()).toBe(true);
    const { id } = await identity.json();
    const change = data => owner.request.post(new URL("/api/projects", library.url).href, { data: { id: "default", document: id, ...data } });
    const shared = await change({ action: "document", permission: "publicRead", publicOptions: { password: "file share password" } });
    expect(shared.ok(), await shared.text()).toBe(true);
    let token = (await shared.json()).publicLinks[name].token;
    const url = new URL(`/s/${token}`, library.url).href, page = await guest.newPage();
    const endpoint = filename => new URL(`/api/public/panel-file?${new URLSearchParams({ path: filename,
      view: extension === "pdf" ? "pdf" : "table", share: token })}`, library.url).href;
    const read = filename => guest.request.get(endpoint(filename), { headers: extension === "pdf" ? { Range: "bytes=0-4" } : {} });
    const preview = async () => {
      if (extension === "pdf") await expect(page.getByRole("link", { name: "Download PDF" })).toBeVisible();
      else await expect(page.getByRole("cell", { name: "Region 1" })).toBeVisible();
    };
    expect((await read(name)).status()).toBe(401);
    await page.goto(url);
    await expect(page.locator("#public-password-dialog")).toBeVisible();
    await expect(page.locator("#workspace-file-panel")).toBeHidden();
    await page.locator("#public-password").fill("incorrect");
    await page.locator("#public-password-submit").click();
    await expect(page.locator("#public-password-error")).toContainText("incorrect");
    await page.locator("#public-password").fill("file share password");
    await page.locator("#public-password-submit").click();
    await preview();
    expect((await read(name)).ok()).toBe(true);
    if (extension === "pdf") expect(await (await read(name)).body()).toEqual(Buffer.from("%PDF-"));
    const move = await owner.request.patch(new URL("/api/entry", library.url).href, {
      headers: { "X-Folio-Project": "default" }, data: { id, destination: renamed },
    });
    expect(move.ok(), await move.text()).toBe(true);
    await page.reload();
    await expect(page.locator("#panel-title")).toHaveText(renamed);
    await preview();
    expect((await read(name)).ok()).toBe(false);
    expect((await read(renamed)).ok()).toBe(true);
    const reset = await change({ action: "document", permission: "publicRead", resetLink: true, publicOptions: { clearPassword: true } });
    expect(reset.ok(), await reset.text()).toBe(true);
    expect((await read(renamed)).ok()).toBe(false);
    token = (await reset.json()).publicLinks[renamed].token;
    const session = await guest.request.post(new URL("/api/public/session", library.url).href, { headers: { "X-Folio-Share": token } });
    expect((await session.json()).passwordRequired).not.toBe(true);
    expect((await read(renamed)).ok()).toBe(true);
    const expired = await change({ action: "publicOptions", expiresAt: Date.now() + 1500 });
    expect(expired.ok(), await expired.text()).toBe(true);
    await expect.poll(async () => (await read(renamed)).ok()).toBe(false);
    const renew = await change({ action: "publicOptions", expiresAt: null });
    expect(renew.ok(), await renew.text()).toBe(true);
    expect((await read(renamed)).ok()).toBe(true);
    const revoke = await change({ action: "revokePublic" });
    expect(revoke.ok(), await revoke.text()).toBe(true);
    expect((await read(renamed)).ok()).toBe(false);
    expect((await change({ action: "document", permission: "publicEdit" })).status()).toBe(400);
    expect((await change({ action: "document", permission: "edit" })).status()).toBe(400);
  } finally { await guest.close(); await library.close(); }
});

test("individual file permissions and favorites work without project-wide access", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, sharing: "private" });
  try {
    const [owner] = library.pages, reader = library.contexts[1];
    for (const [name, content] of [["visible.py", "print(1)\n"], ["hidden.py", "secret\n"]])
      await fs.writeFile(path.join(library.notes, name), content);
    await fs.writeFile(path.join(library.notes, "visible.xlsx"), workbook());
    const request = (name, context = reader) => context.request.get(new URL(`/api/panel-file?path=${name}`, library.url).href, {
      headers: { "X-Folio-Project": "default" },
    });
    const identify = async name => {
      const response = await owner.request.post(new URL("/api/resources/resolve", library.url).href, {
        headers: { "X-Folio-Project": "default" }, data: { path: name, kind: "asset" },
      });
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()).id;
    };
    const id = await identify("visible.py"), book = await identify("visible.xlsx");
    const permission = async (document, value) => {
      const response = await owner.request.post(new URL("/api/projects", library.url).href, {
        data: { action: "document", id: "default", document, permission: value },
      });
      expect(response.ok(), await response.text()).toBe(true);
    };
    expect((await request("visible.py")).ok()).toBe(false);
    await permission(id, "read");
    await permission(book, "read");
    const file = await request("visible.py");
    expect(file.ok(), await file.text()).toBe(true);
    expect((await file.json()).writable).toBe(false);
    expect((await request("visible.xlsx")).ok()).toBe(true);
    expect((await request("hidden.py")).ok()).toBe(false);
    const tree = await reader.request.get(new URL("/api/tree", library.url).href, { headers: { "X-Folio-Project": "default" } });
    expect((await tree.json()).panelFiles.sort()).toEqual(["visible.py", "visible.xlsx"]);
    const favorite = await reader.request.post(new URL("/api/workspace", library.url).href, {
      data: { action: "favorite", project: "default", id, value: true },
    });
    expect(favorite.ok(), await favorite.text()).toBe(true);
    expect((await favorite.json()).workspace.favorites).toEqual([expect.objectContaining({ id, path: "visible.py" })]);
    const page = await reader.newPage();
    await page.goto(new URL(`/?project=default&asset=${id}`, library.url).href);
    await expect(page.locator(".folio-code-source .cm-content")).toHaveText("print(1)");
    await page.locator("#panel-more").click();
    const menu = page.getByRole("menu", { name: "File actions" });
    await expect(menu.getByRole("menuitem", { name: "Share file", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Unfavorite", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Edit tags", exact: true })).toHaveCount(0);
    const denied = await reader.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "document", id: "default", document: id, permission: "publicRead" },
    });
    expect(denied.status()).toBe(403);
    await permission(id, "edit");
    const fresh = await request("visible.py");
    const code = await fresh.json();
    expect(code.writable).toBe(true);
    const edited = await reader.request.put(new URL("/api/panel-file", library.url).href, {
      headers: { "X-Folio-Project": "default" }, data: { path: "visible.py", content: "print(2)\n", version: code.version },
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    await permission(id, "private");
    expect((await request("visible.py")).status()).toBe(403);
    const removed = await reader.request.post(new URL("/api/workspace", library.url).href, {
      data: { action: "favorite", project: "default", id, value: false },
    });
    expect(removed.ok(), await removed.text()).toBe(true);
    await permission(book, "private");
    expect((await request("visible.xlsx")).ok()).toBe(false);
  } finally { await library.close(); }
});

test("project file panels enforce reader permissions on both UI and save", async ({ browser }) => {
  const lib = await collaborativeLibrary(browser, { source: true, participants: 1, sharing: "read" });
  const ctx = await browser.newContext();
  try {
    await fs.writeFile(path.join(lib.notes, "script.js"), "const value = 1;\n");
    const url = new URL("/api/panel-file?path=script.js", lib.url).href;
    expect((await ctx.request.get(url)).status()).toBe(401);
    const login = await ctx.request.post(new URL("/api/auth/login", lib.url).href, {
      data: { username: "bob", password: "bob test password long enough" },
    });
    expect(login.ok()).toBe(true);
    const p = await ctx.newPage();
    await p.goto(lib.pages[0].url());
    await p.getByRole("button", { name: "script.js", exact: true }).click();
    await expect(p.getByRole("textbox", { name: "Source code" })).not.toBeEditable();
    const options = { headers: { "X-Folio-Project": "default" } },
      file = await (await ctx.request.get(url, options)).json();
    const propertiesUrl = new URL("/api/file-properties?path=script.js", lib.url).href;
    const properties = await (await ctx.request.get(propertiesUrl, options)).json();
    expect(properties.writable).toBe(false);
    const propertyEdit = {
      path: "script.js", id: properties.entry.id, revision: properties.snapshot.revision,
      properties: { title: "Script", tags: ["code"], description: "" },
    };
    expect((await ctx.request.put(propertiesUrl, { ...options, data: propertyEdit })).status()).toBe(403);
    expect((await ctx.request.post(url, { ...options, data: { path: "script.js", destination: "copy.js" } })).status()).toBe(403);
    const put = await ctx.request.put(new URL("/api/panel-file", lib.url).href, {
      ...options,
      data: { path: "script.js", version: file.version, content: "changed" },
    });
    expect(put.status()).toBe(403);
    expect(await fs.readFile(path.join(lib.notes, "script.js"), "utf8")).toContain("value = 1");
    const [owner] = lib.pages;
    const share = async (data) => {
      const result = await owner.request.post(new URL("/api/projects", lib.url).href, {
        data: { id: "default", ...data },
      });
      expect(result.ok(), await result.text()).toBe(true);
      return result.json();
    };
    await share({ action: "share", shared: "edit" });
    expect((await ctx.request.put(propertiesUrl, { ...options, data: propertyEdit })).ok()).toBe(true);
    expect((await ctx.request.put(propertiesUrl, { ...options, data: propertyEdit })).status()).toBe(409);
    const edited = await ctx.request.put(url, {
      ...options,
      data: { path: "script.js", version: file.version, content: "const value = 2;\n" },
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    expect(await fs.readFile(path.join(lib.notes, "script.js"), "utf8")).toBe("const value = 2;\n");
    await fs.writeFile(path.join(lib.notes, "Only.md"), "[Attachment](script.js)\n");
    const id = (name) => userResourceId(owner.context(), lib.url, name);
    await share({ action: "document", document: await id("Only.md"), permission: "private" });
    const tree = async () =>
      (await (await ctx.request.get(new URL("/api/tree", lib.url).href, options)).json()).panelFiles ?? [];
    expect(await tree()).not.toContain("script.js");
    expect((await ctx.request.get(url, options)).status()).toBe(403);
    expect((await ctx.request.get(propertiesUrl, options)).status()).toBe(403);
    await fs.writeFile(path.join(lib.notes, "another.js"), "// Project only\n");
    await share({ action: "share", shared: "private" });
    const document = await id("Shared.md");
    await share({ action: "share", document, shared: "read" });
    expect(await tree()).toEqual([]);
    expect((await ctx.request.get(url.replace("script.js", "another.js"), options)).status()).toBe(403);
    const pub = await share({ action: "document", document, permission: "publicRead" });
    const guest = await browser.newContext();
    try {
      const headers = { "X-Folio-Share": pub.publicLinks["Shared.md"].token };
      expect((await guest.request.get(url, { headers })).status()).toBe(401);
      expect(
        (await guest.request.get(url.replace("/api/panel-file", "/api/public/panel-file"), { headers })).ok(),
      ).toBe(false);
    } finally {
      await guest.close();
    }
  } finally {
    await ctx.close();
    await lib.close();
  }
});

