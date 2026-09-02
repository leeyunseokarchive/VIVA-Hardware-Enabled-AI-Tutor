import { useCallback, useState } from 'react';

export interface UseSolveModeResult {
  /** True when "바로 정답" mode is on: every new question should skip the
   * Socratic hint loop (HINT_STAGE) and jump straight to a full solution
   * (SOLVE_STAGE). See `directSolveMode` in prompts/system_prompt.ts and the
   * SOLVE_STAGE-on-startSession handling in hooks/useTutoringFSM.ts, which
   * together implement the actual behavior - this hook only owns the on/off
   * state, fixed top-right on Home/Intent/Conversation via
   * components/SolveModeToggle.tsx. */
  solveMode: boolean;
  toggleSolveMode: () => void;
  /** 세션이 끝나 홈으로 돌아갈 때 끈다.
   *
   * 이 토글은 "이 문제는 그냥 답을 봐야겠다" 는 그 세션 한정 선택이지 앱 설정이
   * 아니다. 켜둔 채 세션이 끝나면 다음에 사진을 찍는 순간 DIRECT_SOLVE_POLICY 가
   * "첫 사진부터 즉시 전체 풀이" 를 시켜서, 학생이 아무 말도 안 했는데 VIVA 가
   * 사진 속 문제를 골라 풀어버린다 (실기기 2026-07-29). 한 문제가 끝나면 앱을
   * 처음 켠 상태로 돌아가는 게 맞다. */
  resetSolveMode: () => void;
}

export function useSolveMode(): UseSolveModeResult {
  const [solveMode, setSolveMode] = useState(false);

  const toggleSolveMode = useCallback(() => {
    setSolveMode((prev) => !prev);
  }, []);

  const resetSolveMode = useCallback(() => {
    setSolveMode(false);
  }, []);

  return { solveMode, toggleSolveMode, resetSolveMode };
}
