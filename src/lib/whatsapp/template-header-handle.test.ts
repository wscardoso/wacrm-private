import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Meta resumable upload so the helper is tested in isolation.
vi.mock('./meta-api', () => ({
  uploadResumableMedia: vi.fn(async () => ({ handle: 'HANDLE123' })),
}));

import { ensureImageHeaderHandle } from './template-header-handle';
import { uploadResumableMedia } from './meta-api';
import type { TemplatePayload } from './template-validators';
import type { SupabaseClient } from '@supabase/supabase-js';

function payload(over: Partial<TemplatePayload> = {}): TemplatePayload {
  return {
    name: 't',
    category: 'Utility',
    language: 'en_US',
    body_text: 'hi',
    header_type: 'image',
    header_media_url: 'https://x.test/img.jpg',
    ...over,
  };
}

// All existing tests here use an external, non-bucket URL
// (https://x.test/img.jpg), so `resolveSignedMediaUrl`'s pass-through path
// is taken and `.storage.from(...)` is never called — this stub throws if
// it ever is, doubling as an assertion of that.
const notCalledSupabase = {
  storage: {
    from: () => {
      throw new Error('should not be called for a non-bucket URL');
    },
  },
} as unknown as SupabaseClient;

function imgResponse(type = 'image/jpeg', size = 1024, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as Response;
}

describe('ensureImageHeaderHandle', () => {
  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is a no-op for non-image headers', async () => {
    const p = payload({ header_type: 'text', header_content: 'Hi' });
    await ensureImageHeaderHandle(p, 'tok', notCalledSupabase);
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('is a no-op when a handle already exists', async () => {
    const p = payload({ header_handle: 'existing' });
    await ensureImageHeaderHandle(p, 'tok', notCalledSupabase);
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBe('existing');
  });

  it('throws an actionable error when META_APP_ID is unset', async () => {
    const p = payload();
    await expect(ensureImageHeaderHandle(p, 'tok', notCalledSupabase)).rejects.toThrow(/META_APP_ID/);
  });

  it('derives + sets header_handle from a valid image URL', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/jpeg', 2048)));
    const p = payload();
    await ensureImageHeaderHandle(p, 'tok', notCalledSupabase);
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a non-image content type', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('text/html')));
    await expect(ensureImageHeaderHandle(payload(), 'tok', notCalledSupabase)).rejects.toThrow(/JPEG or PNG/);
  });

  it('rejects an image over 5 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/png', 6 * 1024 * 1024)));
    await expect(ensureImageHeaderHandle(payload(), 'tok', notCalledSupabase)).rejects.toThrow(/5 MB/);
  });

  it('resolves a chat-media URL to a signed URL before fetching', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    const fetchMock = vi.fn(async () => imgResponse('image/jpeg', 2048));
    vi.stubGlobal('fetch', fetchMock);
    const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: 'https://signed.example/x' }, error: null }));
    const supabase = { storage: { from: () => ({ createSignedUrl }) } } as unknown as SupabaseClient;
    const p = payload({
      header_media_url:
        'https://project.supabase.co/storage/v1/object/public/chat-media/account-abc/1-x.jpg',
    });
    await ensureImageHeaderHandle(p, 'tok', supabase);
    expect(createSignedUrl).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('https://signed.example/x');
    expect(p.header_handle).toBe('HANDLE123');
  });
});
