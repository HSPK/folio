import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import "./styles/workspace.css";
import { App } from "./App";
import "./styles/app.css";
import "./styles/controls.css";
import "./styles/navigation.css";
import "./styles/overlays.css";
import "./styles/solid.css";

const root = document.getElementById("folio-root");
if (!root) throw new Error("Folio's application root is missing.");
root.replaceChildren();

render(
  () => (
    <ErrorBoundary
      fallback={(error) => {
        console.error("Folio could not render its interface.", error);
        return (
          <main role="alert" class="startup-failure">
            <h1>Folio could not start</h1>
            <p>{error instanceof Error ? error.message : String(error)}</p>
            <button type="button" onClick={() => location.reload()}>
              Reload
            </button>
          </main>
        );
      }}
    >
      <App />
    </ErrorBoundary>
  ),
  root,
);
