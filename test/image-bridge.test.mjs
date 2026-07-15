import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BRIDGE_ENCRYPTION,
  BRIDGE_PUBLIC_KEY_INPUT,
  CAPABILITY_KEY,
  MAX_IMAGE_BYTES,
  cleanupImageBridge,
  extractUploadCapability,
  findPastedImage,
  mcpResult,
  parseImageReference,
  prepareImageBridge,
  runHook,
} from '../plugin/lib/image-bridge.mjs';

function png(width = 1, height = 1) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width = 1, height = 1) {
  const bytes = Buffer.alloc(17);
  Buffer.from('ffd8ffc0000b08', 'hex').copy(bytes);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[11] = 1;
  return bytes;
}

function webp(width = 1, height = 1) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBPVP8X', 8, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

const PNG = png();
const JPEG = jpeg();
const WEBP = webp();

async function transcript(records) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quire-plugin-transcript-'));
  const file = path.join(directory, 'session.jsonl');
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n'));
  return file;
}

function imageRecord(ids, images) {
  return {
    type: 'user',
    imagePasteIds: ids,
    message: {
      role: 'user',
      content: images.map(({ mimeType, bytes }) => ({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: bytes.toString('base64') },
      })),
    },
  };
}

function encryptedCapability(publicKey, imageRef = 'Image #4', overrides = {}) {
  const encryptedToken = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from('secret-capability')
  ).toString('base64');

  return {
    status: 'upload_pending',
    [CAPABILITY_KEY]: {
      upload_url: 'https://app.quire.bot/mcp/image-uploads/019f6400-0000-7000-8000-000000000001',
      encrypted_upload_token: encryptedToken,
      encryption: BRIDGE_ENCRYPTION,
      image_ref: imageRef,
      file_name: 'pasted-image-4',
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      max_bytes: MAX_IMAGE_BYTES,
      accepted_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
      ...overrides,
    },
  };
}

test('parses only exact Claude Code image references', () => {
  assert.equal(parseImageReference('Image #12'), 12);
  for (const invalid of ['image #12', ' Image #12', 'Image #0', '/tmp/image.png']) {
    assert.throws(() => parseImageReference(invalid), /exact pasted-image reference/);
  }
});

test('resolves multiple formats and requested ids across transcript turns', async () => {
  const file = await transcript([
    imageRecord([1], [{ mimeType: 'image/png', bytes: PNG }]),
    { type: 'assistant', message: { content: [] } },
    imageRecord([2, 3], [
      { mimeType: 'image/jpeg', bytes: JPEG },
      { mimeType: 'image/webp', bytes: WEBP },
    ]),
  ]);

  assert.deepEqual(await findPastedImage(file, 1), { mimeType: 'image/png', bytes: PNG });
  assert.deepEqual(await findPastedImage(file, 2), { mimeType: 'image/jpeg', bytes: JPEG });
  assert.deepEqual(await findPastedImage(file, 3), { mimeType: 'image/webp', bytes: WEBP });
});

test('rejects missing, unsupported, spoofed, malformed, oversized, and excessive-pixel images', async () => {
  const missing = await transcript([]);
  await assert.rejects(() => findPastedImage(missing, 9), /not available/);

  const unsupported = await transcript([imageRecord([1], [{ mimeType: 'image/gif', bytes: Buffer.from('GIF89a') }])]);
  await assert.rejects(() => findPastedImage(unsupported, 1), /PNG, JPEG, and WebP/);

  const spoofed = await transcript([imageRecord([1], [{ mimeType: 'image/png', bytes: JPEG }])]);
  await assert.rejects(() => findPastedImage(spoofed, 1), /does not match/);

  const malformedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'quire-plugin-transcript-'));
  const malformed = path.join(malformedDirectory, 'session.jsonl');
  await fs.writeFile(malformed, JSON.stringify({
    imagePasteIds: [1],
    message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '***=' } }] },
  }));
  await assert.rejects(() => findPastedImage(malformed, 1), /invalid base64/);

  const oversized = await transcript([
    imageRecord([1], [{ mimeType: 'image/png', bytes: Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]) }]),
  ]);
  await assert.rejects(() => findPastedImage(oversized, 1), /10 MiB/);

  const excessivePixels = await transcript([
    imageRecord([1], [{ mimeType: 'image/png', bytes: png(8001, 8000) }]),
  ]);
  await assert.rejects(() => findPastedImage(excessivePixels, 1), /64-megapixel/);
});

test('prepares 2048-bit ephemeral keys with 0600 permissions and prunes stale keys', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quire-plugin-bridge-'));
  const keyDirectory = path.join(directory, 'bridge-keys');
  await fs.mkdir(keyDirectory, { recursive: true });
  const stale = path.join(keyDirectory, 'stale.pem');
  await fs.writeFile(stale, 'stale');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(stale, old, old);

  const output = prepareImageBridge({
    tool_use_id: 'toolu_prepare_1',
    tool_input: { doc: 47, source_type: 'pasted', image_ref: 'Image #4', position: 'end' },
  }, directory);
  const hook = output.hookSpecificOutput;
  const publicPem = hook.updatedInput[BRIDGE_PUBLIC_KEY_INPUT];
  const publicKey = crypto.createPublicKey(publicPem);

  assert.equal(hook.updatedInput.doc, 47);
  assert.equal(hook.updatedInput.image_ref, 'Image #4');
  assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 2048);
  const keyFile = path.join(keyDirectory, 'toolu_prepare_1.pem');
  assert.match(await fs.readFile(keyFile, 'utf8'), /BEGIN PRIVATE KEY/);
  assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);
  await assert.rejects(() => fs.readFile(stale));

  cleanupImageBridge({ tool_use_id: 'toolu_prepare_1' }, directory);
  await assert.rejects(() => fs.readFile(keyFile));
});

