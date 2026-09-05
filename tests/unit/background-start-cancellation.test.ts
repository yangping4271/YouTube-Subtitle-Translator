import { afterEach, expect, it, vi } from 'vitest';

const coordinator = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(async () => {}) }));
vi.mock('../../src/extension/translator', () => ({
  BrowserTranslationCoordinator: class {
    start = coordinator.start;
    cancel = coordinator.cancel;
  },
  translationSessionAdapter: {},
}));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

it.each(['config', 'tab'])('后台等待 %s 时收到取消，不再提交翻译任务', async (stage) => {
  let release!: () => void;
  let reached!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  let listener!: (request: unknown, sender: unknown, respond: (result: unknown) => void) => void;
  vi.stubGlobal('chrome', {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(callback: typeof listener) { listener = callback; } },
    },
    storage: { local: {
      get: async () => ({}),
      set: async () => { if (stage === 'config') { reached(); await pending; } },
    } },
    tabs: { query: async () => { reached(); await pending; return [{ id: 1 }]; } },
  });
  await import('../../src/extension/background');
  const result = new Promise((resolve) => listener({
    action: 'startTranslation', videoId: 'video',
    subtitles: [{ text: 'hello', startTime: 0, endTime: 1 }],
    ...(stage === 'config' ? { apiConfig: {
      schemaVersion: 5, activeProviderId: 'openai',
      providers: [{ id: 'openai', llmModel: 'gpt-4.1-mini' }],
    } } : {}),
  }, stage === 'config' ? { tab: { id: 1 } } : {}, resolve));
  await waiting;
  await new Promise((resolve) => listener({ action: 'cancelTranslation', videoId: 'video' }, { tab: { id: 1 } }, resolve));
  release();
  expect(await result).toEqual({ success: false, error: '翻译已取消' });
  expect(coordinator.cancel).toHaveBeenCalledOnce();
  expect(coordinator.start).not.toHaveBeenCalled();
});
