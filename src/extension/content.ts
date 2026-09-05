/**
 * YouTube Subtitle Extension - Content Script
 * 在 YouTube 页面上叠加字幕的核心逻辑
 */

import { getDefaultEnglishSettings, getDefaultChineseSettings, getDefaultConfig } from './config';
import { getVideoInfo } from './transcript-core';
import { acquireYouTubeSubtitles } from './youtube-subtitle-fetch';
import type { SimpleSubtitleEntry, SubtitleStyleSettings, VideoSubtitleData } from '../types';
import {
  isTranslationPublicationForVideo,
  TranslationRunGate,
  type TranslationRunEvent,
} from './translation-run-gate';

// Chrome API 类型声明
declare const chrome: {
  runtime: {
    id?: string;
    sendMessage: (message: unknown) => Promise<{ success: boolean;[key: string]: unknown }>;
    onMessage: {
      addListener: (
        callback: (
          request: ChromeMessage,
          sender: unknown,
          sendResponse: (response: unknown) => void
        ) => boolean | void
      ) => void;
    };
  };
  storage: {
    local: {
      get: (keys: string | string[]) => Promise<Record<string, unknown>>;
      remove: (keys: string | string[]) => Promise<void>;
    };
  };
};

interface ChromeMessage {
  action: string;
  enabled?: boolean;
  englishSubtitles?: SimpleSubtitleEntry[];
  chineseSubtitles?: SimpleSubtitleEntry[];
  language?: 'english' | 'chinese';
  settings?: Partial<SubtitleStyleSettings>;
  videoId?: string;
  translationRunId?: string;
  translationRunEvent?: TranslationRunEvent;
}

export class YouTubeSubtitleOverlay {
  private englishSubtitles: SimpleSubtitleEntry[] = [];
  private chineseSubtitles: SimpleSubtitleEntry[] = [];
  private currentVideo: HTMLVideoElement | null = null;
  private overlayElement: HTMLElement | null = null;
  private englishElement: HTMLElement | null = null;
  private chineseElement: HTMLElement | null = null;
  private isMiniPlayer = false;
  private isEnabled = false;
  private readonly translationRunGate = new TranslationRunGate();

  private currentVideoId: string | null = null;

  private englishSettings: SubtitleStyleSettings;
  private chineseSettings: SubtitleStyleSettings;

  private enableDPRCompensation: boolean;
  private dprCompensationFactor: number;

  private videoListeners: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollListener: (() => void) | null = null;
  private fullscreenListener: (() => void) | null = null;
  private resizeWindowListener: (() => void) | null = null;
  private youtubeStateObserver: MutationObserver | null = null;
  private urlChangeObserver: MutationObserver | null = null;
  private subtitleSyncVideo: HTMLVideoElement | null = null;
  private subtitleVideoFrameRequestId: number | null = null;
  private subtitleAnimationFrameId: number | null = null;

  constructor() {
    this.englishSettings = getDefaultEnglishSettings();
    this.chineseSettings = getDefaultChineseSettings();

    const config = getDefaultConfig();
    this.enableDPRCompensation = config.dpr.enabled;
    this.dprCompensationFactor = this.calculateDPRCompensation(config.dpr.compensationFactor);

    this.init();
  }

  private calculateDPRCompensation(compensationFactor: number): number {
    const dpr = window.devicePixelRatio || 1;
    if (dpr <= 1) return 1.0;
    return 1 + (dpr - 1) * compensationFactor;
  }

  private init(): void {
    this.createOverlayElement();
    this.observeVideoChanges();
    this.loadSubtitleData();
    this.bindMessageListener();
    this.bindWindowMessageListener();
  }

