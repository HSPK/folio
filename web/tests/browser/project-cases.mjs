import { test, expect, fs, path, buildRoot, chooseView, userDocumentUrl, userResourceId, confirmDialog, primaryModifier, openSettingsDialog } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

async function projectApi(page, library, body) {
  const response = await page.request.post(new URL("/api/projects", library.url).href, { data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test("a rejected project route preserves the active note and leaves the project switch retryable", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true });
  try {
    const [page] = library.pages;
    const project = await projectApi(page, library, { action: "create", name: "Retryable project", kind: "new", source: "" });
    const before = await page.locator("#editor").inputValue();
    const url = page.url();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.locator("#projects-open").click();
    await page.evaluate(() => {
      window.savedProjectPushState = history.pushState;
      history.pushState = () => { throw new DOMException("Rejected project route", "SecurityError"); };
    });
    const target = page.locator(`.project-open[data-project="${project.id}"]`);
    await target.click();
    await expect(page.locator("#document-message")).toContainText("Could not finish switching projects:");
    await expect(page.locator("#editor")).toHaveValue(before);
    await expect(page.locator("#document-title")).toHaveText("Shared");
    expect(page.url()).toBe(url);
    expect(errors).toEqual([]);
    await page.evaluate(() => {
      history.pushState = window.savedProjectPushState;
      delete window.savedProjectPushState;
    });
    await target.click();
    await expect(page.locator("#projects-open")).toHaveText("Retryable project");
    await expect(page.locator("#projects-dialog")).toBeHidden();
    expect(new URL(page.url()).searchParams.get("project")).toBe(project.id);
  } finally { await library.close(); }
});

export async function writeClipboardImage(page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 12;
    const context = canvas.getContext("2d");
    context.fillStyle = "#267d9f";
    context.fillRect(0, 0, 16, 12);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
}

export async function pasteImage(page, selector) {
  if (selector === ".ProseMirror") await expect(page.locator(selector)).toHaveAttribute("contenteditable", "true");
  await writeClipboardImage(page);
  await page.locator(selector).focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.press(`${primaryModifier}+v`);
}

test("users create private projects and share a single page without exposing sibling notes", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [alice, bob] = library.pages;
    await alice.locator("#projects-open").click();
    await alice.locator("#project-new").click();
    await alice.locator("#project-name").fill("Personal notebook");
    await alice.locator("#project-create").click();
    await expect(alice.locator("#projects-dialog")).toBeHidden();
    await expect(alice.locator("#projects-open")).toHaveText("Personal notebook");
    const id = new URL(alice.url()).searchParams.get("project");
    for (const [name, content] of [["Shared.md", "# Project-specific content\n"], ["Secret.md", "# Private sibling\n"]]) {
      const created = await alice.request.post(new URL("/api/document", library.url).href, {
        headers: { "X-Folio-Project": id }, data: { path: name, content },
      });
      expect(created.status(), await created.text()).toBe(201);
    }
    const document = await userResourceId(alice.context(), library.url, "Shared.md", "document", id);
    await alice.goto(await userDocumentUrl(alice.context(), library.url, "Shared.md", id));
    await expect(alice.locator(".ProseMirror")).toContainText("Project-specific content");
    await bob.locator("#projects-open").click();
    await expect(bob.locator("#projects-list")).not.toContainText("Personal notebook");
    await bob.locator("#projects-close").click();
    await alice.locator("#more-menu > summary").click();
    await alice.locator("#share-page").click();
    await alice.locator("#sharing-level").selectOption("read");
    await alice.locator("#sharing-save").click();
    await expect(alice.locator("#sharing-dialog")).toBeHidden();
    await bob.locator("#projects-open").click();
    await bob.locator(".project-open").filter({ hasText: "Personal notebook" }).click();
    await expect(bob.locator('#file-list [data-path="Shared.md"]')).toBeVisible();
    await expect(bob.locator('#file-list [data-path="Secret.md"]')).toHaveCount(0);
    await bob.locator('[data-path="Shared.md"]').click();
    await expect(bob.locator("#dirty-indicator")).toHaveText("Read only");
    await expect(bob.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    await expect(bob.locator("#git-tab")).toHaveCount(0);
    await expect(bob.locator("#new-note")).toBeDisabled();
    await bob.reload();
    await expect(bob.locator("#projects-open")).toHaveText("Personal notebook");
    await expect(bob.locator("#dirty-indicator")).toHaveText("Read only");
    await projectApi(alice, library, { action: "document", id, document, permission: "edit" });
    await expect(bob.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
    await bob.locator(".ProseMirror").click();
    await bob.keyboard.press("Control+End");
    await bob.keyboard.insertText(" Bob editing this page");
    await expect(alice.locator(".ProseMirror")).toContainText("Bob editing this page");
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await projectApi(alice, library, { action: "document", id, document, permission: "private" });
    await expect(bob.locator("#collaboration-message")).toContainText(/private|shared|permission/i);
    const denied = await bob.request.get(new URL(`/api/document?id=${document}&project=${id}`, library.url).href);
    expect(denied.status()).toBe(403);
    await alice.locator("#projects-open").click();
    await alice.locator('.project-open[data-project="default"]').click();
    await alice.locator('[data-path="Shared.md"]').click();
    await expect(alice.locator(".ProseMirror")).not.toContainText("Project-specific content");
    await expect(alice.locator(".ProseMirror")).toContainText("Alpha");
  } finally { await library.close(); }
});

