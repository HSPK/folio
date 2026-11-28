{
  let retried = false;
  window.addEventListener("error", event => {
    const source = event.target;
    if (!(source instanceof HTMLScriptElement) || source.type !== "module" || !source.src ||
        new URL(source.src).pathname !== "/app.mjs") return;
    const boot = document.getElementById("folio-boot");
    if (!boot) return;
    if (!retried) {
      retried = true;
      setTimeout(() => {
        if (!boot.isConnected) return;
        const retry = document.createElement("script");
        const url = new URL(source.src);
        url.searchParams.set("folio-retry", "1");
        retry.type = "module";
        retry.src = url.href;
        source.replaceWith(retry);
      }, 100);
      return;
    }
    const content = document.createElement("div");
    const heading = document.createElement("h1");
    const retry = document.createElement("button");
    heading.textContent = "Folio couldn't open";
    retry.type = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => location.reload());
    content.append(heading, retry);
    boot.replaceChildren(content);
  }, true);
}
