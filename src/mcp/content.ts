// Turns a tools/call `content` array into a render model the UI can draw directly. The point is
// the caps: without them a 3MB base64 image lands in the DOM as one string and hangs the tab.
import type { ContentBlock } from "./call.js";

export interface ContentLimits {
  /** Longest text shown, in characters. */
  maxTextChars: number;
  /** Longest base64 payload kept, in characters (about 0.75 bytes each). */
  maxBase64Chars: number;
}

export const DEFAULT_CONTENT_LIMITS: ContentLimits = {
  maxTextChars: 100_000,
  maxBase64Chars: 1_000_000,
};

/** Set on any block whose payload was cut or dropped. `shown` and `total` are in `unit`s. */
export interface Truncation {
  unit: "chars" | "base64-chars";
  shown: number;
  total: number;
}

export type RenderBlock =
  | { kind: "text"; text: string; truncation?: Truncation }
  | { kind: "image"; mimeType: string; data?: string; bytes: number; truncation?: Truncation }
  | { kind: "audio"; mimeType: string; data?: string; bytes: number; truncation?: Truncation }
  | {
      kind: "resource";
      uri: string;
      mimeType?: string;
      /** Exactly one of `text` or `blob` is present, unless the blob was dropped for size. */
      text?: string;
      blob?: string;
      bytes?: number;
      truncation?: Truncation;
    }
  | { kind: "resource_link"; uri: string; name: string; title?: string; description?: string; mimeType?: string }
  /** A content type this client does not know. Carried as capped JSON so nothing is silently lost. */
  | { kind: "unknown"; type: string; json: string; truncation?: Truncation };

/** Decoded size of a base64 string, without decoding it. */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function capText(text: string, limits: ContentLimits): { text: string; truncation?: Truncation } {
  if (text.length <= limits.maxTextChars) return { text };
  return {
    text: text.slice(0, limits.maxTextChars),
    truncation: { unit: "chars", shown: limits.maxTextChars, total: text.length },
  };
}

/**
 * Base64 cannot be cut and still decode as the same media, so an oversized payload is dropped
 * whole: `data` is omitted and the truncation marker says how much was left out.
 */
function capBase64(data: string, limits: ContentLimits): { data?: string; bytes: number; truncation?: Truncation } {
  const bytes = base64Bytes(data);
  if (data.length <= limits.maxBase64Chars) return { data, bytes };
  return { bytes, truncation: { unit: "base64-chars", shown: 0, total: data.length } };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function normaliseOne(block: ContentBlock, limits: ContentLimits): RenderBlock {
  switch (block.type) {
    case "text":
      return { kind: "text", ...capText(block.text, limits) };
    case "image":
      return { kind: "image", mimeType: block.mimeType, ...capBase64(block.data, limits) };
    case "audio":
      return { kind: "audio", mimeType: block.mimeType, ...capBase64(block.data, limits) };
    case "resource": {
      const r = block.resource;
      const base = { kind: "resource" as const, uri: r.uri, ...(r.mimeType ? { mimeType: r.mimeType } : {}) };
      if ("text" in r && typeof r.text === "string") return { ...base, ...capText(r.text, limits) };
      const blob = "blob" in r ? str(r.blob) : "";
      const { data, bytes, truncation } = capBase64(blob, limits);
      return { ...base, ...(data !== undefined ? { blob: data } : {}), bytes, ...(truncation ? { truncation } : {}) };
    }
    case "resource_link":
      return {
        kind: "resource_link",
        uri: block.uri,
        name: block.name,
        ...(block.title ? { title: block.title } : {}),
        ...(block.description ? { description: block.description } : {}),
        ...(block.mimeType ? { mimeType: block.mimeType } : {}),
      };
    default: {
      const raw: { type?: unknown } = block;
      const json = JSON.stringify(raw) ?? "";
      const capped = capText(json, limits);
      return { kind: "unknown", type: str(raw.type) || "unknown", json: capped.text, ...(capped.truncation ? { truncation: capped.truncation } : {}) };
    }
  }
}

/**
 * Normalises `content`, one RenderBlock per entry, order preserved. Never throws on a malformed
 * entry: anything unrecognised becomes an `unknown` block.
 */
export function normaliseContent(
  content: readonly ContentBlock[],
  limits: Partial<ContentLimits> = {},
): RenderBlock[] {
  const l: ContentLimits = { ...DEFAULT_CONTENT_LIMITS, ...limits };
  return content.map((block) => normaliseOne(block, l));
}
