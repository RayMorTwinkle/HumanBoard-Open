#!/bin/sh
set -eu
cd "$(dirname "$0")"
out=$(mktemp "${TMPDIR:-/tmp}/humanboard-replay.XXXXXX")
trap 'rm -f "$out"' EXIT
bun --no-env-file ../artifacts/diagram-layout.mjs ./backup/diagram.ts ./refactor/diagram.ts backup refactor > "$out"
node --input-type=module - "$out" <<'JS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const reference = JSON.parse(readFileSync("../artifacts/diagram-layout.json", "utf8"));
const actual = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const arm of ["backup", "refactor"]) {
  assert.deepEqual(actual.arms[arm].files_sha256, reference.arms[arm].files_sha256);
  assert.equal(actual.arms[arm].zod, reference.arms[arm].zod);
}
assert.deepEqual(actual.compatibility, reference.compatibility);
const identity = ({fixture, nodes, input_sha256, output_sha256}) =>
  ({fixture, nodes, input_sha256, output_sha256});
assert.deepEqual(actual.measurements.map(identity), reference.measurements.map(identity));
JS
cat "$out"
