import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// 1. .env 파일 수동 로드
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  for (const line of envConfig.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const val = valueParts.join('=').trim();
      if (key && val) {
        process.env[key.trim()] = val;
      }
    }
  }
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ Supabase 환경변수를 찾을 수 없습니다 (.env 확인 필요)');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

function copyToClipboard(text: string): boolean {
  try {
    let cmd = 'pbcopy';
    let args: string[] = [];
    if (process.platform === 'win32') {
      cmd = 'clip';
    } else if (process.platform === 'linux') {
      cmd = 'xclip';
      args = ['-selection', 'clipboard'];
    }
    const proc = spawnSync(cmd, args, { input: text, encoding: 'utf8' });
    return proc.status === 0;
  } catch {
    return false;
  }
}

function formatDate(ts: number | string | null | undefined): string {
  if (!ts) return 'N/A';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

async function buildSessionReport(session: any): Promise<string> {
  const sessionId = session.session_id;

  // 이벤트 로그 조회
  const { data: events } = await supabase
    .from('viva_session_events')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });

  let report = `# 📱 VIVA 세션 대화 & 전체 데이터 분석 리포트\n\n`;
  report += `## 📌 1. 기본 세션 정보\n`;
  report += `- **Session ID**: \`${session.session_id}\`\n`;
  report += `- **Device ID**: \`${session.device_id}\`\n`;
  report += `- **단원/주제 (Topic)**: ${session.topic || session.preview || 'N/A'}\n`;
  report += `- **시작 시간**: ${formatDate(session.started_at)}\n`;
  report += `- **종료 시간**: ${formatDate(session.ended_at)}\n`;
  report += `- **최종 FSM 상태**: \`${session.final_state}\`\n`;
  report += `- **총 힌트 제공 횟수**: ${session.hint_count ?? 0}회\n`;
  report += `- **오답 분석 (Mistake Reason)**: ${session.mistake_reason || 'N/A'}\n\n`;

  report += `## 📷 2. 입력 및 생성 이미지 정보\n`;
  report += `- **학생 촬영 문제 이미지 URL**:\n  ${session.problem_image_url || '없음 (대화 전용 또는 이미지 없음)'}\n\n`;

  report += `### 🎨 생성된 판서 이미지 목록 (${session.board_images?.length || 0}개)\n`;
  if (session.board_images && session.board_images.length > 0) {
    session.board_images.forEach((board: any, idx: number) => {
      report += `  ${idx + 1}. [${formatDate(board.timestamp)}] 이미지 URL: ${board.filePath}\n`;
      report += `     - 판서 힌트 지시 (Board Prompt): "${board.boardPrompt}"\n`;
    });
  } else {
    report += `  (생성된 판서 이미지 없음)\n`;
  }
  report += `\n`;

  report += `## 🗣️ 3. 대화 내역 (나레이션 & 학생 발화 전문)\n`;
  if (session.messages && session.messages.length > 0) {
    session.messages.forEach((msg: any, idx: number) => {
      const speaker = msg.role === 'user' ? '👤 학생 (User)' : '🤖 비바 나레이션 (Viva Assistant)';
      const timeStr = formatDate(msg.timestamp);
      report += `### [${idx + 1}] ${speaker} (${timeStr})\n`;
      report += `\`\`\`text\n${msg.message}\n\`\`\`\n\n`;
    });
  } else {
    report += `(기록된 대화 메시지 없음)\n\n`;
  }

  report += `## 🔍 4. 상세 디버그 기록 (Debug Snapshot)\n`;
  if (session.debug) {
    const debug = session.debug;
    report += `- **사진 촬영 출처**: \`${debug.photoSource || 'N/A'}\`\n`;
    report += `- **문제 인식 팩트 (Problem Facts)**:\n  ${debug.problemFacts || 'N/A'}\n`;
    report += `- **확정 정답 (Final Answer, D-27)**: ${debug.finalAnswer || 'N/A'}\n\n`;

    report += `### 📸 촬영 시도 단계별 기록 (Capture Attempts)\n`;
    if (debug.captureAttempts && debug.captureAttempts.length > 0) {
      debug.captureAttempts.forEach((cap: any, idx: number) => {
        report += `  ${idx + 1}. [Stage: ${cap.stage}] (${formatDate(cap.timestamp)})\n`;
        if (cap.box2d) report += `     - Box2D 크롭 영역: [${cap.box2d.join(', ')}]\n`;
        if (cap.imageUrl) report += `     - 캡처 이미지 URL: ${cap.imageUrl}\n`;
      });
    } else {
      report += `  (촬영 시도 기록 없음)\n`;
    }
    report += `\n`;

    report += `### 🖊️ 판서 생성 & 사후검증 기록 (Board Debugs)\n`;
    if (debug.boards && debug.boards.length > 0) {
      debug.boards.forEach((b: any, idx: number) => {
        report += `  ${idx + 1}. [${formatDate(b.timestamp)}] 생성 소요: ${b.genMs}ms | 재생성 여부: ${b.regenerated ? 'TRUE' : 'FALSE'}\n`;
        report += `     - 판서 프롬프트: ${b.boardPrompt}\n`;
        if (b.verify) {
          report += `     - 사후검증 결과: ${b.verify.pass ? '✅ 통과' : '❌ 불합격'} (검증 소요: ${b.verify.verifyMs}ms)\n`;
          if (b.verify.issues && b.verify.issues.length > 0) {
            report += `     - 검증 지적사항: ${b.verify.issues.join('; ')}\n`;
          }
        }
        // 채택되지 않은 재생성본의 판정. 이 줄이 없으면 "1차본 지적사항"과
        // "재생성본 지적사항"이 프롬프트 본문과 verify 필드에 흩어져, 어느
        // 이미지 얘기인지 읽는 사람이 알 수 없다 (2026-08-07).
        if (b.regenVerify) {
          report += `     - 재생성본 판정(채택 안 됨): ${b.regenVerify.pass ? '✅ 통과' : '❌ 불합격'} (검증 소요: ${b.regenVerify.verifyMs}ms)\n`;
          if (b.regenVerify.issues && b.regenVerify.issues.length > 0) {
            report += `     - 재생성본 지적사항: ${b.regenVerify.issues.join('; ')}\n`;
          }
        }
        report += `     - Gemini 입력 프롬프트 전문:\n\`\`\`\n${b.fullPrompt}\n\`\`\`\n`;
      });
    } else {
      report += `  (판서 디버그 기록 없음)\n`;
    }
  } else {
    report += `(디버그 정보 없음)\n`;
  }
  report += `\n`;

  report += `## ⏱️ 5. 세션 이벤트 타임라인 (viva_session_events)\n`;
  if (events && events.length > 0) {
    events.forEach((ev: any, idx: number) => {
      report += `${idx + 1}. [${formatDate(ev.created_at)}] State: ${ev.app_state} (${ev.fsm_state || 'N/A'})\n`;
      report += `   - 힌트 횟수: ${ev.hint_count ?? '-'}, 연속 오답: ${ev.wrong_streak ?? '-'}`;
      if (ev.error_type) report += `, 오류 유형: ${ev.error_type}`;
      if (ev.misconception_type) report += `, 오개념: ${ev.misconception_type}`;
      report += `\n`;
    });
  } else {
    report += `(이벤트 기록 없음)\n`;
  }
  report += `\n`;

  report += `## 📊 6. 원본 Raw JSON 데이터\n`;
  report += `\`\`\`json\n${JSON.stringify({ session, events }, null, 2)}\n\`\`\`\n`;
  return report;
}

