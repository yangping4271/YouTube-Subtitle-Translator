/** 新版 get_panel 参数：field 149 内的 field 1 是 videoId。拒绝未知结构。 */
export function rewriteTranscriptPanelParamsVideoId(
  params: string,
  videoId: string
): string | null {
  try {
    const binary = atob(decodeURIComponent(params).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (
      videoId.length !== 11 ||
      bytes[0] !== 0xaa || bytes[1] !== 0x09 ||
      bytes[2] !== bytes.length - 3 || bytes[2] >= 0x80 ||
      bytes[3] !== 0x0a || bytes[4] !== videoId.length ||
      bytes.length < 5 + videoId.length
    ) return null;

    bytes.set(new TextEncoder().encode(videoId), 5);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return null;
  }
}

export function rewriteTranscriptParamsVideoId(
  params: string,
  videoId: string,
  languageCode?: string,
  kind?: string
): string | null {
  try {
    const normalized = decodeURIComponent(params)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0)
    );

    // getTranscriptEndpoint params 的第一个 protobuf 字段是 videoId。
    if (bytes[0] !== 0x0a || bytes[1] !== videoId.length) {
      return null;
    }

    const videoBytes = Array.from(videoId, (character) => character.charCodeAt(0));
    let rewritten = Uint8Array.from([0x0a, videoBytes.length, ...videoBytes]);

    if (languageCode) {
      const trackParams = Uint8Array.from([
        0x0a,
        kind?.length || 0,
        ...Array.from(kind || '', (character) => character.charCodeAt(0)),
        0x12,
        languageCode.length,
        ...Array.from(languageCode, (character) => character.charCodeAt(0)),
        0x1a,
        0x00,
      ]);
      let trackBinary = '';
      trackParams.forEach((byte) => {
        trackBinary += String.fromCharCode(byte);
      });
      const encodedTrackParams = new TextEncoder().encode(
        encodeURIComponent(btoa(trackBinary))
      );
      const fieldOffset = 2 + bytes[1];
      if (bytes[fieldOffset] !== 0x12 || bytes[fieldOffset + 1] >= 0x80) {
        return null;
      }
      const suffixOffset = fieldOffset + 2 + bytes[fieldOffset + 1];
      rewritten = Uint8Array.from([
        ...rewritten,
        0x12,
        encodedTrackParams.length,
        ...encodedTrackParams,
        ...bytes.slice(suffixOffset),
      ]);
    } else {
      rewritten = Uint8Array.from([
        ...rewritten,
        ...bytes.slice(2 + bytes[1]),
      ]);
    }

    let binary = '';
    rewritten.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch {
    return null;
  }
}
