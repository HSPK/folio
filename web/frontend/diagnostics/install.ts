import type { Lifetime } from "../../shared/lifetime";
import type { createInputLatencyRecorder } from "./input-latency";

export function installInputDiagnostics(
  lifetime: Lifetime,
  options: Parameters<typeof createInputLatencyRecorder>[0],
  onError: (error: Error) => void,
) {
  void import("@folio/input-latency")
    .then(({ createInputLatencyRecorder }) => {
      if (lifetime.signal.aborted) return;
      const recorder = createInputLatencyRecorder(options);
      window.folioPerformance = recorder;
      lifetime.defer(() => {
        recorder.stop();
        if (window.folioPerformance === recorder) delete window.folioPerformance;
      });
    })
    .catch((error) => {
      if (lifetime.signal.aborted) console.warn("Input diagnostics could not finish before disposal.", error);
      else onError(error instanceof Error ? error : new Error(String(error)));
    });
}