  private async startTranslationFromPage(): Promise<void> {
    try {
      // 检查扩展上下文是否有效
      if (!chrome.runtime?.id) {
        this.showErrorNotification('扩展已重新加载，请刷新页面后再试');
        return;
      }

      // 获取视频ID
      const videoId = this.getVideoId();
      if (!videoId) {
        this.showErrorNotification('无法获取视频ID');
        return;
      }

      const statusResponse = await chrome.runtime.sendMessage({
        action: 'getTranslationStatus',
        videoId,
      });
      const status = statusResponse.status as { isTranslating?: boolean } | undefined;
      if (status?.isTranslating) {
        return;
      }

      // 获取字幕
      const subtitles = await this.fetchYouTubeOfficialSubtitles();
      if (!subtitles || subtitles.length === 0) {
        this.showErrorNotification('无法获取字幕');
        return;
      }

      // 获取完整的视频信息（包括说明和 AI 摘要）
      const videoInfo = getVideoInfo();

      const result = await chrome.storage.local.get(['apiConfig']);
      const apiConfig = result.apiConfig || {};
      const targetLanguage = (apiConfig as { targetLanguage?: string }).targetLanguage || 'zh';

      const response = await chrome.runtime.sendMessage({
        action: 'startTranslation',
        subtitles,
        targetLanguage,
        videoId,
        apiConfig,
        videoInfo,  // 传递完整的视频信息
      });
      if (!response.success) {
        throw new Error(String(response.error || '启动翻译失败'));
      }
    } catch (error) {
      // 检查是否是扩展上下文失效错误
      if (error instanceof Error && error.message.includes('Extension context invalidated')) {
        this.showErrorNotification('扩展已重新加载，请刷新页面后再试');
      } else if (error instanceof Error && error.message) {
        this.showErrorNotification(error.message);
      }
    }
  }

