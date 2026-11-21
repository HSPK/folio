import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import "./styles/workspace.css";
import { App, StartupError } from "./App";
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
        return <StartupError />;
      }}
    >
      <App />
    </ErrorBoundary>
  ),
  root,
);
