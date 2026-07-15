#!/usr/bin/env node

import { prepareImageBridge } from '../lib/image-bridge.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  if (Number(process.versions.node.split('.')[0]) < 20) {
    throw new Error('The Quire plugin requires Node.js 20 or newer.');
  }
  const input = JSON.parse(raw);
  process.stdout.write(JSON.stringify(prepareImageBridge(input)));
} catch (error) {
  const message = error instanceof Error ? error.message : 'The Quire pasted-image bridge could not be prepared.';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    },
  }));
}