  private bindMessageListener(): void {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      switch (request.action) {
        case 'toggleSubtitle':
          this.toggleSubtitle(request.enabled || false);
          break;
        case 'loadBilingualSubtitles':
          if (!isTranslationPublicationForVideo(request.videoId, this.getVideoId())) break;
          if (!this.translationRunGate.accepts(request.translationRunId)) break;
          this.loadBilingualSubtitles(
            request.englishSubtitles || [],
            request.chineseSubtitles || []
          );
          break;
        case 'appendBilingualSubtitles':
          if (!isTranslationPublicationForVideo(request.videoId, this.getVideoId())) break;
          if (!this.translationRunGate.accepts(request.translationRunId)) break;
          this.loadBilingualSubtitles(
            request.englishSubtitles || [],
            request.chineseSubtitles || [],
            true
          );
          break;
        case 'clearData':
          if (request.translationRunEvent) {
            if (this.translationRunGate.apply(request.translationRunEvent)) {
              this.clearSubtitleData();
            }
          } else if (!request.translationRunId) {
            this.translationRunGate.apply({ type: 'reset' });
            this.clearSubtitleData();
          }
          break;
        case 'updateSettings':
          if (request.language && request.settings) {
            this.updateLanguageSettings(request.language, request.settings);
          }
          break;
        case 'getVideoInfo': {
          const videoId = this.getVideoId();
          const subtitleLoaded =
            this.englishSubtitles.length > 0 || this.chineseSubtitles.length > 0;
          const videoInfo = getVideoInfo();
          sendResponse({
            videoId,
            subtitleLoaded,
            title: videoInfo.ytTitle,
            description: videoInfo.description,
            aiSummary: videoInfo.aiSummary,
          });
          break;
        }
        case 'getSubtitleStatus': {
          const currentVideoId = this.getVideoId();
          const englishCount = this.englishSubtitles.length;
          const chineseCount = this.chineseSubtitles.length;
          const hasSubtitles = englishCount > 0 || chineseCount > 0;

          sendResponse({
            videoId: currentVideoId,
            hasSubtitles,
            englishCount,
            chineseCount,
            subtitleEnabled: this.isEnabled,
          });
          break;
        }
        case 'getYouTubeSubtitles':
          this.fetchYouTubeOfficialSubtitles()
            .then((subtitles) => {
              sendResponse({ success: true, subtitles });
            })
            .catch((error) => {
              sendResponse({ success: false, error: (error as Error).message });
            });
          return true;
        case 'startTranslationFromPage':
          this.startTranslationFromPage();
          break;
      }
    });
  }

  private bindWindowMessageListener(): void {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data.type === 'YTSP_StartTranslation') {
        this.startTranslationFromPage();
      }
    });
  }

  private async fetchYouTubeOfficialSubtitles(): Promise<SimpleSubtitleEntry[]> {
    const videoId = this.getVideoId();
    if (!videoId) {
      throw new Error('无法获取视频ID');
    }

    const result = await acquireYouTubeSubtitles(videoId);
    return result.subtitles;
  }

  private createOverlayElement(): void {
    this.overlayElement = document.createElement('div');
    this.overlayElement.id = 'youtube-local-subtitle-overlay';
    this.overlayElement.innerHTML = `
      <div class="subtitle-container">
        <div class="english-wrapper">
          <span class="english-subtitle" id="englishSubtitle"></span>
        </div>
        <div class="chinese-wrapper">
          <span class="chinese-subtitle" id="chineseSubtitle"></span>
        </div>
      </div>
    `;
    this.englishElement = this.overlayElement.querySelector('#englishSubtitle');
    this.chineseElement = this.overlayElement.querySelector('#chineseSubtitle');
    this.applyStyles();
  }

  private applyStyles(): void {
    if (!this.overlayElement) return;

    const mainStyles: Partial<CSSStyleDeclaration> = {
      position: 'absolute',
      zIndex: '40',
      display: 'none',
      left: '50%',
      transform: 'translateX(-50%)',
      bottom: '60px',
      pointerEvents: 'none',
      userSelect: 'none',
    };
    Object.assign(this.overlayElement.style, mainStyles);

    const container = this.overlayElement.querySelector('.subtitle-container') as HTMLElement;
    this.applyContainerFlexStyles(container);

    const englishWrapper = this.overlayElement.querySelector('.english-wrapper') as HTMLElement;
    const chineseWrapper = this.overlayElement.querySelector('.chinese-wrapper') as HTMLElement;

    this.applyWrapperStyles(englishWrapper);
    this.applyWrapperStyles(chineseWrapper);

    this.applyLanguageStyles('english');
    this.applyLanguageStyles('chinese');
  }

  private applyContainerFlexStyles(container: HTMLElement | null): void {
    if (container) {
      Object.assign(container.style, {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0px',
        width: '100%',
      });
    }
  }

  private applyWrapperStyles(wrapper: HTMLElement | null): void {
    if (wrapper) {
      Object.assign(wrapper.style, {
        display: 'block',
        textAlign: 'center',
        width: '100%',
        textWrap: 'balance',
      });
    }
  }

  private applyLanguageStyles(language: 'english' | 'chinese'): void {
    if (!this.overlayElement) return;

    const settings = language === 'english' ? this.englishSettings : this.chineseSettings;
    const element = language === 'english' ? this.englishElement : this.chineseElement;

    if (element && settings) {
      const baseFontSize = settings.fontSize;
      const compensatedFontSize = this.enableDPRCompensation
        ? Math.round(baseFontSize * this.dprCompensationFactor)
        : baseFontSize;

      Object.assign(element.style, {
        fontSize: compensatedFontSize + 'px',
        color: settings.fontColor,
        WebkitTextFillColor: settings.fontColor,
        fontFamily: settings.fontFamily,
        fontWeight: settings.fontWeight,
        WebkitTextStroke: settings.textStroke || 'none',
        paintOrder: 'stroke fill',
        textShadow: settings.textShadow !== 'none' ? settings.textShadow : 'none',
        lineHeight: String(settings.lineHeight),
        padding: '0 6px',
        borderRadius: '3px',
        display: element.textContent ? 'inline' : 'none',
        textAlign: 'center',
        whiteSpace: 'pre-wrap',
        wordBreak: 'normal',
        textWrap: 'balance',
        boxDecorationBreak: 'clone',
        WebkitBoxDecorationBreak: 'clone',
        maxWidth: '100%',
        boxSizing: 'border-box',
        margin: '0',
      });
    }
  }

  private observeVideoChanges(): void {
    let currentUrl = location.href;

    // 如果已存在 observer，先断开
    if (this.urlChangeObserver) {
      this.urlChangeObserver.disconnect();
    }

    this.urlChangeObserver = new MutationObserver(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        setTimeout(() => this.onVideoChange(), 1000);
      }
    });

    this.urlChangeObserver.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => this.onVideoChange(), 1000);
  }

  private onVideoChange(): void {
    const video = document.querySelector('video') as HTMLVideoElement;
    const videoElementChanged = video && video !== this.currentVideo;
    const newVideoId = this.getVideoId();
    const videoIdChanged = newVideoId && newVideoId !== this.currentVideoId;

    if (videoElementChanged) {
      this.currentVideo = video;
      this.setupVideoListeners();
      this.insertOverlayToPage();
    }

    if (videoIdChanged || videoElementChanged) {
      this.currentVideoId = newVideoId;
      this.hideSubtitle();
      this.englishSubtitles = [];
      this.chineseSubtitles = [];
      this.loadSubtitleData();
    }
  }

  private setupVideoListeners(): void {
    if (!this.currentVideo) return;

    this.setupResizeListener();

    this.stopSubtitleSyncLoop();

    this.videoListeners?.abort();
    this.videoListeners = new AbortController();
    const refresh = () => this.updateSubtitle();
    const resume = () => {
      this.updateSubtitle();
      this.startSubtitleSyncLoop();
    };
    const listeners = {
      timeupdate: refresh,
      seeking: refresh,
      play: resume,
      seeked: resume,
      ratechange: resume,
      pause: () => {
        this.stopSubtitleSyncLoop();
        this.updateSubtitle();
      },
      ended: () => {
        this.stopSubtitleSyncLoop();
        this.hideSubtitle();
      },
    };
    for (const [event, listener] of Object.entries(listeners)) {
      this.currentVideo.addEventListener(event, listener, { signal: this.videoListeners.signal });
    }

    if (this.isEnabled) {
      this.updateSubtitle();
      this.startSubtitleSyncLoop();
    }
  }

  private startSubtitleSyncLoop(): void {
    const video = this.currentVideo;
    if (!video || !this.isEnabled || video.paused || video.ended) {
      this.stopSubtitleSyncLoop();
      return;
    }

    this.stopSubtitleSyncLoop();
    this.subtitleSyncVideo = video;

    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick = (): void => {
        this.subtitleVideoFrameRequestId = null;

        if (video !== this.currentVideo || !this.isEnabled) {
          return;
        }

        this.updateSubtitle();

        if (!video.paused && !video.ended) {
          this.subtitleVideoFrameRequestId = video.requestVideoFrameCallback(() => {
            tick();
          });
        }
      };

      this.subtitleVideoFrameRequestId = video.requestVideoFrameCallback(() => {
        tick();
      });
      return;
    }

    const tick = (): void => {
      this.subtitleAnimationFrameId = null;

      if (video !== this.currentVideo || !this.isEnabled) {
        return;
      }

      this.updateSubtitle();

      if (!video.paused && !video.ended) {
        this.subtitleAnimationFrameId = window.requestAnimationFrame(tick);
      }
    };

    this.subtitleAnimationFrameId = window.requestAnimationFrame(tick);
  }

  private stopSubtitleSyncLoop(): void {
    if (
      this.subtitleSyncVideo &&
      this.subtitleVideoFrameRequestId !== null &&
      typeof this.subtitleSyncVideo.cancelVideoFrameCallback === 'function'
    ) {
      this.subtitleSyncVideo.cancelVideoFrameCallback(this.subtitleVideoFrameRequestId);
    }

    if (this.subtitleAnimationFrameId !== null) {
      window.cancelAnimationFrame(this.subtitleAnimationFrameId);
    }

    this.subtitleSyncVideo = null;
    this.subtitleVideoFrameRequestId = null;
    this.subtitleAnimationFrameId = null;
  }

  private setupResizeListener(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.scrollListener) {
      window.removeEventListener('scroll', this.scrollListener);
    }
    if (this.fullscreenListener) {
      document.removeEventListener('fullscreenchange', this.fullscreenListener);
    }
    if (this.resizeWindowListener) {
      window.removeEventListener('resize', this.resizeWindowListener);
    }

    const debounceReposition = this.debounce(() => {
      if (this.overlayElement && this.isEnabled) {
        this.repositionSubtitle();
      }
    }, 100);

    this.resizeObserver = new ResizeObserver(() => {
      debounceReposition();
    });

    this.scrollListener = () => {
      debounceReposition();
    };

    this.fullscreenListener = () => {
      setTimeout(() => {
        if (this.overlayElement && this.isEnabled) {
          this.repositionSubtitle();
        }
      }, 100);
    };

    this.resizeWindowListener = () => {
      debounceReposition();
    };

    this.setupYouTubeStateListener();

    if (this.currentVideo) {
      this.resizeObserver.observe(this.currentVideo);
    }
    window.addEventListener('scroll', this.scrollListener, { passive: true });
    document.addEventListener('fullscreenchange', this.fullscreenListener);
    window.addEventListener('resize', this.resizeWindowListener, { passive: true });
  }

  private debounce<T extends (...args: unknown[]) => void>(func: T, wait: number): T {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return ((...args: unknown[]) => {
      const later = () => {
        timeout = null;
        func(...args);
      };
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    }) as T;
  }

  private setupYouTubeStateListener(): void {
    if (this.youtubeStateObserver) {
      this.youtubeStateObserver.disconnect();
    }

    this.youtubeStateObserver = new MutationObserver((mutations) => {
      let needsReposition = false;

      mutations.forEach((mutation) => {
        if (
          mutation.type === 'attributes' &&
          (mutation.attributeName === 'class' || mutation.attributeName === 'theater')
        ) {
          needsReposition = true;
        }

        if (mutation.type === 'childList') {
          needsReposition = true;
        }
      });

      if (needsReposition && this.overlayElement && this.isEnabled) {
        setTimeout(() => this.repositionSubtitle(), 200);
      }
    });

    const targets = [
      document.querySelector('#movie_player'),
      document.querySelector('#masthead-container'),
      document.querySelector('#page-manager'),
      document.body,
    ].filter((el): el is Element => el !== null);

    targets.forEach((target) => {
      this.youtubeStateObserver!.observe(target, {
        attributes: true,
        attributeFilter: ['class', 'theater', 'fullscreen'],
        childList: true,
        subtree: false,
      });
    });
  }

  private repositionSubtitle(): void {
    if (!this.overlayElement || !this.currentVideo) return;

    const isFullscreen = document.fullscreenElement !== null;
    const isTheaterMode = document.querySelector('.ytp-size-large') !== null;
    this.isMiniPlayer = document.querySelector('.ytp-miniplayer-active') !== null;
    this.updateOverlayVisibility();

    const playerContainer = document.querySelector('#movie_player') as HTMLElement;

    if (isFullscreen) {
      this.overlayElement.style.position = 'fixed';
      this.overlayElement.style.left = '50%';
      this.overlayElement.style.transform = 'translateX(-50%)';
      this.overlayElement.style.bottom = '80px';
      this.overlayElement.style.width = '80%';
      this.overlayElement.style.maxWidth = 'none';
      this.overlayElement.style.zIndex = '9999';
    } else if (this.isMiniPlayer) {
      return;
    } else {
      this.overlayElement.style.position = 'absolute';
      this.overlayElement.style.zIndex = '40';

      if (playerContainer) {
        if (playerContainer.style.position !== 'relative') {
          playerContainer.style.position = 'relative';
        }

        this.overlayElement.style.left = '50%';
        this.overlayElement.style.transform = 'translateX(-50%)';
        this.overlayElement.style.bottom = isTheaterMode ? '70px' : '60px';
        this.overlayElement.style.width = '80%';
        this.overlayElement.style.maxWidth = 'none';

        if (!playerContainer.contains(this.overlayElement)) {
          playerContainer.appendChild(this.overlayElement);
        }
      } else {
        const videoRect = this.currentVideo.getBoundingClientRect();
        this.overlayElement.style.position = 'fixed';
        this.overlayElement.style.left = '50%';
        this.overlayElement.style.transform = 'translateX(-50%)';
        this.overlayElement.style.bottom = window.innerHeight - videoRect.bottom + 60 + 'px';
        this.overlayElement.style.width = Math.min(videoRect.width * 0.8, 800) + 'px';
        this.overlayElement.style.maxWidth = 'none';
      }
    }
  }

  private insertOverlayToPage(): void {
    const existingOverlay = document.getElementById('youtube-local-subtitle-overlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }

    const moviePlayer = document.querySelector('#movie_player') as HTMLElement;

    if (moviePlayer) {
      if (moviePlayer.style.position !== 'relative') {
        moviePlayer.style.position = 'relative';
      }

      if (this.overlayElement) {
        moviePlayer.appendChild(this.overlayElement);
      }
    } else {
      if (this.overlayElement) {
        document.body.appendChild(this.overlayElement);
      }
    }

    this.repositionSubtitle();
  }

  private updateSubtitle(): void {
    if (!this.currentVideo || !this.isEnabled || !this.overlayElement) {
      return;
    }

    const currentTime = this.currentVideo.currentTime;

    let englishText = '';
    let chineseText = '';

    if (this.englishSubtitles.length > 0) {
      const englishSubtitle = this.findCurrentSubtitle(currentTime, this.englishSubtitles);
      if (englishSubtitle) {
        englishText = englishSubtitle.text;
      }
    }

    if (this.chineseSubtitles.length > 0) {
      const chineseSubtitle = this.findCurrentSubtitle(currentTime, this.chineseSubtitles);
      if (chineseSubtitle) {
        chineseText = chineseSubtitle.text;
      }
    }

    if (englishText || chineseText) {
      this.showBilingualSubtitle(englishText, chineseText);
    } else {
      this.hideSubtitle();
    }
  }

  private showBilingualSubtitle(englishText: string, chineseText: string): void {
    for (const [element, text] of [
      [this.englishElement, englishText],
      [this.chineseElement, chineseText],
    ] as const) {
      if (element && element.textContent !== text) {
        element.textContent = text;
        element.style.display = text ? 'inline' : 'none';
      }
    }
    this.updateOverlayVisibility();
  }

  private updateOverlayVisibility(): void {
    if (!this.overlayElement) return;
    const visible = this.isEnabled && !this.isMiniPlayer &&
      !!(this.englishElement?.textContent || this.chineseElement?.textContent);
    const display = visible ? 'block' : 'none';
    if (this.overlayElement.style.display !== display) {
      this.overlayElement.style.display = display;
    }
  }

  private hideSubtitle(): void {
    this.showBilingualSubtitle('', '');
  }

  private showErrorNotification(message: string): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      z-index: 10000;
      display: flex;
      justify-content: center;
      align-items: center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background: #f44336;
      color: white;
      padding: 20px 30px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: bold;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    `;
    modal.textContent = message;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    setTimeout(() => overlay.remove(), 3000);
  }

  private findCurrentSubtitle(
    currentTime: number,
    subtitles: SimpleSubtitleEntry[]
  ): SimpleSubtitleEntry | undefined {
    for (let i = subtitles.length - 1; i >= 0; i--) {
      const subtitle = subtitles[i];
      if (currentTime >= subtitle.startTime && currentTime < subtitle.endTime) {
        return subtitle;
      }
    }

    return undefined;
  }

  private toggleSubtitle(enabled: boolean): void {
    this.isEnabled = enabled;

    if (!enabled) {
      this.stopSubtitleSyncLoop();
      this.hideSubtitle();
    } else {
      this.repositionSubtitle();
      if (
        this.englishSubtitles.length > 0 ||
        this.chineseSubtitles.length > 0
      ) {
        if (this.currentVideo) {
          this.updateSubtitle();
          this.startSubtitleSyncLoop();
        }
      }
    }
  }

  private loadBilingualSubtitles(
    englishSubtitles: SimpleSubtitleEntry[],
    chineseSubtitles: SimpleSubtitleEntry[],
    append = false
  ): void {
    if (append) {
      this.englishSubtitles.push(...englishSubtitles);
      this.chineseSubtitles.push(...chineseSubtitles);
      this.englishSubtitles.sort((a, b) => a.startTime - b.startTime);
      this.chineseSubtitles.sort((a, b) => a.startTime - b.startTime);
    } else {
      this.englishSubtitles = englishSubtitles;
      this.chineseSubtitles = chineseSubtitles;
    }

    if ((!append || !this.isEnabled) &&
      (this.englishSubtitles.length > 0 || this.chineseSubtitles.length > 0)) {
      this.isEnabled = true;
      this.currentVideo ||= document.querySelector('video');
      if (!this.overlayElement) {
        this.createOverlayElement();
        this.insertOverlayToPage();
      }
      void chrome.runtime.sendMessage({ action: 'setSubtitleEnabled', enabled: true });
      this.repositionSubtitle();
      this.setupVideoListeners();
    }
    this.updateSubtitle();
  }

  private clearSubtitleData(): void {
    this.stopSubtitleSyncLoop();
    this.englishSubtitles = [];
    this.chineseSubtitles = [];
    this.hideSubtitle();
  }


  private updateLanguageSettings(
    language: 'english' | 'chinese',
    settings: Partial<SubtitleStyleSettings>
  ): void {
    if (language === 'english') {
      this.englishSettings = { ...this.englishSettings, ...settings };
    } else if (language === 'chinese') {
      this.chineseSettings = { ...this.chineseSettings, ...settings };
    }

    this.applyLanguageStyles(language);
  }

  private async loadSubtitleData(): Promise<void> {
    try {
      const currentVideoId = this.getVideoId();

      const result = await chrome.storage.local.get([
        'subtitleEnabled',
        'englishSettings',
        'chineseSettings',
      ]);

      const statusResponse = currentVideoId
        ? await chrome.runtime.sendMessage({
          action: 'getTranslationStatus',
          videoId: currentVideoId,
        })
        : null;
      const status = statusResponse?.status as { cachedResult?: VideoSubtitleData | null } | undefined;
      const videoSubtitles = status?.cachedResult;

      if (currentVideoId !== this.getVideoId()) {
        return;
      }

      this.englishSubtitles = [];
      this.chineseSubtitles = [];

      if (videoSubtitles) {
        if (videoSubtitles.englishSubtitles || videoSubtitles.chineseSubtitles) {
          this.englishSubtitles = videoSubtitles.englishSubtitles || [];
          this.chineseSubtitles = videoSubtitles.chineseSubtitles || [];
        } else if (videoSubtitles.subtitleData && videoSubtitles.subtitleData.length > 0) {
          this.chineseSubtitles = videoSubtitles.subtitleData;
        }
      }

      if (result.subtitleEnabled !== undefined) {
        this.isEnabled = result.subtitleEnabled as boolean;
      }

      if (result.englishSettings) {
        this.englishSettings = {
          ...this.englishSettings,
          ...(result.englishSettings as SubtitleStyleSettings),
        };
      }

      if (result.chineseSettings) {
        const filteredSettings: Partial<SubtitleStyleSettings> = {};
        for (const [key, value] of Object.entries(
          result.chineseSettings as SubtitleStyleSettings
        )) {
          if (value !== '' && value !== null && value !== undefined) {
            (filteredSettings as Record<string, unknown>)[key] = value;
          }
        }

        this.chineseSettings = { ...this.chineseSettings, ...filteredSettings };
      }

      if (this.overlayElement) {
        this.applyLanguageStyles('english');
        this.applyLanguageStyles('chinese');
      }

      const hasSubtitles =
        this.englishSubtitles.length > 0 ||
        this.chineseSubtitles.length > 0;

      if (hasSubtitles && this.isEnabled) {
        if (!this.currentVideo) {
          this.currentVideo = document.querySelector('video');
        }
        if (this.currentVideo && this.overlayElement) {
          this.repositionSubtitle();
          this.setupVideoListeners();
          this.updateSubtitle();
        }
      }
    } catch {}
  }

  private getVideoId(): string | null {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v');
  }
}

// 初始化
let subtitleOverlayInstance: YouTubeSubtitleOverlay | null = null;

const initializeSubtitle = (): void => {
  if (!subtitleOverlayInstance) {
    subtitleOverlayInstance = new YouTubeSubtitleOverlay();
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSubtitle);
} else {
  initializeSubtitle();
}
