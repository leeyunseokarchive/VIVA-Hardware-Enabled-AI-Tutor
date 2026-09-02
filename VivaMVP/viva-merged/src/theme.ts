/**
 * 앱 전역 디자인 토큰 (2026-07-29 UI 통일 작업).
 *
 * 이전엔 배경/서피스 색이 board.service.ts 에 살았고(판서 프롬프트가 배경색을
 * 쓰는 우연 때문), 나머지 색·폰트는 화면마다 리터럴로 흩어져 있었다 - 같은
 * 잉크색이 0.4/0.45/0.5 알파로 제각각 재타이핑되는 식. 여기가 유일한 원본이고
 * board.service 는 재수출만 한다 (기존 import 경로 호환).
 */
import { Platform } from 'react-native';

/** 앱 배경 (판서 프롬프트의 캔버스 색과 반드시 동일해야 한다). */
export const APP_BACKGROUND_COLOR = '#FAF7F0';
/** 떠 있는 컨트롤(마이크/입력바 등)의 서피스. */
export const SURFACE_COLOR = '#FFFFFF';
export const SURFACE_BORDER_COLOR = 'rgba(43, 41, 38, 0.14)';
/** 본문 잉크. */
export const INK = '#2B2926';
/** 보조 텍스트 (라벨/타임스탬프/플레이스홀더). */
export const INK_MUTED = 'rgba(43, 41, 38, 0.5)';
/** 브랜드 그린 (CTA/강조/오버레이). */
export const GREEN = '#369B75';
/** 강조색(GREEN 등) 배경 위 텍스트. */
export const ON_ACCENT = '#FFFFFF';
/** 경고/오답 계열 오렌지. */
export const ORANGE = '#D66A4D';
export const FONT = 'Pretendard';
/** 디버그/데이터 표기용 모노스페이스 (RN 은 폰트 스택을 못 받는다). */
export const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** 모션 토큰 (2026-08-13 UX 통일). 차분하고 빠름 - 페이드/슬라이드 위주.
 * ConversationScreen 자막(220ms)이 기준 문법. 새 애니메이션은 이 값만 쓴다. */
export const MOTION = {
  fast: 180, // 배지·버튼 등 소요소 등장
  base: 220, // 자막·화면 전환 크로스페이드
  slow: 320, // 판서/개념 이미지 등 큰 면 등장
} as const;