test("project manager uses one lightweight dialog without nested frames or page navigation", async ({ browser }) => {
  test.setTimeout(60000);
  const library = await collaborativeLibrary(browser, { participants: 1, source: true });
  try {
    const [page] = library.pages;
    const nativeDialogs = [];
    const errors = [];
    page.on("dialog", dialog => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });
    page.on("pageerror", error => errors.push(error.message));
    const capture = async name => {
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      await expect(page.locator(".document-area")).toBeVisible();
      await expect(page.getByRole("dialog", {
        name: await page.locator("#projects-title").innerText(), exact: true,
      })).toHaveCount(1);
      const bounds = await page.locator("#projects-dialog").boundingBox();
      const viewport = page.viewportSize();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      const surfaces = await page.locator(".project-row, .project-symbol").evaluateAll(nodes =>
        nodes.map(node => ({ border: getComputedStyle(node).borderTopWidth, shadow: getComputedStyle(node).boxShadow })));
      for (const surface of surfaces) expect(surface).toEqual({ border: "0px", shadow: "none" });
      await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
    };

    const initialUrl = page.url();
    await expect(page.locator("#editor")).toHaveValue(/Alpha/);
    const initialSource = await page.locator("#editor").inputValue();
    await page.locator("#editor").evaluate(node => { window.editorBeforeProjects = node; });
    await page.locator("#projects-open").click();
    await expect(page.locator("#project-create-form")).toBeHidden();
    await capture("projects-desktop");
    const trigger = await page.locator("#projects-open").boundingBox();
    const picker = await page.locator("#projects-dialog").boundingBox();
    expect(Math.abs(picker.x - trigger.x)).toBeLessThan(2);
    expect(picker.y + picker.height).toBeLessThanOrEqual(trigger.y);
    await page.mouse.click(700, 100);
    await expect(page.locator("#projects-dialog")).toBeHidden();
    await page.locator("#projects-open").click();
    await page.locator("#projects-filter").fill("missing project");
    await expect(page.locator("#projects-empty")).toHaveText("No matching projects");
    await page.locator("#projects-filter").fill("notes");
    await page.locator("#projects-filter").press("Enter");
    await expect(page.locator("#projects-dialog")).toBeHidden();
    await expect(page.locator(".document-area")).toBeVisible();
    await expect(page.locator("#editor")).toHaveValue(initialSource);
    expect(await page.locator("#editor").evaluate(node => node === window.editorBeforeProjects)).toBe(true);
    expect(page.url()).toBe(initialUrl);

    await page.locator("#projects-open").click();
    await page.locator("#project-new").click();
    await page.locator("#project-kind").selectOption("folder");
    await page.locator("#project-name").fill("Draft project");
    await page.locator("#project-source").fill(library.notes);
    await page.locator("#project-back").click();
    await expect(page.locator("#project-confirm")).toBeVisible();
    await capture("project-inline-confirmation");
    await confirmDialog(page, { accept: false });
    await expect(page.locator("#project-name")).toHaveValue("Draft project");
    await page.locator("#project-create-cancel").click();
    await expect(page.locator("#project-token")).toHaveCount(0);
    await page.locator("#project-new").click();
    await page.locator("#project-name").fill("Quiet space");
    await capture("project-create-desktop");
    await page.locator("#project-create").click();
    await expect(page.locator("#projects-dialog")).toBeHidden();
    await expect(page.locator("#projects-open")).toHaveText("Quiet space");

    await page.locator("#projects-open").click();
    await page.getByRole("button", { name: "Manage Quiet space", exact: true }).click();
    await expect(page.locator("#projects-title")).toHaveText("Project settings");
    await page.keyboard.press("Control+p");
    await expect(page.locator("#search-dialog")).toBeHidden();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await page.locator("#sharing-name").fill("Studio");
    await page.locator("#sharing-image-directory").fill("media/images");
    await capture("project-settings-desktop");
    await page.locator("#sharing-image-directory").press("Control+s");
    await expect(page.locator("#projects-dialog")).toHaveAttribute("data-view", "browse");
    await expect(page.locator("#projects-filter")).toBeFocused();
    await expect(page.locator("#projects-open")).toHaveText("Studio");
    await page.getByRole("button", { name: "Manage Studio", exact: true }).click();
    await page.locator("#sharing-name").fill("Do not save");
    await page.locator("#project-back").click();
    await confirmDialog(page);
    await expect(page.locator("#projects-list")).toContainText("Studio");
    await expect(page.locator("#projects-list")).not.toContainText("Do not save");
    await page.locator('.project-open[data-project="default"]').click();
    await page.locator('#file-list [data-path="Shared.md"]').click();

    await page.locator("#more-menu > summary").click();
    await page.locator("#share-page").click();
    await page.locator("#sharing-level").selectOption("publicRead");
    await page.locator("#sharing-save").click();
    await expect(page.locator("#sharing-public-url")).not.toHaveValue("");
    await capture("page-permissions-desktop");
    const original = await page.locator("#sharing-public-url").inputValue();
    await page.locator("#sharing-reset-link").click();
    await confirmDialog(page, { accept: false });
    await expect(page.locator("#sharing-public-url")).toHaveValue(original);
    await page.locator("#sharing-reset-link").click();
    await confirmDialog(page);
    await expect(page.locator("#sharing-public-url")).not.toHaveValue(original);

    await page.setViewportSize({ width: 375, height: 812 });
    await capture("page-permissions-mobile");
    await page.locator("#project-back").click();
    await capture("projects-mobile");
    await page.getByRole("button", { name: "Manage notes", exact: true }).click();
    await expect(page.locator("#projects-title")).toHaveText("Project settings");
    await expect(page.locator("#sharing-documents .project-open")).toHaveCount(1);
    await capture("project-settings-mobile");
    await page.locator("#sharing-documents .project-open").filter({ hasText: "Shared.md" }).click();
    await expect(page.locator("#projects-title")).toHaveText("Document permissions");
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await page.locator("#project-back").click();
    await expect(page.locator("#projects-title")).toHaveText("Project settings");
    await page.locator("#project-back").click();
    await page.locator("#project-new").click();
    await page.locator("#project-kind").selectOption("new");
    await capture("project-create-mobile");
    await page.locator("#project-create-cancel").click();
    await page.locator("#projects-close").click();

    await page.setViewportSize({ width: 1440, height: 960 });
    await openSettingsDialog(page);
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.locator("#settings-theme").selectOption("dark");
    await page.locator("#settings-save").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#projects-open").click();
    await capture("projects-dark");
    await page.locator("#projects-close").click();
    expect(nativeDialogs).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await library.close(); }
});

