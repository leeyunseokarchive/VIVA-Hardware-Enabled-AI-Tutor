/**
 * PCM(LINEAR16) -> WAV container encoding utils.
 *
 * react-native-live-audio-stream 이 주는 base64 PCM 청크들을 이어 붙여
 * Google Cloud Speech-to-Text REST(speech:recognize) 에 보낼 base64 WAV
 * 하나로 만든다. 순수 함수라 유닛 테스트 가능.
 */

// base64 <-> bytes: RN 런타임(Hermes)에는 atob/btoa 가 전역에 있지만,
// Jest(node) 환경에서는 Buffer 를 쓴다. 둘 다 지원.
function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

/** base64 PCM 청크 배열을 하나의 Uint8Array 로 이어 붙인다. */
export function concatPcmChunks(base64Chunks: string[]): Uint8Array {
  const parts = base64Chunks.map(base64ToBytes);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 16-bit mono PCM 의 RMS(0~1 정규화). 침묵 감지(VAD)에 사용. */
export function pcmRms(base64Chunk: string): number {
  const bytes = base64ToBytes(base64Chunk);
  const sampleCount = Math.floor(bytes.length / 2);
  if (sampleCount === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    // little-endian int16
    let v = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    if (v >= 0x8000) v -= 0x10000;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / sampleCount) / 32768;
}

/** PCM 바이트를 WAV(RIFF) 컨테이너로 감싸 base64 로 반환. */
export function pcmToWavBase64(
  pcm: Uint8Array,
  sampleRate = 16000,
  channels = 1,
  bitsPerSample = 16,
): string {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.length, true);

  const wav = new Uint8Array(44 + pcm.length);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm, 44);
  return bytesToBase64(wav);
}
