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