test("project folder settings refresh the active tree and protect unsaved notes without moving files", async ({ browser }) => {
  test.setTimeout(60000);
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, saveDelay: 10000 });
  const replacement = await fs.mkdtemp(path.join(buildRoot, "project-folder-"));
  const archive = await fs.mkdtemp(path.join(buildRoot, "project-archive-"));
  try {
    const [page] = library.pages;
    const original = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    await fs.writeFile(path.join(replacement, "Shared.md"), "# New shared note\n");
    await fs.writeFile(path.join(replacement, "Replacement.md"), "# Replacement directory\n");
    await page.locator("#projects-open").click();
    await page.getByRole("button", { name: "Manage notes", exact: true }).click();
    await expect(page.locator("#sharing-root")).toHaveValue(await fs.realpath(library.notes));
    await expect(page.locator("#sharing-root")).toHaveJSProperty("readOnly", false);
    await page.locator("#sharing-root").fill("relative/folder");
    await page.locator("#sharing-save").click();
    await expect(page.locator("#sharing-error")).toContainText("absolute");
    await expect(page.locator("#editor")).toHaveValue(original);
    await expect(page.locator("#projects-dialog")).toHaveAttribute("data-view", "sharing");
    await page.locator("#sharing-cancel").click();
    await page.getByRole("button", { name: "Manage notes", exact: true }).click();
    await page.locator("#sharing-root").fill(replacement);
    const capture = async name => {
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      await expect(page.locator("#sharing-root")).toBeVisible();
      const bounds = await page.locator("#projects-dialog").boundingBox();
      const viewport = page.viewportSize();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
    };
    await capture("project-folder-desktop");
    await page.setViewportSize({ width: 375, height: 812 });
    await capture("project-folder-mobile");
    await page.locator("#sharing-cancel").click();
    await page.locator("#projects-close").click();
    await page.setViewportSize({ width: 1440, height: 960 });
    const preferencesUrl = new URL("/api/preferences", library.url).href;
    const preferences = await (await page.request.get(preferencesUrl)).json();
    preferences.appearance.theme = "dark";
    const savedPreferences = await page.request.put(preferencesUrl, { data: preferences });
    expect(savedPreferences.ok(), await savedPreferences.text()).toBe(true);
    await page.reload();
    await expect(page.locator("#editor")).toHaveValue(original);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#editor").fill(`${original}\nUnsaved local note\n`);
    await page.locator("#projects-open").click();
    await page.getByRole("button", { name: "Manage notes", exact: true }).click();
    await page.locator("#sharing-root").fill(replacement);
    await capture("project-folder-dark");
    let failSave = true;
    await page.route("**/api/document", route => route.request().method() === "PUT" && failSave
      ? route.fulfill({ status: 500, json: { error: "Temporary save failure." } }) : route.continue());
    await page.locator("#sharing-save").click();
    await expect(page.locator("#project-confirm-message")).toContainText("Temporary save failure.");
    await confirmDialog(page, { accept: false });
    await expect(page.locator("#editor")).toHaveValue(/Unsaved local note/);
    const unchanged = await (await page.request.get(new URL("/api/projects", library.url).href)).json();
    expect(unchanged.find(project => project.id === "default").root).toBe(await fs.realpath(library.notes));
    failSave = false;
    await page.locator("#sharing-save").click();
    await expect(page.locator("#projects-dialog")).toBeHidden();
    await expect(page.locator('#file-list [data-path="Replacement.md"]')).toBeVisible();
    await expect(page.locator('#file-list [data-path="Other.md"]')).toHaveCount(0);
    await expect(page.locator("#editor")).toHaveValue("");
    expect(new URL(page.url()).searchParams.has("document")).toBe(false);
    await page.locator('#file-list [data-path="Shared.md"]').click();
    await expect(page.locator("#editor")).toHaveValue("# New shared note\n");
    await expect(page.locator("#draft-recovery-dialog")).toBeHidden();
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(`${original}\nUnsaved local note\n`);
    expect(await fs.readFile(path.join(replacement, "Shared.md"), "utf8")).toBe("# New shared note\n");
    await page.locator("#projects-open").click();
    await page.getByRole("button", { name: "Manage notes", exact: true }).click();
    await expect(page.locator("#sharing-root")).toHaveValue(await fs.realpath(replacement));
    await page.locator("#sharing-cancel").click();
    await page.locator("#projects-close").click();

    const inactive = await projectApi(page, library, { action: "create", kind: "new", name: "Archive" });
    await page.locator("#editor").fill("# Keep this current draft\n");
    const activeUrl = page.url();
    await page.locator("#projects-open").click();
    await page.getByRole("button", { name: "Manage Archive", exact: true }).click();
    await page.locator("#sharing-root").fill(archive);
    await page.locator("#sharing-save").click();
    await expect(page.locator("#projects-dialog")).toHaveAttribute("data-view", "browse");
    await page.locator("#projects-close").click();
    await expect(page.locator("#editor")).toHaveValue("# Keep this current draft\n");
    expect(page.url()).toBe(activeUrl);
    const projects = await (await page.request.get(new URL("/api/projects", library.url).href)).json();
    expect(projects.find(project => project.id === inactive.id).root).toBe(await fs.realpath(archive));
  } finally {
    await library.close();
    await fs.rm(replacement, { recursive: true, force: true });
    await fs.rm(archive, { recursive: true, force: true });
  }
});

