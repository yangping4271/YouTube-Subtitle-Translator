import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireYouTubeSubtitles } from '../../src/extension/youtube-subtitle-fetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('字幕获取跨视频导航', () => {
  it('翻译、复制和下载共用的获取链路使用当前视频参数，不展开面板', async () => {
    const listeners = new Map<string, Set<(event: any) => unknown>>();
    const page = {
      setTimeout, clearTimeout,
      location: { search: '?v=NSqlZ1L81nQ' },
      ytInitialData: {
        updateEngagementPanelContentCommand: {
          contentSourcePanelIdentifier: { tag: 'PAmodern_transcript_view' },
          globalConfiguration: { params: 'qgkPCgtiT0MzRGlzRU9mZxgB' },
        },
      },
      ytcfg: { get: (key: string) => key === 'INNERTUBE_CONTEXT' ? { client: {} } : undefined },
      addEventListener(type: string, callback: (event: any) => unknown) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(callback);
      },
      removeEventListener(type: string, callback: (event: any) => unknown) {
        listeners.get(type)?.delete(callback);
      },
      dispatchEvent(event: { type: string }) {
        for (const callback of listeners.get(event.type) || []) void callback(event);
        return true;
      },
      postMessage(data: unknown) {
        this.dispatchEvent({ type: 'message', data, source: page } as any);
      },
    };
    const click = vi.fn();
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', {
      cookie: '',
      querySelectorAll: () => [],
      querySelector: () => ({ click }),
      getElementById: () => ({
        getVideoData: () => ({ video_id: 'NSqlZ1L81nQ' }),
        getPlayerResponse: () => ({ captions: {
          playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] },
        } }),
      }),
    });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      const params = JSON.parse(String(options.body)).params;
      expect(atob(params).slice(5, 16)).toBe('NSqlZ1L81nQ');
      return { ok: true, json: async () => ({ content: {
        transcriptSegmentViewModel: { timestamp: '0:01', simpleText: 'New video content' },
      } }) };
    });
    vi.stubGlobal('fetch', fetch);
    await import('../../src/extension/inject.js');

    await expect(acquireYouTubeSubtitles('NSqlZ1L81nQ')).resolves.toMatchObject({
      source: 'transcript-api',
      subtitles: [{ startTime: 1, text: 'New video content' }],
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });
});
