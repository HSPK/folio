{
  const url = new URL(location.href);
  const share = url.pathname === "/share" ? url.searchParams.get("share") : url.pathname.slice(3);
  if (share && /^(?:[A-Za-z0-9_-]{8}|[A-Za-z0-9_-]{21}[AQgw]|[a-fA-F0-9]{64})$/.test(share)) {
    const reads = new Map();
    const started = new Set();
    const boot = window.folioShareStart = { reads, started, at: performance.now() };
    const read = (path, token, method) => {
      const key = JSON.stringify([method, token, path]);
      if (window.folioShareStart !== boot || started.has(key)) return;
      started.add(key);
      const result = fetch(path, { method, headers: { Accept: "application/json", "X-Folio-Share": token },
        credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
      result.catch(() => {});
      reads.set(key, result);
      return result;
    };
    read("/api/public/session", share, "POST").then(async response => {
      if (!response.ok) return;
      const session = await response.clone().json();
      if (!session.passwordRequired && !session.file && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(session.id))
        read("/api/public/document?id=" + session.id, session.code || share, "GET");
    }).catch(() => {});
  }
}