test("project folder changes reject pending collaboration and reset saved sessions safely", async ({ browser }) => {
  test.setTimeout(60000);
  const library = await collaborativeLibrary(browser, { source: true, saveDelay: 10000 });
  const replacement = await fs.mkdtemp(path.join(buildRoot, "project-shared-folder-"));
  try {
    const [alice, bob] = library.pages;
    await fs.writeFile(path.join(replacement, "Shared.md"), "# Replacement shared note\n");
    await expect(alice.locator("#editor")).toHaveValue(/Alpha/);
    const original = await alice.locator("#editor").inputValue();
    await alice.locator("#editor").fill(`${original}\nPending shared edit\n`);
    await expect(bob.locator("#editor")).toHaveValue(/Pending shared edit/);
    const pending = await alice.request.post(new URL("/api/projects", library.url).href, {
      data: { action: "share", id: "default", shared: "edit", root: replacement },
    });
    expect(pending.status()).toBe(409);
    expect((await pending.json()).error).toContain("saved");
    for (const page of library.pages) await expect(page.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    await alice.locator("#editor").press(`${primaryModifier}+s`);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const saved = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    expect(saved).toContain("Pending shared edit");
    await projectApi(alice, library, { action: "share", id: "default", shared: "edit", root: replacement });
    for (const page of library.pages) await expect(page.locator("#collaboration-message")).toContainText(/folder changed/i);
    await Promise.all(library.pages.map(page => page.reload()));
    for (const page of library.pages) {
      await expect(page.locator("#editor")).toHaveValue("# Replacement shared note\n");
      await expect(page.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    }
    await bob.locator("#editor").fill("# Edited in the replacement folder\n");
    await expect(alice.locator("#editor")).toHaveValue("# Edited in the replacement folder\n");
    await bob.locator("#editor").press(`${primaryModifier}+s`);
    await expect(bob.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(saved);
    expect(await fs.readFile(path.join(replacement, "Shared.md"), "utf8")).toBe("# Edited in the replacement folder\n");

    await projectApi(bob, library, { action: "create", kind: "new", name: "Bob notebook" });
    await bob.locator("#projects-open").click();
    await bob.getByRole("button", { name: "Manage Bob notebook", exact: true }).click();
    await expect(bob.locator("#sharing-root")).toHaveJSProperty("readOnly", true);
    await bob.locator("#sharing-name").fill("Bob renamed notebook");
    await bob.locator("#sharing-save").click();
    await expect(bob.locator("#projects-dialog")).toHaveAttribute("data-view", "browse");
    await expect(bob.locator("#projects-list")).toContainText("Bob renamed notebook");
  } finally {
    await library.close();
    await fs.rm(replacement, { recursive: true, force: true });
  }
});

test("clipboard images use the configured project directory in Live and Source, including page-only editors", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [alice, bob] = library.pages;
    const document = new URL(alice.url()).searchParams.get("document");
    await openSettingsDialog(alice);
    await alice.locator('[data-settings-tab="library"]').click();
    await alice.locator("#settings-image-directory").fill("media/pasted");
    await alice.locator("#settings-save").click();
    await expect(alice.locator("#settings-dialog")).toBeHidden();
    await projectApi(alice, library, { action: "share", id: "default", shared: "private" });
    await projectApi(alice, library, { action: "share", id: "default", document, shared: "edit" });
    await bob.reload();
    await expect(bob.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    await pasteImage(bob, ".ProseMirror");
    const image = alice.locator(".folio-inline-image img");
    await expect(image).toHaveCount(1);
    await expect(bob.locator("#document-message")).toBeHidden();
    await expect.poll(() => image.evaluate((node) => node.naturalWidth)).toBe(16);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const content = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    expect(content).toMatch(/!\[Image\]\(media\/pasted\/image-[a-f0-9]+\.png\)/);
    expect(content).toContain("Alpha");
    expect(content).toContain("# Shared\n");
    expect(content.indexOf("![Image]")).toBeGreaterThan(content.indexOf("Beta"));
    await chooseView(bob, "editor");
    await pasteImage(bob, "#editor");
    await expect(bob.locator("#editor")).toHaveValue(/!\[Image\][\s\S]*!\[Image\]/);
    await expect(alice.locator(".folio-inline-image img")).toHaveCount(2);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const saved = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    expect(saved).toContain("# Shared\n");
    expect(saved.indexOf("![Image]")).toBeGreaterThan(saved.indexOf("Beta"));
    expect((await fs.readdir(path.join(library.notes, "media/pasted"))).filter((name) => name.endsWith(".png"))).toHaveLength(2);
    await projectApi(alice, library, { action: "share", id: "default", document, shared: "read" });
    await expect(bob.locator("#dirty-indicator")).toHaveText("Read only");
    await alice.screenshot({ path: path.join(buildRoot, "projects-image-sharing.png") });
  } finally { await library.close(); }
});

test("loading and warnings float at bottom right without shifting editor or sidebar", async ({ page, browserName }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/document?id=*", async (route) => {
    await pending;
    await route.continue();
  });
  const before = await page.locator("#document-panes").boundingBox();
  const sidebar = await page.locator("#file-nav").boundingBox();
  try {
    await page.locator('[data-path="Second.md"]').click();
    await expect(page.locator("#loading-message")).toContainText("Opening");
    expect(await page.locator("#loading-message").evaluate(node => Boolean(node.closest(".status-notices")))).toBe(true);
    expect(await page.locator("#loading-message").evaluate(node => Boolean(node.closest(".status-bar")))).toBe(false);
    expect(await page.locator("#document-panes").boundingBox()).toEqual(before);
    expect(await page.locator("#file-nav").boundingBox()).toEqual(sidebar);
    await expect(page.locator(".document-alerts")).toHaveCount(0);
    await expect(page.locator("#status-notices")).toBeVisible();
    const bounds = await page.locator("#status-notices").boundingBox();
    const viewport = page.viewportSize();
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(bounds.x).toBeGreaterThan(viewport.width / 2);
    const footer = await page.locator(".status-bar").boundingBox();
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(footer.y - 6);
    expect(bounds.y + bounds.height).toBeGreaterThan(footer.y - 25);
    if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("floating-loading.png"), caret: "initial" });
  } finally { release(); }
  await expect(page.locator("#document-title")).toHaveText("Second.md");
  await page.route("**/api/tree", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable for status layout test" }),
  }));
  await page.locator("#refresh-files").click();
  await expect(page.locator("#tree-message")).toContainText("Unavailable for status layout test");
  expect(await page.locator("#tree-message").evaluate(node => Boolean(node.closest(".status-notices")))).toBe(true);
  expect(await page.locator("#tree-message").evaluate(node => Boolean(node.closest(".status-bar")))).toBe(false);
});
