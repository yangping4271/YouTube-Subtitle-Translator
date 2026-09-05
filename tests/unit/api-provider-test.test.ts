import { afterEach, expect, it, vi } from 'vitest';
import { testApiProvider } from '../../src/extension/config';
import type { ApiProviderConfig } from '../../src/types';

const provider: ApiProviderConfig = {
  id: 'custom-test', name: 'Test', providerType: 'custom',
  openaiBaseUrl: 'https://example.com/codex/v1', openaiApiKey: 'test-only-key',
  llmModel: 'chosen-model', threadNum: 1, disableThinking: true,
};
afterEach(() => vi.unstubAllGlobals());

it('以当前模型实际调用 Chat，保留自定义路径与鉴权', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
  vi.stubGlobal('fetch', fetchMock);
  await expect(testApiProvider(provider)).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledWith('https://example.com/codex/v1/chat/completions', expect.objectContaining({
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only-key' },
    body: expect.any(String),
  }));
  const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body.model).toBe('chosen-model');
  expect(body.messages).toHaveLength(2);
});

it('模型列表可访问但模型路由不存在时测试必须失败', async () => {
  const fetchMock = vi.fn(async (url: string) => url.endsWith('/models')
    ? new Response(JSON.stringify({ data: [] }))
    : new Response(JSON.stringify({ error: { message: 'no route available for the requested model' } }), { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(testApiProvider(provider)).rejects.toThrow('HTTP 404');
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('200 返回模型列表或其他非 Chat 内容不能算调用成功', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'chosen-model' }] }))));
  await expect(testApiProvider(provider)).rejects.toThrow('API 返回内容为空');
});

it('空模型在发请求前拒绝，兼容服务允许空 Key', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
  vi.stubGlobal('fetch', fetchMock);
  await expect(testApiProvider({ ...provider, llmModel: '' })).rejects.toThrow('请填写翻译模型');
  expect(fetchMock).not.toHaveBeenCalled();
  await testApiProvider({ ...provider, openaiApiKey: '' });
  expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({headers: {'Content-Type': 'application/json'}}));
});