test('leaves legacy attach_image sources unchanged', () => {
  assert.deepEqual(prepareImageBridge({
    tool_use_id: 'toolu_legacy',
    tool_input: { source_type: 'url', url: 'https://example.com/image.png' },
  }), {});
});

test('extracts only live SHA-256 capabilities from secure upload URLs', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const capability = extractUploadCapability(JSON.stringify(encryptedCapability(publicKey)));
  assert.equal(capability.encryption, 'rsa-oaep-sha256');

  for (const uploadUrl of [
    'http://app.quire.bot/mcp/image-uploads/019f6400-0000-7000-8000-000000000001',
    'https://user:pass@app.quire.bot/mcp/image-uploads/019f6400-0000-7000-8000-000000000001',
    'https://app.quire.bot/not-an-upload/019f6400-0000-7000-8000-000000000001',
  ]) {
    assert.throws(
      () => extractUploadCapability(encryptedCapability(publicKey, 'Image #4', { upload_url: uploadUrl })),
      /insecure or malformed/
    );
  }
  assert.throws(
    () => extractUploadCapability(encryptedCapability(publicKey, 'Image #4', { expires_at: new Date(Date.now() - 1).toISOString() })),
    /expired/
  );
  assert.throws(
    () => extractUploadCapability(encryptedCapability(publicKey, 'Image #4', { encryption: 'rsa-oaep-sha1' })),
    /encrypted pasted-image/
  );
});

test('decrypts RSA-OAEP-SHA256, uploads original bytes, and replaces the pending MCP result', async () => {
  const file = await transcript([imageRecord([4], [{ mimeType: 'image/png', bytes: PNG }])]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quire-plugin-bridge-'));
  const toolInput = { source_type: 'pasted', image_ref: 'Image #4' };
  const prepared = prepareImageBridge({ tool_use_id: 'toolu_upload_1', tool_input: toolInput }, directory);
  const publicKey = prepared.hookSpecificOutput.updatedInput[BRIDGE_PUBLIC_KEY_INPUT];
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ status: 'attached', image: { key: 'abc' } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const output = await runHook({
    tool_use_id: 'toolu_upload_1',
    transcript_path: file,
    tool_input: toolInput,
    tool_response: JSON.stringify(encryptedCapability(publicKey)),
  }, fakeFetch, directory);

  assert.equal(request.url, 'https://app.quire.bot/mcp/image-uploads/019f6400-0000-7000-8000-000000000001');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-capability');
  assert.equal(request.options.headers['Content-Type'], 'image/png');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(request.options.body, PNG);
  assert.equal(JSON.parse(output.hookSpecificOutput.updatedMCPToolOutput[0].text).status, 'attached');
  await assert.rejects(() => fs.readFile(path.join(directory, 'bridge-keys', 'toolu_upload_1.pem')));
});

test('rejects reference mismatch and upload errors while always deleting the secret key', async () => {
  const file = await transcript([imageRecord([5], [{ mimeType: 'image/jpeg', bytes: JPEG }])]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quire-plugin-bridge-'));
  const toolInput = { source_type: 'pasted', image_ref: 'Image #5' };
  const prepared = prepareImageBridge({ tool_use_id: 'toolu_error_1', tool_input: toolInput }, directory);
  const publicKey = prepared.hookSpecificOutput.updatedInput[BRIDGE_PUBLIC_KEY_INPUT];

  await assert.rejects(
    () => runHook({
      tool_use_id: 'toolu_error_1',
      transcript_path: file,
      tool_input: toolInput,
      tool_response: encryptedCapability(publicKey, 'Image #4'),
    }, undefined, directory),
    /different pasted image/
  );
  await assert.rejects(() => fs.readFile(path.join(directory, 'bridge-keys', 'toolu_error_1.pem')));

  const preparedAgain = prepareImageBridge({ tool_use_id: 'toolu_error_2', tool_input: toolInput }, directory);
  const secondPublicKey = preparedAgain.hookSpecificOutput.updatedInput[BRIDGE_PUBLIC_KEY_INPUT];
  await assert.rejects(
    () => runHook({
      tool_use_id: 'toolu_error_2',
      transcript_path: file,
      tool_input: toolInput,
      tool_response: encryptedCapability(secondPublicKey, 'Image #5'),
    }, async () => new Response(JSON.stringify({ error: 'Capability was already used.' }), { status: 410 }), directory),
    /already used/
  );
  await assert.rejects(() => fs.readFile(path.join(directory, 'bridge-keys', 'toolu_error_2.pem')));
});

test('returns the MCP content-block array required by Claude Code 2.1.207', () => {
  const output = mcpResult({ status: 'attachment_failed', error: 'Try again.' });
  assert.deepEqual(output.hookSpecificOutput.updatedMCPToolOutput, [
    { type: 'text', text: JSON.stringify({ status: 'attachment_failed', error: 'Try again.' }) },
  ]);
});
