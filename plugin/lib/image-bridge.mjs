import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64_000_000;
export const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const BRIDGE_PUBLIC_KEY_INPUT = '_quire_bridge_public_key';
export const BRIDGE_ENCRYPTION = 'rsa-oaep-sha256';
export const CAPABILITY_KEY = 'quire/document-image-upload';
const BRIDGE_KEY_MAX_AGE_MS = 5 * 60 * 1000;

function bridgeDataDirectory(dataDirectory) {
  return dataDirectory || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'quire-agent-plugin');
}

function bridgeKeyPath(input, dataDirectory) {
  const toolUseId = String(input.tool_use_id ?? '');
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(toolUseId)) {
    throw new Error('Claude Code did not provide a valid tool-use id for the Quire image bridge.');
  }

  return path.join(bridgeDataDirectory(dataDirectory), 'bridge-keys', `${toolUseId}.pem`);
}

function removeBridgeKey(input, dataDirectory) {
  try {
    fs.rmSync(bridgeKeyPath(input, dataDirectory), { force: true });
  } catch {
    // Cleanup must never hide the attachment result.
  }
}

export function cleanupImageBridge(input, dataDirectory) {
  removeBridgeKey(input, dataDirectory);
}

function pruneBridgeKeys(directory) {
  const cutoff = Date.now() - BRIDGE_KEY_MAX_AGE_MS;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.pem')) continue;
    const filename = path.join(directory, entry.name);
    try {
      if (fs.statSync(filename).mtimeMs < cutoff) fs.rmSync(filename, { force: true });
    } catch {
      // A concurrent hook may have consumed the key already.
    }
  }
}

function isPastedSource(input) {
  return input.tool_input?.source_type === 'pasted';
}

export function prepareImageBridge(input, dataDirectory) {
  if (!isPastedSource(input)) return {};

  // Fail before generating a key when Claude did not preserve an exact
  // transcript reference in the MCP input.
  parseImageReference(input.tool_input?.image_ref);

  const filename = bridgeKeyPath(input, dataDirectory);
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  pruneBridgeKeys(directory);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.rmSync(filename, { force: true });
  fs.writeFileSync(filename, privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(filename, 0o600);

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Adds an ephemeral public key so Quire can encrypt a one-time pasted-image upload token.',
      updatedInput: {
        ...input.tool_input,
        [BRIDGE_PUBLIC_KEY_INPUT]: publicKey,
      },
    },
  };
}

export function parseImageReference(imageRef) {
  const match = /^Image #([1-9][0-9]*)$/.exec(String(imageRef ?? ''));
  if (!match) {
    throw new Error('Use the exact pasted-image reference, for example "Image #2".');
  }

  return Number(match[1]);
}

function validateBase64(data) {
  if (
    data.length === 0 ||
    data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    throw new Error('The pasted image contains invalid base64 data or exceeds the 10 MiB limit.');
  }
}

export async function findPastedImage(transcriptPath, imageId) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') {
    throw new Error('Claude Code did not provide the current transcript path.');
  }

  const input = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let found = null;

  for await (const line of lines) {
    if (!line.includes('imagePasteIds')) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (!Array.isArray(record.imagePasteIds) || !Array.isArray(record.message?.content)) continue;

    const images = record.message.content.filter((block) => block?.type === 'image');
    for (let index = 0; index < record.imagePasteIds.length; index += 1) {
      if (Number(record.imagePasteIds[index]) !== imageId) continue;

      const source = images[index]?.source;
      if (source?.type === 'base64' && typeof source.data === 'string') {
        found = { mimeType: source.media_type, data: source.data };
      }
    }
  }

  if (!found) throw new Error(`Image #${imageId} is not available in this Claude Code session.`);
  if (!ALLOWED_MIME_TYPES.has(found.mimeType)) {
    throw new Error('Quire pasted-image uploads support PNG, JPEG, and WebP only.');
  }

  validateBase64(found.data);
  const bytes = Buffer.from(found.data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('The pasted image is empty or exceeds the 10 MiB limit.');
  }
  validateSignature(bytes, found.mimeType);
  validatePixelCount(bytes, found.mimeType);

  return { mimeType: found.mimeType, bytes };
}

function validateSignature(bytes, mimeType) {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (
    (mimeType === 'image/png' && !png) ||
    (mimeType === 'image/jpeg' && !jpeg) ||
    (mimeType === 'image/webp' && !webp)
  ) {
    throw new Error('The pasted image data does not match its declared format.');
  }
}

function validatePixelCount(bytes, mimeType) {
  const dimensions =
    mimeType === 'image/png'
      ? pngDimensions(bytes)
      : mimeType === 'image/jpeg'
        ? jpegDimensions(bytes)
        : webpDimensions(bytes);

  if (dimensions === null) {
    throw new Error('The pasted image has invalid or unsupported image dimensions.');
  }

  const { width, height } = dimensions;
  if (width < 1 || height < 1 || width > Math.floor(MAX_IMAGE_PIXELS / height)) {
    throw new Error('The pasted image exceeds the 64-megapixel limit.');
  }
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes) {
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;

  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;

    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }

  return null;
}

