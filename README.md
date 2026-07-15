# Quire for Claude Code

This plugin lets Claude Code add PNG, JPEG, and WebP images pasted into a conversation directly to Quire documents. It contains no credentials and does not replace the authenticated Quire MCP connection.

## Requirements

- Claude Code 2.1.207 or newer
- Node.js 20 or newer
- A Quire MCP connection named `quire`

## Install

```bash
claude plugin marketplace add Black-Airplane/quire-agent-plugin
claude plugin install quire@black-airplane
claude mcp add --transport http quire https://YOUR-QUIRE-HOST/mcp
```

Open `/mcp` in Claude Code and authenticate Quire, then run:

```text
/reload-plugins
```

Already installed? Update the marketplace and plugin, then reload:

```bash
claude plugin marketplace update black-airplane
claude plugin update quire@black-airplane
```

Existing Claude Code sessions keep using the previous plugin version until `/reload-plugins` runs.

## Use

Paste one or more images into Claude Code and refer to the labels exactly:

> Add Image #1 to the bottom of document 287.

> Put Image #2 after the “Install” section in the setup document.

Claude calls Quire with the `Image #N` reference. The plugin retrieves the matching original from the current local transcript and completes the upload. Images are limited to 10 MiB, 64 megapixels, and PNG, JPEG, or WebP.

## Security

Before a pasted-image MCP call, the plugin creates a 2048-bit ephemeral RSA keypair and adds only the public key to the tool input. Quire encrypts a two-minute, one-use upload token with RSA-OAEP-SHA256. After the MCP call, the plugin reads only the requested `Image #N` from the current transcript, decrypts the token locally, deletes the private key, and uploads the original bytes directly to Quire.

Private keys are stored with `0600` permissions, stale keys are pruned, redirects are refused, and upload URLs must be secure Quire MCP image-upload endpoints. Image bytes, private keys, and plaintext upload tokens are never placed in model-visible tool output.

## Troubleshooting

- **“plugin required” or missing bridge key:** update `quire@black-airplane`, run `/reload-plugins`, and retry once.
- **Image not available:** use the exact `Image #N` label from the current Claude Code conversation. Re-paste the image if the transcript no longer contains it.
- **Capability expired or already used:** retry the attachment. Capabilities expire after two minutes and cannot be replayed.
- **Invalid image:** confirm the image is PNG, JPEG, or WebP, no larger than 10 MiB, and no larger than 64 megapixels.
- **Authentication revoked:** open `/mcp`, reconnect Quire with document write access, then retry.
- **Wrong MCP name:** the hook matcher requires the connection to be named `quire`.

Automatic pasted-image forwarding is Claude Code-only in v1. Other MCP clients can continue using Quire’s URL, base64, and existing-image sources.
