/**
 * base64 로 인코딩된 CBR(고정비트레이트) MP3 의 첫 프레임 헤더만 읽어
 * 재생 길이(ms)를 계산한다. Google TTS 는 CBR 로 합성하므로 첫 프레임의
 * 비트레이트 하나면 totalBytes*8/bitrate 로 정확한 길이가 나온다(VBR 이면
 * 부정확하지만 이 서비스는 CBR 만 다룬다). ID3v2 태그가 붙어 있으면 건너뛰고
 * 그 다음 프레임 sync(0xFFEx)를 찾는다. 파싱 실패는 절대 throw 하지 않고
 * 0 을 돌려준다 - 호출부(tts.service)가 0 을 기존 150ms/글자 추정 폴백으로
 * 태운다.
 */
import { decode } from 'base64-arraybuffer';

// 비트레이트(kbps) 표. index 0=free, 15=bad - 둘 다 파싱 불가로 처리한다.
// MPEG1 은 버전군 '1', MPEG2/2.5 는 레이어II·III 표가 동일해 '2' 하나로 묶는다.
const BITRATE_KBPS: Record<'1' | '2', Record<1 | 2 | 3, number[]>> = {
  '1': {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  '2': {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};

/** ID3v2 태그가 있으면 건너뛰고 첫 MP3 프레임 헤더(0xFF, 0xEx sync)의 오프셋을 찾는다. */
function findFirstFrameOffset(bytes: Uint8Array): number {
  let offset = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    // ID3v2 헤더: 10바이트 고정부 + synchsafe 크기(바이트당 상위비트 0인 7비트×4).
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    offset = 10 + size;
  }
  while (offset + 1 < bytes.length) {
    if (bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0) return offset;
    offset += 1;
  }
  return -1;
}

/** base64 mp3 의 재생 길이(ms). 파싱 실패(형식 미상/예약값 등) 시 0 (throw 안 함). */
export function mp3DurationMs(base64Mp3: string): number {
  try {
    const bytes = new Uint8Array(decode(base64Mp3));
    const frameOffset = findFirstFrameOffset(bytes);
    if (frameOffset < 0 || frameOffset + 4 > bytes.length) return 0;

    const b1 = bytes[frameOffset + 1];
    const b2 = bytes[frameOffset + 2];
    const versionBits = (b1 >> 3) & 0x03; // 00=MPEG2.5, 01=예약, 10=MPEG2, 11=MPEG1
    const layerBits = (b1 >> 1) & 0x03; // 00=예약, 01=LayerIII, 10=LayerII, 11=LayerI
    const bitrateIndex = (b2 >> 4) & 0x0f;
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15) {
      return 0; // 예약값/free/bad - 파싱 불가
    }
    const version: '1' | '2' = versionBits === 3 ? '1' : '2';
    const layer = (4 - layerBits) as 1 | 2 | 3; // 01->III(3), 10->II(2), 11->I(1)
    const bitrateBps = BITRATE_KBPS[version][layer][bitrateIndex] * 1000;
    if (!bitrateBps) return 0;

    const dataBytes = bytes.length - frameOffset;
    return Math.round((dataBytes * 8 * 1000) / bitrateBps);
  } catch {
    return 0;
  }
}
