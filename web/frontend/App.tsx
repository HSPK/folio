import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { ApplicationDialogs } from "./components/ApplicationDialogs";
import { FileDialogs } from "./components/FileDialogs";
import { ProjectDialog } from "./components/ProjectDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { WorkspaceDialogs } from "./components/WorkspaceDialogs";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { startApplication } from "./runtime/application";
import styles from "./styles/shell.module.css";

/** Mount stable application hosts before starting document and account services. */
export function App() {
  const [failure, setFailure] = createSignal<string>();
  let disposed = false;
  let stop: (() => void) | undefined;
  onMount(() =>
    queueMicrotask(() => {
      if (disposed) return;
      try {
        stop = startApplication();
      } catch (error) {
        console.error("Folio could not initialize its application services.", error);
        setFailure(error instanceof Error ? error.message : String(error));
      }
    }),
  );
  onCleanup(() => {
    disposed = true;
    stop?.();
  });

  return (
    <div class={styles.root} data-framework="solid">
      <Show
        when={failure()}
        fallback={
          <>
            <WorkspaceShell />
            <FileDialogs />
            <ApplicationDialogs />
            <SettingsDialog />
            <ProjectDialog />
            <WorkspaceDialogs />
          </>
        }
      >
        {(message) => (
          <section class={styles.failure} role="alert">
            <h1>Folio could not start</h1>
            <p>{message()}</p>
            <button type="button" onClick={() => location.reload()}>
              Reload
            </button>
          </section>
        )}
      </Show>
    </div>
  );
}
