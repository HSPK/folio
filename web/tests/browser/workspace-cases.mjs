import { test, expect, fs, path, chooseView, metadataField, confirmDialog, primaryModifier, openMoreAction, userDocumentUrl } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

async function append(page, text) {
  await page.locator("#editor").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(text);
}

async function draftRows(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("folio-private-drafts", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const records = await new Promise((resolve, reject) => {
        const request = database.transaction("drafts").objectStore("drafts").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return await Promise.all(records.map(async (record) => ({
        key: record.key,
        cleartext: new TextDecoder().decode(record.payload instanceof Blob ? await record.payload.arrayBuffer() : record.payload),
      })));
    } finally { database.close(); }
  });
}

async function privateRecovery(browser, { recovered = "# Private recovery content\n\nKeep this copy until saving is confirmed.\n", live = false } = {}) {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, sharing: "private", saveDelay: 10000 });
  try {
    const [page] = library.pages;
    const original = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    await page.locator("#editor").fill(recovered);
    await expect.poll(async () => (await draftRows(page)).length).toBeGreaterThan(0);
    if (live) {
      const endpoint = new URL("/api/preferences", library.url).href;
      const preferences = await (await page.request.get(endpoint)).json();
      preferences.web.defaultView = "live";
      expect((await page.request.put(endpoint, { data: preferences })).ok()).toBe(true);
    }
    await page.reload();
    await expect(page.locator("#draft-recovery-dialog")).toBeVisible();
    return { library, page, original, recovered };
  } catch (cause) { await library.close(); throw cause; }
}

test("applying a private recovery copy uses ordinary saving and remains an undoable source edit", async ({ browser }) => {
  const { library, page, original, recovered } = await privateRecovery(browser);
  try {
    await page.locator("#draft-recovery-apply").click();
    await confirmDialog(page);
    await expect(page.locator("#draft-recovery-dialog")).toBeHidden();
    await expect(page.locator("#editor")).toHaveValue(recovered);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(recovered);
    await expect.poll(async () => (await draftRows(page)).length).toBe(0);
    await page.locator("#editor").focus();
    await page.keyboard.press(`${primaryModifier}+z`);
    await expect(page.locator("#editor")).toHaveValue(original);
  } finally { await library.close(); }
});

test("large recovery edits use virtual Source and undo back to the original document", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, sharing: "private", saveDelay: 10000 });
  try {
    const [page] = library.pages;
    const large = "# Large recovered source\n\n" + "recovered source line\n".repeat(45000);
    const file = path.join(library.notes, "Large.md");
    await fs.writeFile(file, large);
    await page.goto(await userDocumentUrl(page.context(), library.url, "Large.md"));
    const editing = page.locator(".virtual-source-editor .cm-content");
    await expect(editing).toBeVisible();
    await editing.focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await page.keyboard.insertText("RECOVERY TAIL\n");
    const recovered = large + "RECOVERY TAIL\n";
    await expect.poll(async () => (await draftRows(page)).length).toBeGreaterThan(0);
    const original = "# New disk baseline\n";
    await fs.writeFile(file, original);
    await page.reload();
    await expect(page.locator("#draft-recovery-dialog")).toBeVisible();
    await page.locator("#draft-recovery-apply").click();
    await confirmDialog(page);
    await expect(page.locator("#draft-recovery-dialog")).toBeHidden();
    const source = page.locator(".virtual-source-editor .cm-content");
    await expect(source).toBeVisible();
    expect(await fs.readFile(file, "utf8")).toBe(recovered);
    await source.focus();
    await page.keyboard.press(`${primaryModifier}+z`);
    await page.keyboard.press(`${primaryModifier}+s`);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(file, "utf8")).toBe(original);
  } finally { await library.close(); }
});

test("Live recovery projects the recovered body without navigating or replacing the active resource", async ({ browser }) => {
  const { library, page, recovered } = await privateRecovery(browser, { live: true });
  try {
    const url = page.url();
    await page.locator("#draft-recovery-apply").click();
    await confirmDialog(page);
    await expect(page.locator("#draft-recovery-dialog")).toBeHidden();
    await expect(page.locator(".ProseMirror h1")).toHaveText("Private recovery content");
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
    expect(page.url()).toBe(url);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(recovered);
  } finally { await library.close(); }
});

