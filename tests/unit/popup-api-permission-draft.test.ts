import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import type { ApiConfig, ApiProviderConfig } from '../../src/types';
import * as apiConfig from '../../src/utils/api-config';
import { getApiHostPermissionPattern } from '../../src/extension/config-bridge';

const source = readFileSync(new URL('../../public/extension/popup.js', import.meta.url), 'utf8');

function harness() {
  const stored: { apiConfig: ApiConfig; apiPermissionDraft?: { apiConfig: ApiConfig; newApiProviderDraft: ApiProviderConfig | null } } = {
    apiConfig: apiConfig.normalizeApiConfig({}),
  };
  let permissionCallback: (granted: boolean) => void = () => {};
  let opened!: () => void;
  const permissionOpened = new Promise<void>(resolve => { opened = resolve; });
  const storage = {
    get: vi.fn(async () => structuredClone(stored)),
    set: vi.fn(async (items) => { Object.assign(stored, structuredClone(items)); }),
    remove: vi.fn(async (key: string) => { delete stored[key as 'apiPermissionDraft']; }),
  };
  const request = vi.fn((_options, callback) => {
    permissionCallback = callback;
    opened();
  });
  const Popup = runInNewContext(`${source}\nToast.success = () => {}; Toast.error = () => {}; PopupController`, {
    window: { SubtitleConfig: { ...apiConfig, getApiHostPermissionPattern } },
    document: { addEventListener() {}, getElementById: () => null },
    chrome: { storage: { local: storage }, runtime: {}, permissions: { request } },
  });
  const create = () => Object.assign(Object.create(Popup.prototype), {
    apiConfig: structuredClone(stored.apiConfig), newApiProviderDraft: null,
    loadApiConfigToUI: vi.fn(), showApiStatus: vi.fn(),
    collectActiveProviderFromUI(this: { getEditingApiProvider(): ApiProviderConfig | null }) { return this.getEditingApiProvider(); },
  });
  const controller = create();
  controller.newApiProviderDraft = controller.createDefaultApiProvider({
    id: 'custom-test', name: 'Test provider', openaiBaseUrl: 'https://example.com/v1',
    openaiApiKey: 'test-only-key', llmModel: 'test-model', threadNum: 7,
  });
  return { controller, create, stored, storage, request, permissionOpened,
    grant: (granted: boolean) => permissionCallback(granted) };
}

it.each(['save', 'test'])('%s 授权窗口关闭 popup 后，新实例恢复完整草稿且不改生效配置', async (action) => {
  const h = harness();
  const original = structuredClone(h.stored.apiConfig);
  const draft = structuredClone(h.controller.newApiProviderDraft);
  // 原 popup 在权限回调前被销毁，后续代码永远不执行。
  void (action === 'save' ? h.controller.saveApiConfigFromUI() : h.controller.testApiConnection());
  await h.permissionOpened;
  const reopened = h.create();
  await reopened.loadApiConfig();
  expect(reopened.newApiProviderDraft).toEqual(draft);
  expect(reopened.hasApiPermissionDraft).toBe(true);
  expect(h.stored.apiConfig).toEqual(original);
  expect(h.request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] }, expect.any(Function));
});

it('拒绝授权后仍可恢复，再次保存成功后只添加一次并清除草稿', async () => {
  const h = harness();
  const firstSave = h.controller.saveApiConfigFromUI();
  await h.permissionOpened;
  h.grant(false);
  await firstSave;
  const reopened = h.create();
  await reopened.loadApiConfig();
  expect(reopened.newApiProviderDraft.openaiApiKey).toBe('test-only-key');
  h.request.mockImplementation((_options, callback) => callback(true));
  await reopened.saveApiConfigFromUI();
  expect(h.stored.apiConfig.activeProviderId).toBe('custom-test');
  expect(h.stored.apiConfig.providers?.filter((p: {id: string}) => p.id === 'custom-test')).toHaveLength(1);
  expect(h.stored.apiPermissionDraft).toBeUndefined();
  const saved = h.create();
  await saved.loadApiConfig();
  expect(saved.newApiProviderDraft).toBeNull();
  expect(saved.getActiveApiProvider().openaiApiKey).toBe('test-only-key');
});

it('草稿写入失败时不弹出权限窗口，保留当前表单', async () => {
  const h = harness();
  h.storage.set.mockRejectedValueOnce(new Error('storage failed'));
  await h.controller.saveApiConfigFromUI();
  expect(h.request).not.toHaveBeenCalled();
  expect(h.controller.newApiProviderDraft.llmModel).toBe('test-model');
});

it('删除自定义供应商后立即持久化，重开 popup 不再出现', async () => {
  const h = harness();
  h.stored.apiConfig = apiConfig.normalizeApiConfig({
    schemaVersion: apiConfig.API_CONFIG_SCHEMA_VERSION,
    activeProviderId: 'custom-test',
    providers: [{
      id: 'custom-test',
      name: 'Test provider',
      openaiBaseUrl: 'https://example.com/v1',
      openaiApiKey: 'test-only-key',
      llmModel: 'test-model',
    }],
  });

  const controller = h.create();
  await controller.deleteActiveApiProvider();

  expect(h.stored.apiConfig.activeProviderId).toBeUndefined();
  expect(h.stored.apiConfig.providers?.some((provider: { id: string }) => provider.id === 'custom-test')).toBe(false);

  const reopened = h.create();
  await reopened.loadApiConfig();
  expect(reopened.apiConfig.providers?.some((provider: { id: string }) => provider.id === 'custom-test')).toBe(false);
  expect(reopened.getActiveApiProvider()).toBeNull();
});
