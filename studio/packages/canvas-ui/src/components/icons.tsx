import type { ReactNode, SVGProps } from "react";

import type { Tool } from "../client/types";

type IconProps = SVGProps<SVGSVGElement>;

function IconFrame({
  children,
  ...props
}: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ToolIcon({
  tool,
  ...props
}: IconProps & { readonly tool: Tool }) {
  if (tool === "node")
    return (
      <IconFrame {...props}>
        <rect x="4" y="5" width="16" height="14" rx="3" />
        <path d="M8 10h8M8 14h5" />
      </IconFrame>
    );
  if (tool === "edge")
    return (
      <IconFrame {...props}>
        <circle cx="5" cy="6" r="2" />
        <circle cx="19" cy="18" r="2" />
        <path d="M7 6h5v12h5" />
      </IconFrame>
    );
  if (tool === "pen") {
    return (
      <IconFrame {...props}>
        <path d="M4 20l4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20z" />
        <path d="M14.5 6.5l3 3" />
      </IconFrame>
    );
  }
  if (tool === "highlighter") {
    return (
      <IconFrame {...props}>
        <path d="M5 17l3.5 3H20" />
        <path d="M8.2 16.8L5.7 14.3 14.8 5.2l4 4z" />
        <path d="M13.4 6.6l4 4" />
      </IconFrame>
    );
  }
  if (tool === "eraser") {
    return (
      <IconFrame {...props}>
        <path d="M4.8 14.2l7.6-8a2 2 0 0 1 2.8 0l2.6 2.5a2 2 0 0 1 0 2.8l-6 6.3H7.7z" />
        <path d="M9.2 9.8l5.8 5.8M12 18h8" />
      </IconFrame>
    );
  }
  return (
    <IconFrame {...props}>
      <path d="M5 3l13.5 8.2-6 1.5-2.6 5.8z" />
      <path d="M12.5 12.7l4.1 4.1" />
    </IconFrame>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M20 11a8 8 0 1 0-2.1 6.8" />
      <path d="M20 4v7h-7" />
    </IconFrame>
  );
}

export function DiffIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4 6h7M13 6h7M7 3v6M17 3v6" />
      <path d="M4 18h7M13 18h7M7 15v6M17 15v6" />
    </IconFrame>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4 7h16M10 7V4h4v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5" />
    </IconFrame>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M9 7H4v-5" />
      <path d="M4 7c2.2-3 5.4-4 8.5-2.9 4 1.4 6.1 5.8 4.8 9.8-1.4 4-5.8 6.1-9.8 4.8-2.3-.8-4-2.6-4.8-4.8" />
    </IconFrame>
  );
}

export function PanelLeftIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M9 4v16" />
      <path d="M5.8 8h.4M5.8 11h.4" />
    </IconFrame>
  );
}

export function PanelRightIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M15 4v16" />
      <path d="M17.8 8h.4M17.8 11h.4" />
    </IconFrame>
  );
}

export function AgentIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M12 3l1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4z" />
      <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" />
      <path d="M6.5 15.5l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" />
    </IconFrame>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8" cy="9" r="1.5" />
      <path d="m3 17 5-5 4 4 3-3 6 6" />
    </IconFrame>
  );
}
export function LinkIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l4-4a4 4 0 0 1 5 0M14 9l2-2a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-5 0" />
    </IconFrame>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </IconFrame>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </IconFrame>
  );
}

/** Two stacked sheets with a red-pen mark: layers you draw on. */
export function BrandMark(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect className="bm-back" x="7.5" y="2.5" width="14" height="14" rx="3" />
      <rect
        className="bm-front"
        x="2.5"
        y="7.5"
        width="14"
        height="14"
        rx="3"
      />
      <path
        className="bm-ink"
        d="M5.8 16.2c1.6-2.4 3.2 1.4 5-1.2 0.7-1 1.3-1.4 2.2-1.2"
      />
    </svg>
  );
}

/** A short sample of each line preset, drawn the way the board draws it. */
export function EdgePresetIcon({ preset }: { preset: string }) {
  const head = "M23 4l4 3-4 3";
  return (
    <svg
      viewBox="0 0 30 14"
      width="30"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {preset === "curve" ? (
        <path d="M3 11C10 11 12 3 26.5 7" />
      ) : (
        <path
          d="M3 7h23.5"
          strokeDasharray={preset === "dashed" ? "3.5 3" : undefined}
        />
      )}
      {preset !== "none" && <path d={head} />}
      {preset === "both" && <path d="M7 4L3 7l4 3" />}
    </svg>
  );
}
