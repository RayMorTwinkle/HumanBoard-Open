import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { applyTheme } from "./theme";
import type { Run } from "./studio/useStudio";
import { HumanBoardClient } from "./client/HumanBoardClient";

applyTheme();
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
const renderer = createRoot(root);

async function mount() {
  const params = new URLSearchParams(location.search);
  if (params.get("view") === "studio") {
    const { Studio } = await import("./studio/Studio");
    const project = params.get("project") ?? undefined;
    const space = params.get("space") ?? undefined;
    const client = new HumanBoardClient({
      project,
      space,
      sessionId: crypto.randomUUID(),
    });
    const revision: Run = (input) =>
      client.command(["revision"], { stdin: JSON.stringify(input) });
    renderer.render(
      <StrictMode>
        <Studio
          run={revision}
          scope={JSON.stringify([project, space])}
          back="./"
        />
      </StrictMode>,
    );
  } else {
    const { App } = await import("./App");
    renderer.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}
void mount();
