import { test, expect, fs, path, buildRoot, chooseView, userDocumentUrl, confirmDialog } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";
import { pasteImage } from "./project-cases.mjs";

test("share first paint, sidebar exposure and readable document", async ({ browser, browserName }) => {
  test.skip(!process.env.FOLIO_BENCH_SHARE || browserName !== "chromium", "Opt-in share navigation benchmark.");
  const library = await collaborativeLibrary(browser, { participants: 1 });
  try {
    const [owner] = library.pages;
    await owner.locator("#more-menu > button").click();
    await owner.locator("#share-page").click();
    await owner.locator("#sharing-level").selectOption("publicRead");
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-public-url")).toHaveValue(/\/s\/[A-Za-z0-9_-]{8}$/);
    const url = await owner.locator("#sharing-public-url").inputValue();
    const samples = {};
    for (let i = 0; i < 5; i++) {
      const guest = await browser.newContext();
      try {
        await guest.addInitScript(() => {
          window.shareFrames = { sidebar: 0 };
          requestAnimationFrame(function sample() {
            const sidebar = document.getElementById("sidebar");
            if (sidebar?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && sidebar.getBoundingClientRect().right > 0) window.shareFrames.sidebar++;
            const body = document.querySelector('.ProseMirror[contenteditable="false"]');
            if (body?.getClientRects().length && body.textContent.includes("Alpha")) window.shareFrames.body = performance.now();
            else requestAnimationFrame(sample);
          });
        });
        const page = await guest.newPage();
        const cdp = await guest.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 2_000_000, uploadThroughput: 1_000_000 });
        for (const step of ["cold", "reload"]) {
          if (step === "cold") await page.goto(url); else await page.reload();
          await page.waitForFunction(() => window.shareFrames.body);
          const data = await page.evaluate(() => {
            const entries = performance.getEntriesByType("resource");
            const request = name => entries.find(e => new URL(e.name).pathname === "/api/public/" + name).startTime;
            return { ...window.shareFrames, session: request("session"), note: request("document"),
              assets: entries.filter(e => /\.(css|mjs)$/.test(new URL(e.name).pathname)).reduce((n,e) => n + e.encodedBodySize, 0) };
          });
          for (const [key,value] of Object.entries(data)) (samples[`${step}_${key}`] ??= []).push(Math.round(value));
        }
      } finally { await guest.close(); }
    }
    console.log("SHARE", process.env.FOLIO_BENCH_SHARE, Object.fromEntries(Object.entries(samples).map(([k,v]) => [k,v.sort((a,b) => a-b)[2]])));
  } finally { await library.close(); }
});

async function tryReadOnlySocketWrite(page) {
  return page.evaluate(async () => {
    const share = location.pathname.slice(3);
    const session = await (await fetch("/api/public/session", {
      method: "POST", headers: { "X-Folio-Share": share },
    })).json();
    const response = await fetch("/api/public/collaboration/join", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Folio-Share": share },
      body: JSON.stringify({ document: session.id }),
    });
    return { status: response.status, ...(await response.json()) };
  });
}

