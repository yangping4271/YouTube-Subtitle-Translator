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
    setupResizeListener: vi.fn(), repositionSubtitle: vi.fn(), updateSubtitle: vi.fn(), startSubtitleSyncLoop: vi.fn(),
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

it('重复帧不写 DOM、不读取布局，重叠字幕和跳转保持倒序选择语义', async () => {
  const { YouTubeSubtitleOverlay } = await import('../../src/extension/content.js');
  const writes = vi.fn();
  const element = () => {
    let text = '';
    return {
      get textContent() { return text; },
      set textContent(value: string) { writes(); text = value; },
      style: new Proxy({} as Record<string, string>, { set(target, key: string, value) {
        writes(); target[key] = value; return true;
      } }),
    };
  };
  const english = element();
  const chinese = element();
  const container = element();
  const video = { currentTime: 1, getBoundingClientRect: vi.fn() };
  const instance = Object.assign(Object.create(YouTubeSubtitleOverlay.prototype), {
    currentVideo: video, overlayElement: container, englishElement: english,
    chineseElement: chinese, isEnabled: true, isMiniPlayer: false,
    englishSubtitles: [
      { startTime: 0, endTime: 10, text: 'outer' },
      { startTime: 2, endTime: 4, text: 'inner' },
    ], chineseSubtitles: [],
  });
  instance.updateSubtitle();
  expect(english.textContent).toBe('outer');
  writes.mockClear();
  instance.updateSubtitle();
  expect(writes).not.toHaveBeenCalled();
  expect(video.getBoundingClientRect).not.toHaveBeenCalled();
  video.currentTime = 2;
  instance.updateSubtitle();
  expect(english.textContent).toBe('inner');
  video.currentTime = 4;
  instance.updateSubtitle();
  expect(english.textContent).toBe('outer');
  video.currentTime = 2;
  instance.updateSubtitle();
  expect(english.textContent).toBe('inner');
  instance.isMiniPlayer = true;
  instance.updateOverlayVisibility();
  expect(container.style.display).toBe('none');
  instance.updateSubtitle();
  expect(container.style.display).toBe('none');
  instance.isMiniPlayer = false;
  instance.updateOverlayVisibility();
  expect(container.style.display).toBe('block');
  video.currentTime = 10;
  instance.updateSubtitle();
  expect(container.style.display).toBe('none');
  writes.mockClear();
  instance.updateSubtitle();
  expect(writes).not.toHaveBeenCalled();
});

it('读取旧视频缓存时转换为中文字幕，后续双语结果完整替换旧内容', async () => {
  const { YouTubeSubtitleOverlay } = await import('../../src/extension/content.js');
  const legacy = [{ startTime: 0, endTime: 2, text: '旧字幕' }];
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({ subtitleEnabled: true }) } },
    runtime: { sendMessage: async () => ({ status: { cachedResult: { subtitleData: legacy } } }) },
  });
  const instance = Object.assign(Object.create(YouTubeSubtitleOverlay.prototype), {
    getVideoId: () => 'video', englishSubtitles: [], chineseSubtitles: [],
    englishSettings: {}, chineseSettings: {}, overlayElement: {}, currentVideo: {},
    repositionSubtitle: vi.fn(), applyLanguageStyles: vi.fn(), setupVideoListeners: vi.fn(), updateSubtitle: vi.fn(),
  });
  await instance.loadSubtitleData();
  expect(instance.chineseSubtitles).toEqual(legacy);
  expect(instance.isEnabled).toBe(true);
  expect(instance.updateSubtitle).toHaveBeenCalled();
  instance.loadBilingualSubtitles([{ startTime: 0, endTime: 2, text: 'new' }], []);
  expect(instance.chineseSubtitles).toEqual([]);
});


it('缓存提前绑定播放器后，全屏事件仍能驱动布局更新', async () => {
  vi.useFakeTimers();
  try {
    const { YouTubeSubtitleOverlay } = await import('../../src/extension/content.js');
    const page = new EventTarget();
    vi.stubGlobal('document', page);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const reposition = vi.fn();
    const instance = Object.assign(Object.create(YouTubeSubtitleOverlay.prototype), {
      currentVideo: new EventTarget(), overlayElement: {}, isEnabled: true,
      setupYouTubeStateListener: vi.fn(), repositionSubtitle: reposition,
      stopSubtitleSyncLoop: vi.fn(), startSubtitleSyncLoop: vi.fn(), updateSubtitle: vi.fn(),
    });
    instance.setupVideoListeners();
    instance.setupVideoListeners();
    page.dispatchEvent(new Event('fullscreenchange'));
    await vi.advanceTimersByTimeAsync(100);
    expect(reposition).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