test("a failed recovery save keeps its text and encrypted copy available for an explicit retry", async ({ browser }) => {
  const { library, page, original, recovered } = await privateRecovery(browser);
  const reject = route => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, json: { error: "Recovery save unavailable." } }) : route.continue();
  try {
    await page.route("**/api/document", reject);
    await page.locator("#draft-recovery-apply").click();
    await confirmDialog(page);
    await expect(page.locator("#draft-recovery-error")).toContainText("copy is kept");
    await page.screenshot({ path: test.info().outputPath("kept-recovery-copy.png"), animations: "disabled" });
    await expect(page.locator("#editor")).toHaveValue(recovered);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(original);
    await expect.poll(async () => (await draftRows(page)).length).toBeGreaterThan(0);
    await page.unroute("**/api/document", reject);
    await page.locator("#draft-recovery-apply").click();
    await confirmDialog(page);
    await expect(page.locator("#draft-recovery-dialog")).toBeHidden();
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(recovered);
  } finally { await library.close(); }
});

test("navigating away while recovery reads the disk cancels the old copy without replacing the newly opened note", async ({ browser }) => {
  const { library, page, original, recovered } = await privateRecovery(browser);
  let release;
  try {
    const next = await userDocumentUrl(page.context(), library.url, "Other.md");
    const old = new URL(page.url()).searchParams.get("document");
    let started;
    const requested = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let finished;
    const completed = new Promise(resolve => { finished = resolve; });
    await page.route("**/api/document?**", async route => {
      if (new URL(route.request().url()).searchParams.get("id") !== old) return route.continue();
      started();
      await held;
      const response = await page.request.get(route.request().url());
      await route.fulfill({ response });
      finished();
    });
    await page.locator("#draft-recovery-apply").click();
    await confirmDialog(page);
    await requested;
    await page.evaluate(url => {
      history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, next);
    await expect(page.locator("#document-title")).toHaveText("Other.md");
    await expect(page.locator("#draft-recovery-dialog")).toBeHidden();
    release();
    await completed;
    await expect(page.locator("#editor")).not.toHaveValue(recovered);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(original);
    await expect.poll(async () => (await draftRows(page)).length).toBeGreaterThan(0);
  } finally { release?.(); await library.close(); }
});

test("acknowledged but unsaved collaborative drafts resume without a manual recovery dialog", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { source: true, saveDelay: 10_000 });
  try {
    const [alice, bob] = library.pages;
    const opened = alice.waitForEvent("websocket");
    await alice.reload();
    const socket = await opened;
    await expect(alice.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    const acknowledged = socket.waitForEvent("framereceived", (event) =>
      typeof event.payload === "string" && event.payload.includes('"type":"ack"'));
    await append(alice, "\nACKNOWLEDGED DRAFT\n");
    await acknowledged;
    await expect(bob.locator("#editor")).toHaveValue(/ACKNOWLEDGED DRAFT/);
    await expect.poll(async () => (await draftRows(alice)).length).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).not.toContain("ACKNOWLEDGED DRAFT");
    await alice.reload();
    await expect(alice.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#draft-recovery-dialog")).toBeHidden();
    await expect(alice.locator("#editor")).toHaveValue(/ACKNOWLEDGED DRAFT/);
  } finally { await library.close(); }
});

