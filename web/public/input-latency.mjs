// Generated from frontend/diagnostics/input-latency.ts; do not edit.

// shared/lifetime.ts
var Lifetime = class {
  #controller = new AbortController();
  #cleanup = /* @__PURE__ */ new Set();
  get signal() {
    return this.#controller.signal;
  }
  defer(cleanup) {
    if (this.signal.aborted) {
      cleanup();
      return () => {
      };
    }
    this.#cleanup.add(cleanup);
    return () => {
      this.#cleanup.delete(cleanup);
    };
  }
  listen(target, type, listener, options) {
    this.signal.throwIfAborted();
    const isListener = (value) => typeof value === "function" || typeof value === "object" && value !== null && "handleEvent" in value && typeof value.handleEvent === "function";
    if (!isListener(listener)) throw new TypeError(`Invalid listener for ${type}.`);
    const configuration = typeof options === "boolean" ? { capture: options } : options;
    const signal = configuration?.signal ? AbortSignal.any([configuration.signal, this.signal]) : this.signal;
    target.addEventListener(type, listener, { ...configuration, signal });
  }
  dispose() {
    if (this.signal.aborted) return;
    this.#controller.abort();
    const errors = [];
    for (const cleanup of [...this.#cleanup].reverse()) {
      this.#cleanup.delete(cleanup);
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Some owned resources could not be released.");
  }
};

// frontend/diagnostics/input-latency.ts
var MAX_SAMPLES = 512;
var EDITORS = ".ProseMirror, #editor, .virtual-source-editor .cm-content";
function retain(list, value) {
  list.push(value);
  if (list.length > MAX_SAMPLES) list.shift();
}
function distribution(values) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  const percentile = (value) => sorted.length ? Number(sorted[Math.ceil(sorted.length * value) - 1].toFixed(2)) : null;
  return {
    count: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: sorted.length >= 100 ? percentile(0.99) : null,
    maxMs: sorted.length ? sorted[sorted.length - 1] : null
  };
}
function createInputLatencyRecorder({
  textarea,
  context_fn
}) {
  const samples = [];
  const frameGaps = [];
  const idleFrames = [];
  const longTasks = [];
  const slowEvents = [];
  const timers = /* @__PURE__ */ new Set();
  const downloads = /* @__PURE__ */ new Set();
  const supported = globalThis.PerformanceObserver?.supportedEntryTypes ?? [];
  let recording = false;
  let lifetime;
  let frame = null;
  let lastFrame = 0;
  let lastInput = 0;
  let since = performance.now();
  let awaitingModel = [];
  let awaitingFrame = [];
  const inEditor = (target) => target instanceof Element && Boolean(target.closest(EDITORS)) && !target.closest(".folio-metadata-source");
  const watch = (type, callback) => {
    if (!supported.includes(type)) return;
    const owner = lifetime;
    if (!owner) throw new Error("Input diagnostics have no active lifetime.");
    const observer = new PerformanceObserver((list) => {
      if (!owner.signal.aborted) callback(list.getEntries());
    });
    owner.defer(() => observer.disconnect());
    const configuration = { type };
    if (type === "event") configuration.durationThreshold = 16;
    observer.observe(configuration);
  };
  const tick = (now) => {
    if (!recording) return;
    if (!document.hidden && lastFrame) {
      const gap = now - lastFrame;
      retain(frameGaps, gap);
      if (now - lastInput > 250) retain(idleFrames, gap);
    }
    lastFrame = document.hidden ? 0 : now;
    if (awaitingFrame.length) {
      const batch = awaitingFrame;
      awaitingFrame = [];
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (!recording || document.hidden) return;
        const end = performance.now();
        for (const sample of batch) sample.frameOpportunityMs = end - sample.start;
      }, 0);
      timers.add(timer);
    }
    frame = requestAnimationFrame(tick);
  };
  const beforeInput = (event) => {
    if (!recording || !event.isTrusted || !inEditor(event.target)) return;
    const now = performance.now();
    const timestamp = event.timeStamp > now + 6e4 ? event.timeStamp - performance.timeOrigin : event.timeStamp;
    const start2 = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now ? timestamp : now;
    const sample = {
      start: start2,
      eventQueueMs: now - start2,
      inputType: event.inputType,
      composing: Boolean(event.isComposing),
      ...context_fn()
    };
    retain(samples, sample);
    retain(awaitingModel, sample);
    retain(awaitingFrame, sample);
    lastInput = now;
  };
  const modelInput = () => {
    if (!recording || !awaitingModel.length) return;
    const now = performance.now();
    for (const sample of awaitingModel) sample.modelMs = now - sample.start;
    awaitingModel = [];
  };
  const visibility = () => {
    lastFrame = 0;
  };
  const start = () => {
    if (recording) return;
    const owner = new Lifetime();
    lifetime = owner;
    recording = true;
    since = performance.now();
    lastFrame = 0;
    owner.defer(() => {
      recording = false;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      for (const url of downloads) URL.revokeObjectURL(url);
      downloads.clear();
      awaitingModel = [];
      awaitingFrame = [];
    });
    try {
      owner.listen(document, "beforeinput", beforeInput, true);
      owner.listen(document, "visibilitychange", visibility);
      owner.listen(textarea, "input", modelInput);
      watch("longtask", (entries) => {
        for (const entry of entries) if (entry.startTime >= since) retain(longTasks, entry.duration);
      });
      watch("event", (entries) => {
        for (const entry of entries) {
          if (entry.startTime >= since && "target" in entry && inEditor(entry.target) && "processingStart" in entry && typeof entry.processingStart === "number" && "processingEnd" in entry && typeof entry.processingEnd === "number")
            retain(slowEvents, {
              event: entry.name,
              durationMs: entry.duration,
              delayMs: entry.processingStart - entry.startTime,
              processingMs: entry.processingEnd - entry.processingStart,
              presentationMs: Math.max(0, entry.duration - (entry.processingEnd - entry.startTime))
            });
        }
      });
      frame = requestAnimationFrame(tick);
    } catch (error) {
      owner.dispose();
      throw error;
    }
  };
  const stop = () => {
    lifetime?.dispose();
    lifetime = void 0;
  };
  const reset = () => {
    since = performance.now();
    for (const list of [samples, frameGaps, idleFrames, longTasks, slowEvents]) list.length = 0;
    awaitingModel = [];
    awaitingFrame = [];
    lastFrame = 0;
  };
  const report = () => {
    const groups = /* @__PURE__ */ new Map();
    for (const sample of samples) {
      const key = `${sample.view}/${sample.collaborative ? "shared" : "solo"}/${sample.outline ? "outline-on" : "outline-off"}/${sample.composing ? "composition" : "committed"}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(sample);
    }
    return {
      recording,
      samples: samples.length,
      groups: Object.fromEntries(
        [...groups].map(([key, values]) => [
          key,
          {
            inputs: values.length,
            pendingModel: values.filter((value) => !Number.isFinite(value.modelMs)).length,
            pendingFrame: values.filter((value) => !Number.isFinite(value.frameOpportunityMs)).length,
            eventQueue: distribution(values.map((value) => value.eventQueueMs)),
            inputToModel: distribution(values.map((value) => value.modelMs)),
            inputToFrameOpportunity: distribution(values.map((value) => value.frameOpportunityMs))
          }
        ])
      ),
      frames: {
        idleInterval: distribution(idleFrames),
        gaps: distribution(frameGaps),
        over50ms: frameGaps.filter((value) => value > 50).length
      },
      browser: {
        eventTimingSupported: supported.includes("event"),
        longTaskSupported: supported.includes("longtask"),
        longTasks: distribution(longTasks),
        slowEventsAtLeast16ms: [...slowEvents]
      },
      measurements: samples.map(({ start: start2, ...sample }) => ({ ...sample })),
      note: "Last 512 trusted beforeinput events, not hardware key latency. Frame opportunity is estimated; Event Timing is thresholded and is not an INP score. P99 needs at least 100 samples per group. No text, key values or document URLs are collected."
    };
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report(), null, 2)], { type: "application/json" }));
    downloads.add(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = "folio-input-latency.json";
    link.click();
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      downloads.delete(url);
      URL.revokeObjectURL(url);
    }, 1e3);
    timers.add(timer);
  };
  start();
  return Object.freeze({ start, stop, reset, report, download });
}
export {
  createInputLatencyRecorder
};
