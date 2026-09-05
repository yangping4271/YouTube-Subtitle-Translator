import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface OverlayHarness {
  currentVideo: EventTarget;
  isEnabled: boolean;
  englishSubtitles: Array<{ startTime: number; endTime: number; text: string }>;
  chineseSubtitles: Array<{ startTime: number; endTime: number; text: string }>;
  setupVideoListeners(): void;
  loadBilingualSubtitles(english: OverlayHarness['englishSubtitles'], chinese: OverlayHarness['chineseSubtitles'], append?: boolean): void;
  updateSubtitle: ReturnType<typeof vi.fn>;
  startSubtitleSyncLoop: ReturnType<typeof vi.fn>;
  stopSubtitleSyncLoop: ReturnType<typeof vi.fn>;
  hideSubtitle: ReturnType<typeof vi.fn>;
}

let overlay: OverlayHarness;
beforeEach(async () => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { readyState: 'loading', addEventListener() {} });
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({})) } });
  const { YouTubeSubtitleOverlay } = await import('../../src/extension/content.js');
  overlay = Object.assign(Object.create(YouTubeSubtitleOverlay.prototype), {
    currentVideo: new EventTarget(),
    overlayElement: {},
    isEnabled: true,
    englishSubtitles: [], chineseSubtitles: [],
    updateSubtitle: vi.fn(), startSubtitleSyncLoop: vi.fn(),
    stopSubtitleSyncLoop: vi.fn(), hideSubtitle: vi.fn(),
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('字幕叠层', () => {
  it('重复加载不重复绑定，换播放器后旧播放器不再驱动字幕', () => {
    const oldVideo = overlay.currentVideo;
    overlay.setupVideoListeners();
    overlay.setupVideoListeners();
    overlay.updateSubtitle.mockClear();
    oldVideo.dispatchEvent(new Event('timeupdate'));
    expect(overlay.updateSubtitle).toHaveBeenCalledOnce();

    overlay.currentVideo = new EventTarget();
    overlay.setupVideoListeners();
    overlay.updateSubtitle.mockClear();
    oldVideo.dispatchEvent(new Event('timeupdate'));
    oldVideo.dispatchEvent(new Event('ended'));
    expect(overlay.updateSubtitle).not.toHaveBeenCalled();
    expect(overlay.hideSubtitle).not.toHaveBeenCalled();
    overlay.currentVideo.dispatchEvent(new Event('seeked'));
    expect(overlay.updateSubtitle).toHaveBeenCalledOnce();
  });

  it('partial 按时间合并，最终结果完整替换，并重新启用字幕', () => {
    const first = { startTime: 1, endTime: 2, text: 'first' };
    const second = { startTime: 3, endTime: 4, text: 'second' };
    overlay.isEnabled = false;
    overlay.loadBilingualSubtitles([second], [second], true);
    overlay.loadBilingualSubtitles([first], [first], true);
    expect(overlay.isEnabled).toBe(true);
    expect(overlay.englishSubtitles).toEqual([first, second]);
    expect(overlay.chineseSubtitles).toEqual([first, second]);
    overlay.loadBilingualSubtitles([first], [second]);
    expect(overlay.englishSubtitles).toEqual([first]);
    expect(overlay.chineseSubtitles).toEqual([second]);
  });
});
