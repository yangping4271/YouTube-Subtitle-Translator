import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../public/extension/popup.js', import.meta.url), 'utf8');
const format = runInNewContext(`${source}\nformatPopupError`, {
  window: { SubtitleConfig: {} },
  document: { addEventListener() {} },
}) as (error: unknown) => string;

describe('popup 错误提示', () => {
  it('余额不足不显示接口的原始 JSON', () => {
    expect(format('HTTP 402: {"error":{"message":"Insufficient Balance","type":"unknown_error"}}'))
      .toBe('API 余额不足，请充值或切换服务商。（HTTP 402）');
  });

  it.each([401, 403, 404, 429, 503])('常见 HTTP %i 提供状态码和操作建议', (status) => {
    expect(format(new Error(`HTTP ${status}: response`))).toContain(`HTTP ${status}`);
    expect(format(new Error(`HTTP ${status}: response`))).toContain('请');
  });

  it('未知 API 错误提取 message，保留状态码和业务错误说明', () => {
    expect(format('HTTP 400: {"error":{"message":"Model does not support this parameter","type":"invalid_request"}}'))
      .toBe('HTTP 400: Model does not support this parameter');
    expect(format('当前视频没有英文字幕，仅支持翻译英文字幕。'))
      .toBe('当前视频没有英文字幕，仅支持翻译英文字幕。');
  });
});
