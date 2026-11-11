import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, type ContentBlock } from "./call.js";
import { connect } from "./connect.js";
import { DEFAULT_CONTENT_LIMITS, base64Bytes, normaliseContent } from "./content.js";
import { SessionRegistry } from "./registry.js";
import type { Session } from "./session.js";
import { BIG_TEXT_LENGTH, TINY_PNG_BASE64, TINY_WAV_BASE64 } from "./__fixtures__/echo-server.js";
import { fixtureServerConfig, reap } from "./__fixtures__/spawn.js";

const registry = new SessionRegistry();
let session: Session;
const call = (name: string) => callTool(session, name, {}, { callId: randomUUID() });

beforeAll(async () => {
  session = await connect("content", fixtureServerConfig(), { registry });
});
afterAll(async () => {
  await registry.disconnectAll();
  reap(session?.pid);
});

describe("normaliseContent against real server output", () => {
  it("renders text and image", async () => {
    const res = await call("tiny_image");
    expect(normaliseContent(res.content)).toEqual([
      { kind: "text", text: "here is an image" },
      { kind: "image", mimeType: "image/png", data: TINY_PNG_BASE64, bytes: 70 },
    ]);
  });

  it("renders audio, an embedded resource and a resource link", async () => {
    const res = await call("all_content_kinds");
    expect(normaliseContent(res.content)).toEqual([
      { kind: "audio", mimeType: "audio/wav", data: TINY_WAV_BASE64, bytes: 48 },
      { kind: "resource", uri: "fixture://notes/readme", mimeType: "text/plain", text: "embedded resource text" },
      { kind: "resource_link", uri: "fixture://notes/linked", name: "linked-notes", mimeType: "text/markdown" },
    ]);
  });

  it("keeps a 200k text blob under the default cap untouched", async () => {
    const res = await call("big_text");
    const [block] = normaliseContent(res.content);
    expect(DEFAULT_CONTENT_LIMITS.maxTextChars).toBeGreaterThanOrEqual(BIG_TEXT_LENGTH / 2);
    expect(block?.kind).toBe("text");
  });

  it("truncates text over the cap and says so", async () => {
    const res = await call("big_text");
    const [block] = normaliseContent(res.content, { maxTextChars: 1000 });
    expect(block).toMatchObject({ kind: "text", truncation: { unit: "chars", shown: 1000, total: BIG_TEXT_LENGTH } });
    expect(block?.kind === "text" && block.text).toHaveLength(1000);
  });

  it("drops an image over the base64 cap, keeping its size and a marker", async () => {
    const res = await call("tiny_image");
    const [, image] = normaliseContent(res.content, { maxBase64Chars: 10 });
    expect(image).toEqual({
      kind: "image",
      mimeType: "image/png",
      bytes: 70,
      truncation: { unit: "base64-chars", shown: 0, total: TINY_PNG_BASE64.length },
    });
    expect(image).not.toHaveProperty("data");
  });
});

describe("normaliseContent on constructed blocks", () => {
  it("caps a multi-megabyte image, which is what protects the DOM", () => {
    const big = "A".repeat(4_000_000);
    const [image] = normaliseContent([{ type: "image", data: big, mimeType: "image/png" }]);
    expect(image).toMatchObject({ kind: "image", bytes: 3_000_000, truncation: { total: 4_000_000 } });
    expect(JSON.stringify(image).length).toBeLessThan(500);
  });

  it("handles a resource blob, including the cap", () => {
    const blockOf = (blob: string): ContentBlock => ({ type: "resource", resource: { uri: "x://b", blob } });
    expect(normaliseContent([blockOf("QUJD")])).toEqual([{ kind: "resource", uri: "x://b", blob: "QUJD", bytes: 3 }]);
    const [capped] = normaliseContent([blockOf("QUJD")], { maxBase64Chars: 2 });
    expect(capped).toMatchObject({ kind: "resource", bytes: 3, truncation: { unit: "base64-chars" } });
    expect(capped).not.toHaveProperty("blob");
  });

  it("preserves order and carries an unknown type instead of dropping it", () => {
    const odd = { type: "hologram", payload: 1 } as unknown as ContentBlock;
    const out = normaliseContent([{ type: "text", text: "a" }, odd, { type: "text", text: "b" }]);
    expect(out.map((b) => b.kind)).toEqual(["text", "unknown", "text"]);
    expect(out[1]).toEqual({ kind: "unknown", type: "hologram", json: '{"type":"hologram","payload":1}' });
  });

  it("returns an empty model for empty content", () => {
    expect(normaliseContent([])).toEqual([]);
  });

  it("computes base64 byte sizes with padding", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes("QQ==")).toBe(1);
    expect(base64Bytes("QUI=")).toBe(2);
    expect(base64Bytes("QUJD")).toBe(3);
  });
});