test("accepted collaborative updates survive a crash and encrypted offline drafts merge after a browser refresh", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { source: true, routeSockets: true, saveDelay: 10_000 });
  try {
    const [alice, bob] = library.pages;
    await append(alice, "\nDURABLE ACCEPTED TEXT\n");
    await expect(bob.locator("#editor")).toHaveValue(/DURABLE ACCEPTED TEXT/);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).not.toContain("DURABLE ACCEPTED TEXT");
    const reconnected = library.pages.map(page => page.waitForEvent("websocket"));
    await library.restart(true);
    await Promise.all(reconnected);
    await expect(alice.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    await expect(bob.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#editor")).toHaveValue(/DURABLE ACCEPTED TEXT/);
    await alice.locator("#editor").focus();
    await alice.keyboard.press(`${primaryModifier}+s`);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await alice.context().setOffline(true);
    const disconnected = library.sockets.at(-1);
    await disconnected.socket.close({ code: 1012, reason: "offline draft fixture" });
    await disconnected.server.close();
    await expect(alice.locator("#collaboration-join")).toHaveText("Reconnect");
    await append(alice, "\nOFFLINE RECOVERY 中文\n");
    await expect.poll(async () => (await draftRows(alice)).length).toBeGreaterThan(0);
    for (const row of await draftRows(alice)) expect(row.cleartext).not.toContain("OFFLINE RECOVERY");
    await append(bob, "\nREMOTE WHILE OFFLINE\n");
    await alice.context().setOffline(false);
    await alice.reload();
    await expect(alice.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#editor")).toHaveValue(/OFFLINE RECOVERY 中文/);
    await expect(alice.locator("#editor")).toHaveValue(/REMOTE WHILE OFFLINE/);
    await expect(bob.locator("#editor")).toHaveValue(/OFFLINE RECOVERY 中文/);
    await alice.locator("#editor").focus();
    await alice.keyboard.press(`${primaryModifier}+s`);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await expect.poll(async () => (await draftRows(alice)).length).toBe(0);
  } finally { await library.close(); }
});

test("metadata tags drive permission-filtered search and history restores without replacing YAML spelling", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [alice, bob] = library.pages;
    const metadata = await metadataField(alice);
    await metadata.fill('title: "Shared"\n# Preserve this\ncustom: {x: 1}\n');
    const add = alice.getByRole("textbox", { name: "Add a metadata tag" });
    await add.fill("research");
    await add.press("Enter");
    await expect(metadata).toHaveValue(/tags: \["research"\]/);
    await expect(metadata).toHaveValue(/custom: \{x: 1\}/);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await alice.locator(".folio-tag").getByRole("button", { name: "research", exact: true }).click();
    await expect(alice.locator("#search-dialog")).toBeVisible();
    await expect(alice.locator("#search-results")).toContainText("Shared");
    await expect(alice.locator("#search-results")).not.toContainText("Other.md");
    await alice.locator("#search-close").click();
    await chooseView(alice, "editor");
    await append(alice, "\nVERSION TO REVERT\n");
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await openMoreAction(alice, "history-open");
    await expect(alice.locator("#history-list button")).toHaveCount(3);
    await alice.locator("#history-list button").nth(1).click();
    await expect(alice.locator("#history-diff")).toContainText("VERSION TO REVERT");
    await alice.locator("#history-restore").click();
    await confirmDialog(alice);
    await expect(alice.locator("#history-dialog")).toBeHidden();
    await expect(alice.locator("#editor")).not.toHaveValue(/VERSION TO REVERT/);
    await expect(bob.locator("#collaboration-message")).toContainText(/restored|removed/);
    await expect(alice.locator("#collaboration-join")).toBeHidden();
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await openMoreAction(alice, "document-trash");
    await confirmDialog(alice);
    await expect(alice.locator("#document-title")).toHaveText("Select a note");
    expect(await fs.stat(path.join(library.notes, "Shared.md")).then(() => true, () => false)).toBe(false);
    await openMoreAction(alice, "trash-open");
    await alice.getByRole("button", { name: "Restore Shared.md", exact: true }).click();
    await expect(alice.locator("#trash-list")).not.toContainText("Shared.md");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toContain("research");
  } finally { await library.close(); }
});

