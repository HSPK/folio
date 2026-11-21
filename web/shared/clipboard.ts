/** Copy plain text without moving focus or changing the user's selection. */
export async function copyPlainText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Some browsers expose the API but deny writes. Try the user-initiated copy event.
  }
  let written = false;
  const copy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.setData("text/plain", text);
    written = true;
  };
  window.addEventListener("copy", copy, true);
  try {
    if (document.execCommand?.("copy") && written) return;
  } catch {
    // Clipboard policy may block both mechanisms.
  } finally {
    window.removeEventListener("copy", copy, true);
  }
  throw new Error("Clipboard unavailable.");
}
