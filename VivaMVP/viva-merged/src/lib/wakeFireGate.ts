/**
 * 웨이크워드 발화 판정 게이트 (ONNX 없이 단위 테스트 가능한 순수 로직).
 *
 * 기침·박수 같은 단발 트랜지언트는 "새 윈도우만 채점" 기준으로 임계값을
 * 1홉만 넘고, 실제 "비바야" 발화(~0.6초)는 연속 홉에서 넘는다. 그래서
 * 2연속 홉 확인으로 오인식을 거른다. 대가: 실제 발화 감지가 1홉(~300ms)
 * 늦어진다 - 허용(2026-08-13).
 */
export const OWW_CONSECUTIVE_HOPS = 2;
export const OWW_COOLDOWN_MS = 1500;
// 이 점수 이상 단일 홉은 연속 확인 없이 즉시 발화한다. 실기기 2026-08-13:
// 실발화가 0.387 → 0.025 로 떨어져 2연속 요구에 차단됨(10회 중 1회 인식).
// 기침 오탐은 0.08~0.2 대로 가정 - 0.3 을 넘는 게 실측되면 이 값을 올린다.
// ponytail: 하드웨어 튜닝 노브 - OWW_DEBUG hop score 실측으로 조정.
export const OWW_STRONG_SCORE = 0.3;

export class WakeFireGate {
  private streak = 0;
  private lastFireAt = -Infinity;

  constructor(
    private threshold: number,
    private strong: number = OWW_STRONG_SCORE,
  ) {}

  /** 홉당 점수를 넣는다. true 면 onDetected 를 쏜다. */
  push(score: number, now: number): boolean {
    if (score < this.threshold) {
      this.streak = 0;
      return false;
    }
    this.streak += 1;
    if (score < this.strong && this.streak < OWW_CONSECUTIVE_HOPS) return false;
    if (now - this.lastFireAt <= OWW_COOLDOWN_MS) return false;
    this.lastFireAt = now;
    return true;
  }

  /** 연속 카운트를 지운다(세션 간 엔진 재사용 시). 쿨다운 시각은 유지. */
  reset(): void {
    this.streak = 0;
  }
}
