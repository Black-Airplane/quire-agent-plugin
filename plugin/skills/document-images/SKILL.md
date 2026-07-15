---
name: document-images
description: Attach PNG, JPEG, or WebP images pasted into Claude Code to Quire documents through the quire MCP server. Use when the user asks to add, attach, upload, embed, or include an Image #N in a Quire document.
---

# Quire document images

When a user asks to add a pasted image to a Quire document:

1. Resolve or create the document first. If creating it, wait for `mcp__quire__create_doc` to return the document id.
2. Call `mcp__quire__attach_image` once per image with `source_type: "pasted"`.
3. Pass `image_ref` exactly as displayed in the conversation, such as `Image #2`.
4. Preserve the requested location with `heading_path` and `position`. Use `position: "end"` when the user asks for the bottom of the document.
5. Supply concise, accessible `alt` text based only on visible content. Add `description` or `transcription` when the image contains information future readers or agents will need.
6. Do not claim the image is attached until the tool returns `status: "attached"`. If upload fails, report that the document edit did not receive the image and retry only the image when appropriate.

Never encode the image as base64 in a tool argument, invent a local path, substitute a public URL, or replace the image with a textual description.