async function run() {
  const args = process.argv.slice(2);
  const isListMode = args.includes('--list');
  const isAllMode = args.includes('--all');
  const targetSessionId = args.find((arg) => !arg.startsWith('--'));

  console.log('🔄 Supabase에서 세션 데이터 조회 중...');

  let query = supabase.from('viva_sessions').select('*').order('started_at', { ascending: false });

  if (targetSessionId) {
    query = query.eq('session_id', targetSessionId);
  } else if (isListMode) {
    query = query.limit(10);
  } else if (!isAllMode) {
    query = query.limit(1); // 기본값: 가장 최근 1개 세션만
  }

  const { data: sessions, error } = await query;

  if (error) {
    console.error('❌ Supabase 조회 오류:', error);
    process.exit(1);
  }

  if (!sessions || sessions.length === 0) {
    console.log('⚠️ 저장된 세션이 없습니다.');
    process.exit(0);
  }

  if (isListMode) {
    console.log('\n📋 [최근 세션 목록]');
    sessions.forEach((s, idx) => {
      console.log(
        `[${idx + 1}] ID: ${s.session_id} | 시작: ${formatDate(s.started_at)} | 주제: ${s.topic || s.preview || '미지정'}`,
      );
    });
    console.log('\n💡 모든 세션을 한꺼번에 추출하려면: npm run export-chat -- --all');
    console.log('💡 특정 세션만 추출하려면: npm run export-chat -- <session_id>');
    process.exit(0);
  }

  let finalReport = '';
  if (isAllMode) {
    console.log(`📦 총 ${sessions.length}개 전체 세션을 리포트로 생성 중...`);
    finalReport = `# 📚 VIVA 전체 세션 대화 & 분석 리포트 모음 (총 ${sessions.length}개 세션)\n\n`;
    for (let i = 0; i < sessions.length; i++) {
      finalReport += `\n=======================================================\n`;
      finalReport += `### 세션 [${i + 1}/${sessions.length}] - ${sessions[i].session_id}\n`;
      finalReport += `=======================================================\n\n`;
      finalReport += await buildSessionReport(sessions[i]);
      finalReport += `\n\n---\n\n`;
    }
  } else {
    finalReport = await buildSessionReport(sessions[0]);
  }

  // 클립보드로 복사
  const copied = copyToClipboard(finalReport);

  // 로컬 파일로 저장
  const fileName = isAllMode ? 'all_sessions_export.md' : 'latest_session_export.md';
  const outputPath = path.resolve(__dirname, fileName);
  fs.writeFileSync(outputPath, finalReport, 'utf8');

  if (isAllMode) {
    console.log(`\n✅ 총 ${sessions.length}개 세션 전체 데이터 추출 완료!`);
  } else {
    console.log(`\n✅ 세션 \`${sessions[0].session_id}\` 추출 완료!`);
  }
  console.log(`📂 추출 결과 파일: ${outputPath}`);
  if (copied) {
    console.log(
      `📋 ✨ [성공] 대화 내용 및 세션 전체 정보가 클립보드에 저장되었습니다! (Cmd+V / Ctrl+V 로 붙여넣기 가능)`,
    );
  } else {
    console.log(`⚠️ 클립보드 복사 실패 (파일로만 보존됨). 결과 파일: ${outputPath}`);
  }
}

run().catch((err) => {
  console.error('❌ 스크립트 실행 오류:', err);
  process.exit(1);
});
