import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('同一个按钮根据翻译状态启动或取消，每次点击只执行一个操作', () => {
  const button = Object.assign(new EventTarget(), {
    onclick: null as (() => void) | null,
    style: {}, classList: { add() {}, remove() {} },
  });
  const click = () => {
    button.dispatchEvent(new Event('click'));
    button.onclick?.();
  };
  const Popup = runInNewContext(
    `${readFileSync(new URL('../../public/extension/popup.js', import.meta.url), 'utf8')}\nPopupController`,
    { window: { SubtitleConfig: {} }, document: { addEventListener() {}, getElementById: () => button } }
  );
  const controller = Object.assign(Object.create(Popup.prototype), {
    isTranslating: false, startTranslation: vi.fn(), forceResetTranslation: vi.fn(),
  });
  controller.bindTranslateEvents();
  click();
  expect(controller.startTranslation).toHaveBeenCalledOnce();
  controller.showTranslationProgress({ current: 1, total: 3, step: 'translate' });
  click();
  expect(controller.forceResetTranslation).toHaveBeenCalledOnce();
  expect(controller.startTranslation).toHaveBeenCalledOnce();
  controller.isTranslating = false;
  click();
  expect(controller.startTranslation).toHaveBeenCalledTimes(2);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

it.each(['permission', 'video', 'subtitles', 'tabs', 'info', 'start'])(
  '取消使等待 %s 的旧流程失效，迟到响应不会启动翻译或修改 UI', async (stage) => {
    const pending = deferred<unknown>();
    const reached = deferred<void>();
    const wait = (name: string, value: unknown) => {
      if (stage !== name) return Promise.resolve(value);
      reached.resolve();
      return pending.promise;
    };
    const button = { style: {}, classList: { add() {}, remove() {} }, textContent: '' };
    const sendMessage = vi.fn(async (message) => message.action === 'startTranslation'
      ? wait('start', { success: true }) : { success: true });
    const Popup = runInNewContext(
      `${readFileSync(new URL('../../public/extension/popup.js', import.meta.url), 'utf8')}\nPopupController`,
      {
        window: { SubtitleConfig: {} },
        document: { addEventListener() {}, getElementById: () => button },
        chrome: { runtime: { sendMessage }, tabs: {
          query: () => wait('tabs', [{ id: 1 }]),
          sendMessage: (_id: number, _message: unknown, callback: (value: unknown) => void) => {
            void wait('info', { title: 'video' }).then(callback);
          },
        } },
      }
    );
    let videoCalls = 0;
    const controller = Object.assign(Object.create(Popup.prototype), {
      apiConfig: { openaiBaseUrl: 'https://example.com', targetLanguage: 'zh' },
      collectActiveProviderFromUI() {}, getActiveApiProvider() {},
      requestApiHostPermission: () => wait('permission', undefined),
      getCurrentVideoId: () => ++videoCalls === 1 ? wait('video', 'video') : Promise.resolve('video'),
      fetchYouTubeSubtitles: () => wait('subtitles', [{ text: 'hello', startTime: 0, endTime: 1 }]),
      updateTranslateButton: vi.fn(), startProgressListener: vi.fn(),
    });
    const starting = controller.startTranslation();
    await reached.promise;
    await controller.forceResetTranslation();
    const cancelledText = button.textContent;
    const values: Record<string, unknown> = {
      permission: undefined, video: 'video', subtitles: [{ text: 'hello' }],
      tabs: [{ id: 1 }], info: { title: 'video' }, start: { success: true },
    };
    pending.resolve(values[stage]);
    await starting;
    expect(sendMessage.mock.calls.map(([message]) => message.action)).toEqual(
      stage === 'start' ? ['startTranslation', 'cancelTranslation'] : ['cancelTranslation']
    );
    expect(controller.startProgressListener).not.toHaveBeenCalled();
    expect(button.textContent).toBe(cancelledText);
    expect(controller.isTranslating).toBe(false);
  }
);

it('取消后旧字幕请求失败不会覆盖新任务状态', async () => {
  const old = deferred<unknown>();
  const reached = deferred<void>();
  const Popup = runInNewContext(
    `${readFileSync(new URL('../../public/extension/popup.js', import.meta.url), 'utf8')}\nPopupController`,
    { window: { SubtitleConfig: {} }, document: { addEventListener() {}, getElementById: () => null },
      chrome: { runtime: { sendMessage: async () => ({ success: true }) } } }
  );
  const controller = Object.assign(Object.create(Popup.prototype), {
    apiConfig: { openaiBaseUrl: 'https://example.com' },
    collectActiveProviderFromUI() {}, getActiveApiProvider() {},
    requestApiHostPermission: async () => {}, getCurrentVideoId: async () => 'video',
    fetchYouTubeSubtitles: () => { reached.resolve(); return old.promise; },
    updateTranslateButton: vi.fn(),
  });
  const starting = controller.startTranslation();
  await reached.promise;
  await controller.forceResetTranslation();
  controller._translationOperation = {};
  controller.isTranslating = true;
  old.reject(new Error('late failure'));
  await starting;
  expect(controller.isTranslating).toBe(true);
  expect(controller.updateTranslateButton).toHaveBeenCalledOnce();
});
