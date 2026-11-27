const string = { type: "string" };
const branch = { branch: string };
const head = {
  ...branch,
  head: {
    type: "string",
    description: "Expected immutable target head returned by board_state.",
  },
};
const source = {
  ...head,
  source: string,
  sourceBranch: {
    type: "string",
    description: "Named source ref, when reviewing a branch tip.",
  },
};
const definitions = [
  ["state", "Read the scene, branch tips, and activity history.", branch, []],
  [
    "fork",
    "Create a named branch at an existing layer.",
    { ...branch, from: string },
    ["branch", "from"],
  ],
  [
    "save",
    "Commit a full Scene to a branch with optimistic concurrency.",
    { ...head, title: string, scene: { type: "object" } },
    ["branch", "head", "title", "scene"],
  ],
  [
    "review",
    "Preview three-way changes and conflicts before accepting.",
    source,
    ["branch", "head", "source"],
  ],
  [
    "accept",
    "Merge the reviewed immutable source into the expected head.",
    source,
    ["branch", "head", "source"],
  ],
  [
    "revert",
    "Append an inverse commit for the expected head.",
    head,
    ["branch", "head"],
  ],
] as const;
export const revisionTools = definitions.map(
  ([action, description, properties, required]) => ({
    name: "board_" + action,
    description,
    inputSchema: {
      type: "object",
      properties: { ...properties, space: string, project: string },
      required,
      additionalProperties: false,
    },
  }),
);