test("favorites and recent notes follow the account without restoring legacy document tabs", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  const other = await browser.newContext();
  try {
    const [alice] = library.pages;
    await alice.locator("#more-menu > summary").click();
    await alice.locator("#workspace-favorite").click();
    await expect(alice.locator("#workspace-favorite")).toHaveText("Remove from favorites");
    const legacy = await alice.request.post(new URL("/api/workspace", library.url).href, {
      data: { action: "pin", project: "default", id: new URL(alice.url()).searchParams.get("document"), value: true },
    });
    expect(legacy.ok()).toBe(true);
    await alice.locator('[data-path="Other.md"]').click();
    await expect(alice.locator("#document-title")).toHaveText("Other.md");
    await alice.locator('[data-path="Shared.md"]').click();
    await expect(alice.locator("#document-title")).toHaveText("Shared");
    await expect(alice.locator("#document-tabs, #workspace-pin")).toHaveCount(0);
    const login = await other.request.post(new URL("/api/auth/login", library.url).href, {
      data: { username: "alice", password: "alice test password long enough" },
    });
    expect(login.ok()).toBe(true);
    const page = await other.newPage();
    await page.goto(library.url);
    await expect(page.locator("#document-title")).toHaveText("Shared");
    await expect(page.locator("#document-tabs, #workspace-pin")).toHaveCount(0);
    await page.locator("#more-menu > summary").click();
    await page.locator("#workspace-open").click();
    await expect(page.locator("#workspace-list")).toContainText("Shared");
    await expect(page.locator("#workspace-kind option")).toHaveCount(2);
    await page.locator("#workspace-kind").selectOption("recent");
    await expect(page.locator("#workspace-list")).toContainText("Other.md");
    await page.locator(".workspace-item-name").filter({ hasText: "Other.md" }).click();
    await expect(page.locator("#document-title")).toHaveText("Other.md");
    await expect(page.locator("#document-tabs")).toHaveCount(0);
  } finally { await other.close(); await library.close(); }
});
test("a timed-out workspace refresh releases coalescing so cached data stays usable and the next refresh can succeed", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true });
  let release;
  try {
    const [page] = library.pages;
    await page.locator("#more-menu > summary").click();
    await page.locator("#workspace-favorite").click();
    await expect(page.locator("#workspace-favorite")).toHaveText("Remove from favorites");
    await page.clock.install();
    let started;
    const requested = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let reads = 0;
    await page.route("**/api/workspace", async route => {
      if (route.request().method() !== "GET") return route.continue();
      if (++reads !== 1) return route.continue();
      started();
      await held;
      await route.fulfill({ status: 503, json: { error: "Obsolete delayed workspace refresh." } });
    });
    await page.locator("#more-menu > summary").click();
    await page.locator("#workspace-open").click();
    await requested;
    await expect(page.locator("#workspace-list")).toContainText("Shared");
    await page.clock.fastForward(15001);
    await expect(page.locator("#document-message")).toContainText("timed out");
    await page.locator("#workspace-close").click();
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspace" && response.ok());
    await page.locator("#more-menu > summary").click();
    await page.locator("#workspace-open").click();
    await (await refreshed).finished();
    await expect(page.locator("#workspace-list")).toContainText("Shared");
    expect(reads).toBe(2);
  } finally { release?.(); await library.close(); }
});
test("retrying a conflicted recovery refreshes its baseline and clears the obsolete conflict warning", async ({ browser }) => {
  const { library, page, recovered } = await privateRecovery(browser);
  const conflict = route => route.request().method() === "PUT"
    ? route.fulfill({ status: 409, json: { error: "Recovery conflict fixture." } }) : route.continue();
  try {
    await page.route("**/api/document", conflict);
    await page.locator("#draft-recovery-apply").click();
    await confirmDialog(page);
    await expect(page.locator("#draft-recovery-error")).toContainText("copy is kept");
    await expect(page.locator("#conflict-message")).toContainText("Recovery conflict fixture");
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "conflict");
    await page.unroute("**/api/document", conflict);
    await page.locator("#draft-recovery-apply").click();
    await confirmDialog(page);
    await expect(page.locator("#draft-recovery-dialog")).toBeHidden();
    await expect(page.locator("#conflict-message")).toHaveText("");
    await expect(page.locator("#conflict-message")).toBeHidden();
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(recovered);
  } finally { await library.close(); }
});
