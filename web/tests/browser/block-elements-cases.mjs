import {
  test, expect, fs, path, root, openFixture, primaryModifier, openBlockTools, hoverBlockTools, userDocumentUrl,
} from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

const cases = [
  { name: "bullet list", body: "- First **bold**\n- Second [Guide](https://example.com)\n",
    selector: ".ProseMirror > ul > li", target: ":scope > div > p", label: "List item" },
  { name: "ordered list", body: "7. First `inline`\n8. Second *emphasis*\n",
    selector: ".ProseMirror > ol > li", target: ":scope > div > p", label: "List item" },
  { name: "task list", body: "- [x] Done **kept**\n- [ ] Pending [Guide](https://example.com)\n",
    selector: ".ProseMirror > ul > li", target: ":scope > div > p", label: "List item" },
  { name: "nested task", body: "- Parent **kept**\n  - [x] Child [Guide](https://example.com)\n  - [ ] Sibling\n- Other\n",
    selector: ".ProseMirror > ul > li:first-child > div > ul > li", target: ":scope > div > p", label: "List item" },
  { name: "code", body: '```typescript\n// https://example.com stays code\nconst value = "[[literal]]";\n```\n',
    selector: ".ProseMirror > .folio-code-block", label: "Code block" },
  { name: "links and inline marks", body: '**Bold** *emphasis* ~~removed~~ `code` [Guide](https://example.com/paper "Paper") '
      + '[Second](Second.md#section) [[Second|Alias]] $x$.\n',
    selector: ".ProseMirror > p", text: "Bold", label: "Text" },
  { name: "reference link", body: '[Paper][paper] and **reference**.\n\n[paper]: https://example.com/paper "Paper"\n',
    selector: ".ProseMirror > p", text: "Paper", label: "Text" },
  { name: "citation quote", body: '> Citation [1](https://example.com/paper "Paper").\n>\n> > Nested **quoted**.\n>\n> - [x] Reviewed\n>\n> Inline $x$.\n',
    selector: ".ProseMirror > blockquote", target: ":scope > p:first-child", label: "Quote" },
  { name: "heading", body: "### Heading **kept** with [source](https://example.com)\n",
    selector: ".ProseMirror > h3", label: "Heading" },
  { name: "divider", body: "---\n", selector: ".ProseMirror > hr", label: "Divider" },
  { name: "display formula", body: "$$\nx^2 + y^2 = z^2\n$$\n",
    selector: ".ProseMirror > .folio-math-block", label: "Math block" },
];

const snapshot = block => block.evaluate(node => ({
  tag: node.tagName,
  text: node.textContent,
  language: node.dataset.language ?? null,
  links: [...node.querySelectorAll("a")].map(link => ({
    text: link.textContent, target: link.dataset.noteUrl ?? link.getAttribute("href"),
  })),
  marks: [...node.querySelectorAll("strong, em, del, code")].map(mark => [mark.tagName, mark.textContent]),
  tasks: [...node.querySelectorAll('input[type="checkbox"]')].map(input => input.checked),
  math: [...node.querySelectorAll("[data-type^=math_]")].map(math => [math.dataset.type, math.dataset.value]),
}));

