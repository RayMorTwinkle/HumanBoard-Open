#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
bun install --frozen-lockfile
exec bun run studio