function webpDimensions(bytes) {
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.subarray(offset, offset + 4).toString('ascii');
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkLength > bytes.length) return null;

    if (chunkType === 'VP8X' && chunkLength >= 10) {
      return {
        width: 1 + readUInt24LE(bytes, dataOffset + 4),
        height: 1 + readUInt24LE(bytes, dataOffset + 7),
      };
    }
    if (chunkType === 'VP8 ' && chunkLength >= 10) {
      if (!bytes.subarray(dataOffset + 3, dataOffset + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return null;
      return {
        width: bytes.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: bytes.readUInt16LE(dataOffset + 8) & 0x3fff,
      };
    }
    if (chunkType === 'VP8L' && chunkLength >= 5) {
      if (bytes[dataOffset] !== 0x2f) return null;
      return {
        width: 1 + bytes[dataOffset + 1] + ((bytes[dataOffset + 2] & 0x3f) << 8),
        height:
          1 +
          (bytes[dataOffset + 2] >> 6) +
          (bytes[dataOffset + 3] << 2) +
          ((bytes[dataOffset + 4] & 0x0f) << 10),
      };
    }

    offset = dataOffset + chunkLength + (chunkLength % 2);
  }

  return null;
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
}

export function extractUploadCapability(toolResponse, now = Date.now()) {
  const seen = new Set();

  function visit(value, depth = 0) {
    if (depth > 10 || value == null) return null;
    if (typeof value === 'string') {
      if (!value.trim().startsWith('{')) return null;
      try {
        return visit(JSON.parse(value), depth + 1);
      } catch {
        return null;
      }
    }
    if (typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);

    const direct = value[CAPABILITY_KEY];
    if (direct && typeof direct === 'object') return direct;

    for (const child of Object.values(value)) {
      const result = visit(child, depth + 1);
      if (result) return result;
    }
    return null;
  }

  const capability = visit(toolResponse);
  if (
    !capability ||
    typeof capability.upload_url !== 'string' ||
    typeof capability.encrypted_upload_token !== 'string' ||
    capability.encryption !== BRIDGE_ENCRYPTION ||
    typeof capability.image_ref !== 'string' ||
    typeof capability.expires_at !== 'string'
  ) {
    throw new Error('Quire did not provide an encrypted pasted-image upload capability. Update the MCP server and plugin, then retry.');
  }

  const expiresAt = Date.parse(capability.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error('The Quire image upload capability has expired. Retry the attachment once.');
  }

  const url = new URL(capability.upload_url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const validPath = /\/mcp\/image-uploads\/[0-9a-f-]{36}$/i.test(url.pathname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !validPath
  ) {
    throw new Error('Quire returned an insecure or malformed image upload URL.');
  }

  return { ...capability, uploadUrl: url.toString() };
}

function resolveUploadToken(capability, input, dataDirectory) {
  const filename = bridgeKeyPath(input, dataDirectory);
  let privateKey;
  try {
    privateKey = fs.readFileSync(filename, 'utf8');
  } catch {
    throw new Error('The ephemeral Quire image bridge key is unavailable. Retry the attachment once.');
  } finally {
    fs.rmSync(filename, { force: true });
  }

  try {
    return crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(capability.encrypted_upload_token, 'base64')
    ).toString('utf8');
  } catch {
    throw new Error('Quire returned an image upload token that this bridge could not decrypt.');
  }
}

export function mcpResult(result) {
  const content = [{ type: 'text', text: JSON.stringify(result) }];

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      // Claude Code 2.1.207 expects the content-block array itself here.
      updatedMCPToolOutput: content,
    },
  };
}

export async function runHook(input, fetchImpl = globalThis.fetch, dataDirectory) {
  if (!isPastedSource(input)) return {};

  try {
    const imageRef = input.tool_input?.image_ref;
    const imageId = parseImageReference(imageRef);
    const image = await findPastedImage(input.transcript_path, imageId);
    const capability = extractUploadCapability(input.tool_response);
    if (capability.image_ref !== imageRef) {
      throw new Error('Quire returned an upload capability for a different pasted image reference.');
    }
    const uploadToken = resolveUploadToken(capability, input, dataDirectory);

    const response = await fetchImpl(capability.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        Accept: 'application/json',
        'Content-Type': image.mimeType,
      },
      body: image.bytes,
      redirect: 'error',
    });
    const text = await response.text();

    let result;
    try {
      result = JSON.parse(text);
    } catch {
      result = { error: response.ok ? 'Quire returned an invalid upload response.' : 'Quire rejected the pasted image upload.' };
    }

    if (!response.ok) {
      const message = typeof result.error === 'string' ? result.error : typeof result.message === 'string' ? result.message : `Quire image upload failed (${response.status}).`;
      throw new Error(message);
    }

    return mcpResult(result);
  } finally {
    removeBridgeKey(input, dataDirectory);
  }
}
