/**
 * WakeFireGate 단위 테스트 - ONNX 없이 합성 점수 시퀀스로 발화 판정 검증.
 * 홉당 점수(새 윈도우 최고점)를 순서대로 넣어 2연속 확인·쿨다운·리셋을 본다.
 */
import { WakeFireGate, OWW_COOLDOWN_MS, OWW_STRONG_SCORE } from '../wakeFireGate';

const HIGH = 0.15; // 임계값(0.08) 이상, 강한 홉(OWW_STRONG_SCORE) 미만
const LOW = 0.01;

describe('WakeFireGate', () => {
  it('단발 트랜지언트(중간 점수 1홉, low)는 발화하지 않는다', () => {
    const gate = new WakeFireGate(0.08);
    expect(gate.push(HIGH, 0)).toBe(false);
    expect(gate.push(LOW, 300)).toBe(false);
  });

  it('강한 단일 홉(OWW_STRONG_SCORE 이상)은 즉시 발화한다', () => {
    // 실기기 2026-08-13: 0.387 → 0.025 실발화가 2연속 요구에 차단됨(10회 중
    // 1회 인식). 확신 점수는 연속 확인 없이 발화 - 기침 오탐이 0.3 을 넘는
    // 게 실측되면 OWW_STRONG_SCORE 를 올린다.
    const gate = new WakeFireGate(0.08);
    expect(gate.push(OWW_STRONG_SCORE, 0)).toBe(true);
  });

  it('강한 홉도 쿨다운을 지킨다', () => {
    const gate = new WakeFireGate(0.08);
    expect(gate.push(0.9, 0)).toBe(true);
    expect(gate.push(0.9, 300)).toBe(false); // 쿨다운 중
    expect(gate.push(0.9, OWW_COOLDOWN_MS + 1)).toBe(true);
  });

  it('2연속 홉이 임계값을 넘으면 1번만 발화한다', () => {
    const gate = new WakeFireGate(0.08);
    expect(gate.push(HIGH, 0)).toBe(false);
    expect(gate.push(HIGH, 300)).toBe(true);
  });

  it('발화 후 쿨다운 동안은 다시 발화하지 않고, 지나면 다시 발화한다', () => {
    const gate = new WakeFireGate(0.08);
    gate.push(HIGH, 0);
    expect(gate.push(HIGH, 300)).toBe(true);
    expect(gate.push(HIGH, 600)).toBe(false); // 쿨다운 중
    expect(gate.push(HIGH, 300 + OWW_COOLDOWN_MS + 1)).toBe(true);
  });

  it('낮은 점수가 끼면 연속 카운트가 리셋된다', () => {
    const gate = new WakeFireGate(0.08);
    gate.push(HIGH, 0);
    gate.push(LOW, 300);
    expect(gate.push(HIGH, 600)).toBe(false); // 다시 1홉째
    expect(gate.push(HIGH, 900)).toBe(true);
  });

  it('reset() 은 연속 카운트를 지운다', () => {
    const gate = new WakeFireGate(0.08);
    gate.push(HIGH, 0);
    gate.reset();
    expect(gate.push(HIGH, 300)).toBe(false);
    expect(gate.push(HIGH, 600)).toBe(true);
  });
});
