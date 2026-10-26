#!/bin/sh
set -eu
WEFT_MANAGEMENT_TOKEN=$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"))')
export WEFT_MANAGEMENT_TOKEN
exec node --watch src/server.ts "$@"
