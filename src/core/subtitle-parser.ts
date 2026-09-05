import { normalizeSubtitleText } from './subtitle-acquisition.js';

/**
 * YouTube SubtitlePlus - 字幕解析器
 * 提供统一的字幕文件解析功能，支持 SRT
 */

import type { SimpleSubtitleEntry } from '../types';

export class SubtitleParser {
  /**
   * 解析 SRT 格式字幕
   */
  static parseSRT(content: string): SimpleSubtitleEntry[] {
    const subtitles: SimpleSubtitleEntry[] = [];
    const blocks = content.trim().split(/\n\s*\n/);

    blocks.forEach((block) => {
      const lines = block.trim().split('\n');
      if (lines.length >= 3) {
        const timeMatch = lines[1].match(
          /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/
        );
        if (timeMatch) {
          const startTime = this.parseTime(
            timeMatch[1],
            timeMatch[2],
            timeMatch[3],
            timeMatch[4]
          );
          const endTime = this.parseTime(
            timeMatch[5],
            timeMatch[6],
            timeMatch[7],
            timeMatch[8]
          );
          const text = normalizeSubtitleText(
            lines
              .slice(2)
              .join('\n')
              .replace(/<[^>]*>/g, '')
          );

          if (text.length > 0) {
            subtitles.push({ startTime, endTime, text });
          }
        }
      }
    });

    return subtitles;
  }

  /**
   * 解析通用时间格式（SRT 标准）
   * @returns 时间（秒，浮点数）
   */
  static parseTime(
    hours: string,
    minutes: string,
    seconds: string,
    milliseconds: string
  ): number {
    return (
      parseInt(hours) * 3600 +
      parseInt(minutes) * 60 +
      parseInt(seconds) +
      parseInt(milliseconds) / 1000
    );
  }
}
