import { Lifetime } from "../../shared/lifetime";

const MAX_SAMPLES = 512;
const EDITORS = ".ProseMirror, #editor, .virtual-source-editor .cm-content";

interface InputContext {
  view: string;
  collaborative: boolean;
  saving: boolean;
  outline: boolean;
  documentBytes: number;
}

interface InputSample extends InputContext {
  start: number;
  eventQueueMs: number;
  inputType: string;
  composing: boolean;
  modelMs?: number;
  frameOpportunityMs?: number;
}

interface SlowEvent {
  event: string;
  durationMs: number;
  delayMs: number;
  processingMs: number;
  presentationMs: number;
}

function retain<T>(list: T[], value: T) {
  list.push(value);
  if (list.length > MAX_SAMPLES) list.shift();
}

function distribution(values: readonly (number | undefined)[]) {
  const sorted = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  const percentile = (value: number) =>
    sorted.length ? Number(sorted[Math.ceil(sorted.length * value) - 1].toFixed(2)) : null;
  return {
    count: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: sorted.length >= 100 ? percentile(0.99) : null,
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

export function createInputLatencyRecorder({
  textarea,
  context_fn,
}: {
  textarea: HTMLTextAreaElement;
  context_fn: () => InputContext;
}) {
  const samples: InputSample[] = [];
  const frameGaps: number[] = [];
  const idleFrames: number[] = [];
  const longTasks: number[] = [];
  const slowEvents: SlowEvent[] = [];
  const timers = new Set<number>();
  const downloads = new Set<string>();
  const supported = globalThis.PerformanceObserver?.supportedEntryTypes ?? [];
  let recording = false;
  let lifetime: Lifetime | undefined;
  let frame: number | null = null;
  let lastFrame = 0;
  let lastInput = 0;
  let since = performance.now();
  let awaitingModel: InputSample[] = [];
  let awaitingFrame: InputSample[] = [];

  const inEditor = (target: unknown) =>
    target instanceof Element && Boolean(target.closest(EDITORS)) && !target.closest(".folio-metadata-source");
  const watch = (type: string, callback: (entries: PerformanceEntry[]) => void) => {
    if (!supported.includes(type)) return;
    const owner = lifetime;
    if (!owner) throw new Error("Input diagnostics have no active lifetime.");
    const observer = new PerformanceObserver((list) => {
      if (!owner.signal.aborted) callback(list.getEntries());
    });
    owner.defer(() => observer.disconnect());
    const configuration: PerformanceObserverInit & { durationThreshold?: number } = { type };
    if (type === "event") configuration.durationThreshold = 16;
    observer.observe(configuration);
  };
  const tick = (now: number) => {
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
      // This is a frame opportunity estimate, not a hardware presentation timestamp.
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
  const beforeInput = (event: InputEvent) => {
    if (!recording || !event.isTrusted || !inEditor(event.target)) return;
    const now = performance.now();
    const timestamp = event.timeStamp > now + 60000 ? event.timeStamp - performance.timeOrigin : event.timeStamp;
    const start = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now ? timestamp : now;
    const sample: InputSample = {
      start,
      eventQueueMs: now - start,
      inputType: event.inputType,
      composing: Boolean(event.isComposing),
      ...context_fn(),
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
          if (
            entry.startTime >= since &&
            "target" in entry &&
            inEditor(entry.target) &&
            "processingStart" in entry &&
            typeof entry.processingStart === "number" &&
            "processingEnd" in entry &&
            typeof entry.processingEnd === "number"
          )
            retain(slowEvents, {
              event: entry.name,
              durationMs: entry.duration,
              delayMs: entry.processingStart - entry.startTime,
              processingMs: entry.processingEnd - entry.processingStart,
              presentationMs: Math.max(0, entry.duration - (entry.processingEnd - entry.startTime)),
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
    lifetime = undefined;
  };
  const reset = () => {
    since = performance.now();
    for (const list of [samples, frameGaps, idleFrames, longTasks, slowEvents]) list.length = 0;
    awaitingModel = [];
    awaitingFrame = [];
    lastFrame = 0;
  };
  const report = () => {
    const groups = new Map<string, InputSample[]>();
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
            inputToFrameOpportunity: distribution(values.map((value) => value.frameOpportunityMs)),
          },
        ]),
      ),
      frames: {
        idleInterval: distribution(idleFrames),
        gaps: distribution(frameGaps),
        over50ms: frameGaps.filter((value) => value > 50).length,
      },
      browser: {
        eventTimingSupported: supported.includes("event"),
        longTaskSupported: supported.includes("longtask"),
        longTasks: distribution(longTasks),
        slowEventsAtLeast16ms: [...slowEvents],
      },
      measurements: samples.map(({ start, ...sample }) => ({ ...sample })),
      note: "Last 512 trusted beforeinput events, not hardware key latency. Frame opportunity is estimated; Event Timing is thresholded and is not an INP score. P99 needs at least 100 samples per group. No text, key values or document URLs are collected.",
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
    }, 1000);
    timers.add(timer);
  };
  start();
  return Object.freeze({ start, stop, reset, report, download });
}
