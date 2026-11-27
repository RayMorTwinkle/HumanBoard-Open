import { createRoot } from "react-dom/client";
import { Studio } from "../../../packages/canvas-ui/src/studio/Studio";
import { applyTheme } from "../../../packages/canvas-ui/src/theme";
applyTheme();
createRoot(document.getElementById("root")!).render(
  <Studio
    run={async (input) => {
      const r = await fetch("/api/studio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message);
      return data;
    }}
  />,
);
