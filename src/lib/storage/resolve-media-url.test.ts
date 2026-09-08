import { describe, expect, it, vi } from "vitest";
import {
  parseAccountBucketPath,
  resolveSignedMediaUrl,
  MEDIA_SIGNED_URL_TTL_SECONDS,
  MEDIA_SIGNED_URL_TTL_SECONDS_UI,
} from "./resolve-media-url";
import type { SupabaseClient } from "@supabase/supabase-js";

const PROJECT = "https://abcxyz.supabase.co";
const ACCOUNT = "11111111-2222-3333-4444-555555555555";

function chatMediaUrl(path = `account-${ACCOUNT}/1700000000000-photo.png`) {
  return `${PROJECT}/storage/v1/object/public/chat-media/${path}`;
}
function flowMediaUrl(path = `account-${ACCOUNT}/1700000000000-node.png`) {
  return `${PROJECT}/storage/v1/object/public/flow-media/${path}`;
}

describe("parseAccountBucketPath", () => {
  it("parses a chat-media public URL", () => {
    const path = `account-${ACCOUNT}/1700000000000-photo.png`;
    expect(parseAccountBucketPath(chatMediaUrl(path))).toEqual({
      bucket: "chat-media",
      path,
    });
  });

  it("parses a flow-media public URL", () => {
    const path = `account-${ACCOUNT}/1700000000000-node.png`;
    expect(parseAccountBucketPath(flowMediaUrl(path))).toEqual({
      bucket: "flow-media",
      path,
    });
  });

  it("returns null for a Meta-hosted inbound URL", () => {
    expect(
      parseAccountBucketPath("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc123"),
    ).toBeNull();
  });

  it("returns null for the avatars bucket (deliberately public, out of scope)", () => {
    expect(
      parseAccountBucketPath(`${PROJECT}/storage/v1/object/public/avatars/user-1/pic.png`),
    ).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseAccountBucketPath("")).toBeNull();
    expect(parseAccountBucketPath("not a url")).toBeNull();
    expect(parseAccountBucketPath(`${PROJECT}/storage/v1/object/public/chat-media/`)).toBeNull();
  });
});

function mockSupabaseWithSignedUrl(signedUrl: string | null, errMsg?: string) {
  const createSignedUrl = vi.fn().mockResolvedValue(
    errMsg
      ? { data: null, error: { message: errMsg } }
      : { data: { signedUrl }, error: null },
  );
  const from = vi.fn(() => ({ createSignedUrl }));
  const supabase = { storage: { from } } as unknown as SupabaseClient;
  return { supabase, from, createSignedUrl };
}

describe("resolveSignedMediaUrl", () => {
  it("passes through a Meta-hosted URL unchanged and never calls createSignedUrl", async () => {
    const { supabase, createSignedUrl } = mockSupabaseWithSignedUrl("unused");
    const inbound = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc123";
    const result = await resolveSignedMediaUrl(supabase, inbound, MEDIA_SIGNED_URL_TTL_SECONDS);
    expect(result).toBe(inbound);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("calls createSignedUrl with the parsed path and the given TTL for a recognized URL", async () => {
    const signed = `${PROJECT}/storage/v1/object/sign/chat-media/account-x/photo.png?token=abc`;
    const { supabase, from, createSignedUrl } = mockSupabaseWithSignedUrl(signed);
    const path = `account-${ACCOUNT}/1700000000000-photo.png`;
    const result = await resolveSignedMediaUrl(supabase, chatMediaUrl(path), MEDIA_SIGNED_URL_TTL_SECONDS_UI);
    expect(from).toHaveBeenCalledWith("chat-media");
    expect(createSignedUrl).toHaveBeenCalledWith(path, MEDIA_SIGNED_URL_TTL_SECONDS_UI);
    expect(result).toBe(signed);
  });

  it("resolves a flow-media URL the same way", async () => {
    const signed = `${PROJECT}/storage/v1/object/sign/flow-media/account-x/node.png?token=xyz`;
    const { supabase, from, createSignedUrl } = mockSupabaseWithSignedUrl(signed);
    const path = `account-${ACCOUNT}/1700000000000-node.png`;
    const result = await resolveSignedMediaUrl(supabase, flowMediaUrl(path), MEDIA_SIGNED_URL_TTL_SECONDS);
    expect(from).toHaveBeenCalledWith("flow-media");
    expect(createSignedUrl).toHaveBeenCalledWith(path, MEDIA_SIGNED_URL_TTL_SECONDS);
    expect(result).toBe(signed);
  });

  it("throws (does not silently return the broken public URL) when Storage errors", async () => {
    const { supabase } = mockSupabaseWithSignedUrl(null, "permission denied");
    await expect(
      resolveSignedMediaUrl(supabase, chatMediaUrl(), MEDIA_SIGNED_URL_TTL_SECONDS),
    ).rejects.toThrow(/permission denied/);
  });
});