test("public document links default to read-only, allow opt-in anonymous collaboration and revoke live guests", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  const guest = await browser.newContext();
  const secondGuest = await browser.newContext();
  try {
    const [owner] = library.pages;
    await owner.locator("#more-menu > button").click();
    await owner.locator("#share-page").click();
    await expect(owner.locator("#sharing-level")).toHaveValue("inherit");
    await owner.locator("#sharing-level").selectOption("publicRead");
    await expect(owner.locator("#sharing-public-edit")).not.toBeChecked();
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-public-url")).toHaveValue(/\/s\/[A-Za-z0-9_-]{8}$/);
    const url = await owner.locator("#sharing-public-url").inputValue();
    const page = await guest.newPage();
    const errors = [];
    const workspaceRequests = [];
    const bootRequests = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (/^\/api\/public\/(?:session|document)$/.test(path)) bootRequests.push(path);
      if (/^\/api\/(?:public\/)?(?:tree|workspace|auth\/status|preferences|projects|appearance)\b/.test(path))
        workspaceRequests.push(request.method());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#collaboration-join")).toBeHidden();
    await expect(page.locator(".ProseMirror")).toContainText("Alpha");
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    expect(bootRequests).toEqual(["/api/public/session", "/api/public/document"]);
    expect(await page.locator("#sidebar").evaluate(node => getComputedStyle(node).display)).toBe("none");
    expect(await page.evaluate(() => performance.getEntriesByType("resource").some(e => new URL(e.name).pathname === "/code-syntax.mjs"))).toBe(false);
    await expect(page.locator("#dirty-indicator")).toHaveText("Read only");
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    await page.locator("#more-menu > button").click();
    await expect(page.locator("#more-workspace-actions")).toBeHidden();
    await expect(page.locator("#more-recovery")).toBeHidden();
    await expect(page.locator("#document-tags-open")).toBeHidden();
    await page.locator("#reader-options > summary").click();
    await page.locator("#reader-theme").selectOption("dark");
    await page.locator("#reader-size").selectOption("20");
    await page.reload();
    await expect(page.locator(".ProseMirror")).toContainText("Alpha");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.locator("html").evaluate(node => node.style.getPropertyValue("--document-size"))).toBe("20px");
    await expect(page.getByText(/Unavailable in public documents|Refresh failed:/)).toHaveCount(0);
    expect(workspaceRequests).toEqual([]);
    for (const selector of ["#sidebar", "#sidebar-toggle", "#settings-open", "#projects-open", "#share-page"]) {
      await expect(page.locator(selector)).toBeHidden();
    }
    await expect(page.locator(".collaboration-avatar")).toHaveCount(0);
    expect((await guest.cookies()).filter((cookie) => cookie.name.startsWith("folio_user_session"))).toHaveLength(0);
    expect((await guest.request.get(new URL("/api/projects", url).href)).status()).toBe(401);
    expect((await tryReadOnlySocketWrite(page)).status).toBe(403);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).not.toContain("Rejected anonymous change");
    await chooseView(page, "editor");
    await expect(page.locator("#editor")).toHaveJSProperty("readOnly", true);
    await owner.locator("#sharing-public-edit").check();
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-public-url")).toHaveValue(url);
    await expect(page.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#editor")).toHaveJSProperty("readOnly", false);
    await page.locator("#editor").focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("\nAnonymous edit 中文\n");
    await expect(owner.locator(".ProseMirror")).toContainText("Anonymous edit 中文");
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const other = await secondGuest.newPage();
    await other.goto(url);
    await expect(other.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    await other.locator("#more-menu > button").click();
    await expect(other.getByRole("img", { name: /^Guest [a-f0-9]+ \(you\)$/ })).toBeVisible();
    await other.keyboard.press("Escape");
    await expect(owner.locator(".collaboration-avatar")).toHaveCount(4);
    const names = await owner.locator(".collaboration-avatar").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    expect(new Set(names.filter((name) => name.startsWith("Guest "))).size).toBe(2);
    await pasteImage(page, "#editor");
    await expect(page.locator("#editor")).toHaveValue(/!\[Image\]\(assets\/images\/image-/);
    await expect(other.locator(".folio-inline-image img")).toHaveCount(1);
    await expect.poll(() => other.locator(".folio-inline-image img").evaluate((image) => image.naturalWidth)).toBe(16);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    await page.screenshot({ path: path.join(buildRoot, "public-document-sharing.png") });
    await owner.locator("#sharing-public-edit").uncheck();
    await owner.locator("#sharing-save").click();
    await expect(page.locator("#editor")).toHaveJSProperty("readOnly", true);
    await expect(other.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    await owner.locator("#sharing-reset-link").click();
    await confirmDialog(owner);
    await expect(owner.locator("#sharing-public-url")).not.toHaveValue(url);
    const replacement = await owner.locator("#sharing-public-url").inputValue();
    await expect(page.locator("#collaboration-message")).toContainText("revoked");
    await page.reload();
    await expect(page.locator("#connection-message")).toContainText("revoked");
    await expect(page.locator("#auth-screen")).toBeHidden();
    await page.goto(replacement);
    await expect(page.locator(".ProseMirror")).toContainText("Anonymous edit 中文");
    await expect(page.locator("#dirty-indicator")).toHaveText("Read only");
    await owner.locator("#sharing-level").selectOption("private");
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-dialog")).toBeHidden();
    await expect(page.locator("#collaboration-message")).toContainText("revoked");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toContain("Anonymous edit 中文");
    expect(errors).toEqual([]);
  } finally {
    await guest.close();
    await secondGuest.close();
    await library.close();
  }
});

test("a document can be private or read-only inside an editable shared project", async ({ browser }) => {
  const library = await collaborativeLibrary(browser);
  try {
    const [owner, member] = library.pages;
    await owner.locator("#more-menu > button").click();
    await owner.locator("#share-page").click();
    await owner.locator("#sharing-level").selectOption("read");
    await owner.locator("#sharing-save").click();
    await expect(member.locator("#dirty-indicator")).toHaveText("Read only");
    await member.reload();
    await expect(member.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    await owner.locator("#more-menu > button").click();
    await owner.locator("#share-page").click();
    await owner.locator("#sharing-level").selectOption("private");
    await owner.locator("#sharing-save").click();
    await expect(member.locator("#collaboration-message")).toContainText(/private|permission/i);
    await member.goto(await userDocumentUrl(member.context(), library.url, "Other.md"));
    await expect(member.locator(".ProseMirror")).toContainText("Other");
    await expect(member.locator('[data-path="Shared.md"]')).toHaveCount(0);
    await expect(member.locator("#git-tab")).toHaveCount(0);
    await owner.locator("#more-menu > button").click();
    await owner.locator("#share-page").click();
    await owner.locator("#sharing-level").selectOption("inherit");
    await owner.locator("#sharing-save").click();
    await expect(owner.locator("#sharing-dialog")).toBeHidden();
    await member.goto(await userDocumentUrl(member.context(), library.url, "Shared.md"));
    await expect(member.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
    await expect(member.locator("#git-tab")).toHaveCount(0);
  } finally { await library.close(); }
});
