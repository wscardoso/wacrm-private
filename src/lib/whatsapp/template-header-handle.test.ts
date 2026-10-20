import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A tenant-pasted URL is fetched through safeFetch; the global fetch is only
// for URLs Storage has just re-signed. Both are stubbed per test.
const h = vi.hoisted(() => ({
  safeFetch: undefined as undefined | ((url: string, init?: Record<string, unknown>) => Promise<Response>),
}));
vi.mock('@/lib/http/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http/safe-fetch')>()),
  safeFetch: (url: string, init?: Record<string, unknown>) => {
    if (!h.safeFetch) throw new Error('test did not install a safeFetch implementation');
    return h.safeFetch(url, init);
  },
}));
import { DestinationNotAllowedError, SafeFetchError } from '@/lib/http/safe-fetch';

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
    h.safeFetch = undefined;
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
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const safe = vi.fn(async () => imgResponse('image/jpeg', 2048));
    h.safeFetch = safe;
    const p = payload();
    await ensureImageHeaderHandle(p, 'tok', notCalledSupabase);
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(p.header_handle).toBe('HANDLE123');
    expect(safe).toHaveBeenCalledWith('https://x.test/img.jpg', { maxResponseBytes: 5 * 1024 * 1024 + 1 });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('rejects a non-image content type', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    h.safeFetch = async () => imgResponse('text/html');
    await expect(ensureImageHeaderHandle(payload(), 'tok', notCalledSupabase)).rejects.toThrow(/JPEG or PNG/);
  });

  it('rejects an image over 5 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    h.safeFetch = async () => imgResponse('image/png', 6 * 1024 * 1024);
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

  describe('tenant-pasted URLs go through safeFetch', () => {
    beforeEach(() => {
      vi.stubEnv('META_APP_ID', 'app-1');
    });

    it('a refused destination is a generic fetch failure, with nothing uploaded to Meta', async () => {
      const globalFetch = vi.fn();
      vi.stubGlobal('fetch', globalFetch);
      h.safeFetch = async () => {
        throw new DestinationNotAllowedError('address');
      };
      const error = await ensureImageHeaderHandle(
        payload({ header_media_url: 'https://internal.example/x.png' }),
        'tok',
        notCalledSupabase,
      ).catch((e) => e);
      expect(error.message).toBe('Could not fetch the header image URL. Make sure it is publicly reachable.');
      expect(error.message).not.toMatch(/allowed|private|address/i);
      expect(uploadResumableMedia).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled(); // no fallback to the unrestricted fetch
    });

    it('a redirect gets an actionable message and nothing is uploaded', async () => {
      h.safeFetch = async () => {
        throw new SafeFetchError('redirect', { status: 302 });
      };
      await expect(ensureImageHeaderHandle(payload(), 'tok', notCalledSupabase)).rejects.toThrow(/redirects/);
      expect(uploadResumableMedia).not.toHaveBeenCalled();
    });

    it('a response larger than the cap keeps the 5 MB message', async () => {
      h.safeFetch = async () => {
        throw new SafeFetchError('response_too_large');
      };
      await expect(ensureImageHeaderHandle(payload(), 'tok', notCalledSupabase)).rejects.toThrow(/5 MB/);
      expect(uploadResumableMedia).not.toHaveBeenCalled();
    });

    it.each([
      [new SafeFetchError('timeout')],
      [new SafeFetchError('network')],
      [new Error('boom')],
    ])('%s is a generic fetch failure', async (failure) => {
      h.safeFetch = async () => {
        throw failure;
      };
      await expect(ensureImageHeaderHandle(payload(), 'tok', notCalledSupabase)).rejects.toThrow(
        /Could not fetch the header image URL/,
      );
    });

    it('a non-2xx answer from the public host keeps its message', async () => {
      h.safeFetch = async () => imgResponse('image/png', 0, false, 404);
      await expect(ensureImageHeaderHandle(payload(), 'tok', notCalledSupabase)).rejects.toThrow(/returned 404/);
    });

    it('a pasted URL that merely LOOKS like our storage path is signed by Storage and fetched from the signed origin, never from the pasted host', async () => {
      const safe = vi.fn();
      h.safeFetch = safe;
      const fetchMock = vi.fn(async () => imgResponse('image/jpeg', 2048));
      vi.stubGlobal('fetch', fetchMock);
      const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: 'https://project.supabase.co/signed/x' }, error: null }));
      const supabase = { storage: { from: () => ({ createSignedUrl }) } } as unknown as SupabaseClient;
      await ensureImageHeaderHandle(
        payload({ header_media_url: 'http://169.254.169.254/storage/v1/object/public/chat-media/other-account/x.jpg' }),
        'tok',
        supabase,
      );
      expect(createSignedUrl).toHaveBeenCalledWith('other-account/x.jpg', expect.any(Number));
      expect(fetchMock).toHaveBeenCalledWith('https://project.supabase.co/signed/x');
      expect(safe).not.toHaveBeenCalled();
    });

    it('if Storage refuses to sign (RLS), nothing is fetched at all', async () => {
      const safe = vi.fn();
      h.safeFetch = safe;
      const globalFetch = vi.fn();
      vi.stubGlobal('fetch', globalFetch);
      const createSignedUrl = vi.fn(async () => ({ data: null, error: { message: 'denied' } }));
      const supabase = { storage: { from: () => ({ createSignedUrl }) } } as unknown as SupabaseClient;
      await expect(
        ensureImageHeaderHandle(
          payload({ header_media_url: 'https://x.test/storage/v1/object/public/chat-media/other/x.jpg' }),
          'tok',
          supabase,
        ),
      ).rejects.toThrow(/Could not resolve header image URL/);
      expect(safe).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
    });
  });
});