for (const item of cases) {
  test(`block element ${item.name} preserves structure, marks, undo and saved content`, async ({ page }) => {
    const source = `Before.\n\n${item.body}\nAfter.\n`;
    const name = `Block-element-${item.name.replaceAll(" ", "-")}.md`;
    await openFixture(page, name, source);
    let blocks = page.locator(item.selector);
    if (item.text) blocks = blocks.filter({ hasText: item.text });
    const first = blocks.first();
    const target = () => item.target ? first.locator(item.target).first() : first;
    const count = await blocks.count();
    const original = await snapshot(first);
    await first.scrollIntoViewIfNeeded();
    const bounds = await first.boundingBox();
    let menu = await openBlockTools(page, target(), item.label);
    expect(await first.boundingBox()).toEqual(bounds);
    await expect(menu.getByText(/Copy .*as/)).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Duplicate block", exact: true }).click();
    await expect(blocks).toHaveCount(count + 1);
    expect(await snapshot(blocks.nth(1))).toEqual(original);
    menu = await openBlockTools(page, item.target ? blocks.nth(1).locator(item.target).first() : blocks.nth(1), item.label);
    await menu.getByRole("menuitem", { name: "Delete block", exact: true }).click();
    await expect(blocks).toHaveCount(count);
    await page.keyboard.press(`${primaryModifier}+z`);
    await expect(blocks).toHaveCount(count + 1);
    await page.keyboard.press(`${primaryModifier}+z`);
    await expect(blocks).toHaveCount(count);
    await expect(page.locator("#editor")).toHaveValue(source);
    menu = await openBlockTools(page, target(), item.label);
    await menu.getByRole("menuitem", { name: "Duplicate block", exact: true }).click();
    await page.keyboard.press(`${primaryModifier}+s`);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const saved = await fs.readFile(path.join(root, name), "utf8");
    expect(saved).toContain("Before.");
    expect(saved).toContain("After.");
    expect(saved).not.toContain("folio-block");
    if (item.body.includes('"Paper"')) expect(saved).toContain('"Paper"');
    await page.reload();
    await expect(blocks).toHaveCount(count + 1);
    expect(await snapshot(blocks.first())).toEqual(original);
    expect(await snapshot(blocks.nth(1))).toEqual(original);
    if (item.name === "ordered list") await expect(page.locator(".ProseMirror > ol")).toHaveAttribute("start", "7");
    if (item.name === "heading") {
      const ids = await blocks.evaluateAll(nodes => nodes.map(node => node.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
}

for (const item of [
  ...cases,
  { name: "image", body: '<img src="images/pixel.png" alt="Figure" style="width:60%;height:80px;display:block;margin-left:0;margin-right:auto">\n',
    selector: ".ProseMirror > .folio-block-image", label: "Image block" },
  { name: "image row", body: '<img src="images/pixel.png" alt="One" style="width:50%;height:80px;display:inline">'
      + '<img src="images/pixel.png" alt="Two" style="width:50%;height:80px;display:inline">\n',
    selector: ".ProseMirror > .folio-image-row", label: "Text" },
  { name: "table", body: "| Name | State |\n| --- | --- |\n| A | Draft |\n",
    selector: ".ProseMirror > .folio-table-wrapper", label: "Table" },
  { name: "nested code", body: "> Quote start.\n>\n> ```rust\n> kept();\n> ```\n>\n> Quote end.\n",
    selector: ".ProseMirror > blockquote > .folio-code-block", label: "Code block" },
]) {
  test(`block plus below ${item.name} inserts at the right level, supports undo and persists typed text`, async ({ page }) => {
    const source = `Before.\n\n${item.body}\nAfter.\n`;
    const name = `Block-plus-${item.name.replaceAll(" ", "-")}.md`;
    await openFixture(page, name, source);
    let blocks = page.locator(item.selector);
    if (item.text) blocks = blocks.filter({ hasText: item.text });
    const first = blocks.first();
    const original = await snapshot(first);
    const target = () => item.target ? first.locator(item.target).first() : first;
    await hoverBlockTools(page, target(), item.label);
    await page.getByRole("button", { name: "Add block below", exact: true }).click();
    await expect(page.locator(".ProseMirror")).toBeFocused();
    await page.keyboard.press(`${primaryModifier}+z`);
    await expect(page.locator("#editor")).toHaveValue(source);
    await hoverBlockTools(page, target(), item.label);
    const previous = await first.elementHandle();
    await page.getByRole("button", { name: "Add block below", exact: true }).click();
    await page.keyboard.insertText("Added block.");
    const inserted = page.locator(".ProseMirror p").filter({ hasText: /^Added block\.$/ });
    await expect(inserted).toHaveCount(1);
    expect(await inserted.evaluate((paragraph, { previous, list }) => {
      const block = list ? paragraph.closest("li") : paragraph;
      return block.previousElementSibling === previous;
    }, { previous, list: item.label === "List item" })).toBe(true);
    if (item.name.includes("task")) {
      await expect(inserted.locator("..").locator("..").locator(":scope > .folio-task-checkbox")).not.toBeChecked();
      await expect(first.locator(":scope > .folio-task-checkbox")).toBeChecked();
    }
    expect(await snapshot(first)).toEqual(original);
    await page.keyboard.press(`${primaryModifier}+s`);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    const saved = await fs.readFile(path.join(root, name), "utf8");
    expect(saved).toContain("Added block.");
    expect(saved).not.toContain("folio-block");
    await page.reload();
    await expect(inserted).toHaveCount(1);
    expect(await snapshot(first)).toEqual(original);
  });
}

test("task block grips leave checkboxes reachable and checkbox edits undo and persist independently", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const source = "- [x] Done **kept**\n- [ ] Pending\n  - [x] Nested\n\nTail.\n";
  await openFixture(page, "Block-task-pointer.md", source);
  const editor = page.locator(".ProseMirror");
  const item = editor.locator(":scope > ul > li").first();
  await item.locator(":scope > div > p").hover();
  const handle = await page.locator(".folio-block-grip").boundingBox();
  const checkbox = item.locator(":scope > .folio-task-checkbox");
  const box = await checkbox.boundingBox();
  expect(handle.x + handle.width).toBeLessThanOrEqual(box.x - 1);
  if (browserName !== "webkit") await page.screenshot({ path: test.info().outputPath("task-grip-narrow.png") });
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
  await expect(editor.locator(".folio-task-checkbox").last()).toBeChecked();
  await page.locator(".ProseMirror").focus();
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(checkbox).toBeChecked();
  await expect(page.locator("#editor")).toHaveValue(source);
  await checkbox.uncheck();
  await page.keyboard.press(`${primaryModifier}+s`);
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await page.reload();
  await expect(editor.locator(".folio-task-checkbox").first()).not.toBeChecked();
  await expect(editor.locator(".folio-task-checkbox").last()).toBeChecked();
});

test("deleting the last list item removes its nested blocks but leaves a writable note and one-step undo", async ({ page }) => {
  const source = "- [x] Only **task**\n\n  ```rust\n  kept();\n  ```\n\n  - [ ] Nested [source](https://example.com)\n";
  await openFixture(page, "Block-last-list.md", source);
  const menu = await openBlockTools(page, page.locator(".ProseMirror > ul > li > div > p").first(), "List item");
  await menu.getByRole("menuitem", { name: "Delete block", exact: true }).click();
  await expect(page.locator(".ProseMirror li")).toHaveCount(0);
  await expect(page.locator(".ProseMirror > p")).toHaveCount(1);
  await expect(page.locator("#editor")).toHaveValue(/^\s*$/);
  await page.keyboard.press(`${primaryModifier}+z`);
  await expect(page.locator("#editor")).toHaveValue(source);
  await expect(page.locator(".folio-task-checkbox").first()).toBeChecked();
  await expect(page.locator(".folio-code-block code")).toHaveText("kept();");
  await expect(page.locator(".ProseMirror a")).toHaveAttribute("href", /^https:\/\/example.com\/?$/);
});

test("read-only block elements disable task changes and all block mutations without changing source", async ({ browser }) => {
  const content = "# Heading\n\n- [x] Done\n- [ ] Pending\n\n```rust\nkept();\n```\n\n"
    + '[Guide](https://example.com "Paper")\n\n> Citation **kept**.\n\n$$x^2$$\n\n---\n';
  const library = await collaborativeLibrary(browser, { content, participants: 1, sharing: "read" });
  const context = await browser.newContext();
  try {
    const login = await context.request.post(new URL("/api/auth/login", library.url).href, {
      data: { username: "bob", password: "bob test password long enough" },
    });
    expect(login.ok()).toBe(true);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(await userDocumentUrl(context, library.url, "Shared.md"));
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    await expect(page.locator(".folio-live-caret")).toBeHidden();
    await expect(page.locator(".folio-code-language")).toHaveText("Rust");
    for (const checkbox of await page.locator(".folio-task-checkbox").all()) await expect(checkbox).toBeDisabled();
    for (const [selector, label] of [
      [".ProseMirror h1", "Heading"], [".ProseMirror > ul > li > div > p", "List item"],
      [".folio-code-block", "Code block"], [".ProseMirror > p", "Text"], [".ProseMirror > blockquote > p", "Quote"],
      [".folio-math-block", "Math block"], [".ProseMirror > hr", "Divider"],
    ]) {
      const menu = await openBlockTools(page, page.locator(selector).first(), label);
      await expect(page.getByRole("button", { name: "Add block below", exact: true })).toHaveCount(0);
      for (const button of await menu.getByRole("menuitem").all()) await expect(button).toBeDisabled();
      await expect(menu).toBeFocused();
      await expect(menu.getByText(/Copy .*as/)).toHaveCount(0);
      await menu.press("Escape");
    }
    await expect(page.locator("#editor")).toHaveValue(content);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(content);
    expect(errors).toEqual([]);
  } finally { await context.close(); await library.close(); }
});
