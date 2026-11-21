import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { ApplicationDialogs } from "./components/ApplicationDialogs";
import { FileDialogs } from "./components/FileDialogs";
import { ProjectDialog } from "./components/ProjectDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { WorkspaceDialogs } from "./components/WorkspaceDialogs";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { startApplication } from "./runtime/application";
import styles from "./styles/shell.module.css";

export function StartupError() {
  return (
    <main role="alert" class="startup-screen">
      <h1>Folio could not start</h1>
      <button type="button" onClick={() => location.reload()}>
        Reload
      </button>
    </main>
  );
}

/** Mount stable application hosts before starting document and account services. */
export function App() {
  const [failed, setFailed] = createSignal(false);
  let disposed = false;
  let stop: (() => void) | undefined;
  onMount(() =>
    queueMicrotask(() => {
      if (disposed) return;
      try {
        stop = startApplication();
      } catch (error) {
        console.error("Folio could not initialize its application services.", error);
        setFailed(true);
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
        when={failed()}
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
        <StartupError />
      </Show>
    </div>
  );
}
