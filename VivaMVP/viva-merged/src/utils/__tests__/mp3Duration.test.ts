import { encode } from 'base64-arraybuffer';
import { mp3DurationMs } from '../mp3Duration';

/** MPEG1 LayerIII, 128kbps, 44100Hz 프레임 헤더(표준 0xFF 0xFB 값) + 나머지는
 * 더미 페이로드로 채운 CBR mp3 를 만든다. totalBytes 로 길이를 조절한다. */
function buildCbrMp3Bytes(totalBytes: number, { withId3 = false, mpeg2 = false } = {}): Uint8Array {
  // MPEG1 LayerIII: 0xFF 0xFB 0x90 0x00 (128kbps)
  // MPEG2 LayerIII: 0xFF 0xF2 0x40 0x00 (32kbps, versionBits=2, layerBits=1)
  const header = mpeg2
    ? new Uint8Array([0xff, 0xf2, 0x40, 0x00]) // MPEG2 LayerIII 32kbps
    : new Uint8Array([0xff, 0xfb, 0x90, 0x00]); // MPEG1 LayerIII 128kbps
  if (!withId3) {
    const bytes = new Uint8Array(totalBytes);
    bytes.set(header, 0);
    return bytes;
  }
  const tagBodyLen = 10;
  const id3 = new Uint8Array(10 + tagBodyLen);
  id3.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00], 0); // 'ID3' + version + flags
  // synchsafe size (7비트×4) = tagBodyLen
  id3[6] = 0;
  id3[7] = 0;
  id3[8] = 0;
  id3[9] = tagBodyLen;
  const bytes = new Uint8Array(id3.length + totalBytes);
  bytes.set(id3, 0);
  bytes.set(header, id3.length);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  return encode(bytes.buffer);
}

describe('mp3DurationMs', () => {
  it('128kbps CBR mp3: totalBytes*8/bitrate 로 길이(ms)를 계산한다', () => {
    // dataBytes=1600, bitrate=128000bps -> 1600*8*1000/128000 = 100ms
    const bytes = buildCbrMp3Bytes(1600);
    expect(mp3DurationMs(toBase64(bytes))).toBe(100);
  });

  it('ID3v2 태그가 있으면 건너뛰고 첫 프레임부터 계산한다', () => {
    const bytes = buildCbrMp3Bytes(1600, { withId3: true });
    expect(mp3DurationMs(toBase64(bytes))).toBe(100);
  });

  it('유효한 프레임 헤더가 없으면 0 (throw 하지 않음)', () => {
    expect(mp3DurationMs(toBase64(new TextEncoder().encode('not an mp3 at all')))).toBe(0);
  });

  it('base64 파싱 자체가 깨져도 throw 하지 않고 0', () => {
    expect(mp3DurationMs('!!!not-base64!!!')).toBe(0);
  });

  it('빈 문자열이면 0', () => {
    expect(mp3DurationMs('')).toBe(0);
  });

  it('MPEG2 LayerIII CBR mp3 32kbps: 24kHz TTS 픽스처', () => {
    // MPEG2 LayerIII at 32kbps (valid for Google TTS ko-KR-Chirp3-HD 24kHz)
    // dataBytes=800, bitrate=32000bps -> 800*8*1000/32000 = 200ms
    const bytes = buildCbrMp3Bytes(800, { mpeg2: true });
    expect(mp3DurationMs(toBase64(bytes))).toBe(200);
  });

  it('MPEG2 LayerIII with ID3v2 태그', () => {
    // ID3v2 tag 이후 MPEG2 헤더부터 계산
    // dataBytes=800, bitrate=32000bps -> 800*8*1000/32000 = 200ms
    const bytes = buildCbrMp3Bytes(800, { mpeg2: true, withId3: true });
    expect(mp3DurationMs(toBase64(bytes))).toBe(200);
  });
});
