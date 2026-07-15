#!/usr/bin/env node

import { runHook, mcpResult } from '../lib/image-bridge.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  if (Number(process.versions.node.split('.')[0]) < 20) {
    throw new Error('The Quire plugin requires Node.js 20 or newer.');
  }
  const input = JSON.parse(raw);
  const output = await runHook(input);
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  const message = error instanceof Error ? error.message : 'The pasted image could not be attached to Quire.';
  process.stdout.write(JSON.stringify(mcpResult({ status: 'attachment_failed', error: message })));
}
