import { describe, expect, it } from 'vitest';

import {
  rewriteTranscriptParamsVideoId,
  rewriteTranscriptPanelParamsVideoId,
} from '../../src/core/youtube-transcript-params.js';

describe('新版 YouTube transcript panel params', () => {
  it('切换视频后替换嵌套 videoId，保留面板选项', () => {
    const rewritten = rewriteTranscriptPanelParamsVideoId(
      'qgkPCgtiT0MzRGlzRU9mZxgB', 'NSqlZ1L81nQ'
    );
    const decoded = atob(rewritten!);
    expect(decoded.slice(5, 16)).toBe('NSqlZ1L81nQ');
    expect(decoded.slice(16)).toBe('\u0018\u0001');
    expect(decoded.slice(0, 5)).toBe('\u00aa\u0009\u000f\u000a\u000b');
  });

  it.each(['invalid', '', 'CgtiT0MzRGlzRU9mZw==', 'qgkPCgtiT0Mz'])('未知或截断参数不发送请求：%s', (params) => {
    expect(rewriteTranscriptPanelParamsVideoId(params, 'NSqlZ1L81nQ')).toBeNull();
  });
});

describe('YouTube transcript params', () => {
  it('将 SPA 遗留参数中的旧 videoId 替换为当前 videoId', () => {
    const suffix = Uint8Array.from([0x12, 0x02, 0x65, 0x6e]);
    const oldVideoId = 'B04a3us4a9I';
    const bytes = Uint8Array.from([
      0x0a,
      oldVideoId.length,
      ...Array.from(oldVideoId, (character) => character.charCodeAt(0)),
      ...suffix,
    ]);
    let binary = '';
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });

    const rewritten = rewriteTranscriptParamsVideoId(
      btoa(binary),
      'syML5KT-HzI'
    );

    expect(rewritten).not.toBeNull();
    const decoded = atob(
      rewritten!.replace(/-/g, '+').replace(/_/g, '/')
        .padEnd(Math.ceil(rewritten!.length / 4) * 4, '=')
    );
    expect(decoded.slice(2, 13)).toBe('syML5KT-HzI');
    expect(
      Array.from(decoded.slice(13), (character) => character.charCodeAt(0))
    ).toEqual(Array.from(suffix));
  });

  it('拒绝未知参数结构', () => {
    expect(rewriteTranscriptParamsVideoId('invalid', 'syML5KT-HzI')).toBeNull();
  });

  it('同时替换当前字幕轨类型和语言', () => {
    const params =
      'CgtzeU1MNUtULUh6SRIOQ2dBU0FtVnVHZ0ElM0QYASozZW5nYWdlbWVudC1wYW5lbC1zZWFyY2hhYmxlLXRyYW5zY3JpcHQtc2VhcmNoLXBhbmVsMAA4AUAA';
    const rewritten = rewriteTranscriptParamsVideoId(
      params,
      'B04a3us4a9I',
      'en',
      'asr'
    );

    expect(rewritten).not.toBeNull();
    const outer = atob(
      rewritten!.replace(/-/g, '+').replace(/_/g, '/')
        .padEnd(Math.ceil(rewritten!.length / 4) * 4, '=')
    );
    expect(outer.slice(2, 13)).toBe('B04a3us4a9I');
    expect(outer).toContain('CgNhc3ISAmVuGgA%3D');
  });
});
