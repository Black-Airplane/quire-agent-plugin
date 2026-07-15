#!/usr/bin/env node

import { cleanupImageBridge } from '../lib/image-bridge.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  cleanupImageBridge(JSON.parse(raw));
} catch {
  // Stale keys are pruned by the next attachment preparation as a fallback.
}
