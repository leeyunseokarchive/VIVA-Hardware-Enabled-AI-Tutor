/**
 * SessionDetailScreen 하단의 개발용 디버그 섹션 (__DEV__ 전용).
 *
 * 보여주는 것 (스펙 2026-07-29):
 *  - 촬영 파이프라인: 시도별 이미지 + 폴백 단계 뱃지 + box_2d, 마지막이 최종
 *  - problemFacts / photoSource
 *  - 판서별: board_prompt, 실전송 프롬프트 전문(펼치기), 생성 ms, 검증 판정
 *  - 턴 타임라인: viva_session_events (fsm_state, confidence, wrongStreak ...)
 *
 * 라이트 앱 화면 안의 다크 dev-tool 카드로 그린다 - 학생용 UI 와 시각적으로
 * 확실히 분리되고, 개발자 눈에는 "여긴 디버그다" 로 읽힌다.
 */
import React, { useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type {
  SessionDebugRecord,
  CaptureStage,
  BoardDebugRecord,
} from '../services/sessionDebug.service';
import type { SessionEvent } from '../services/sessionLog.service';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

// 다크 dev 카드 팔레트 (본문 대비 4.5:1 이상 유지).
const C = {
  bg: '#232120',
  surface: '#2E2B29',
  border: 'rgba(255, 255, 255, 0.10)',
  text: '#E8E4DC',
  dim: 'rgba(232, 228, 220, 0.60)',
  green: '#5BC79A',
  orange: '#F09B77',
  red: '#F08A6E',
};

const STAGE_LABEL: Record<CaptureStage, string> = {
  initial: '최초 촬영',
  tier1_crop: 'Tier1 보관본 크롭',
  tier2_recapture: 'Tier2 로봇 재촬영',
  problem_choice_crop: '문제 선택 크롭',
  single_problem_crop: '단일 문제 크롭',
  pi_retake: '로봇 재촬영',
  phone_retake: '폰 재촬영',
};

const STAGE_COLOR: Record<CaptureStage, string> = {
  initial: C.green,
  tier1_crop: C.orange,
  tier2_recapture: C.red,
  problem_choice_crop: C.orange,
  single_problem_crop: C.green,
  pi_retake: C.orange,
  phone_retake: C.orange,
};

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function Badge({ label, color }: { label: string; color: string }): React.JSX.Element {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

function SubHeader({ title }: { title: string }): React.JSX.Element {
  return <Text style={styles.subHeader}>{title}</Text>;
}

/** 접이식 모노스페이스 블록 (프롬프트 전문 등 긴 텍스트). */
function ExpandableMono({ label, text }: { label: string; text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} ${open ? '접기' : '펼치기'}`}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.expandRow, pressed && styles.pressed]}
      >
        <Text style={styles.expandChevron}>{open ? '▾' : '▸'}</Text>
        <Text style={styles.expandLabel}>{label}</Text>
        <Text style={styles.expandMeta}>{text.length.toLocaleString()}자</Text>
      </Pressable>
      {open && (
        <View style={styles.monoBlock}>
          <Text style={styles.monoText} selectable>
            {text}
          </Text>
        </View>
      )}
    </View>
  );
}

function BoardCard({
  board,
  index,
}: {
  board: BoardDebugRecord;
  index: number;
}): React.JSX.Element {
  const verify = board.verify;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeaderRow}>
        <Text style={styles.cardTitle}>판서 #{index + 1}</Text>
        <Text style={styles.cardMeta}>
          {timeLabel(board.timestamp)} · 생성 {board.genMs.toLocaleString()}ms
        </Text>
      </View>
      <View style={styles.badgeRow}>
        {verify ? (
          <Badge
            label={
              verify.pass
                ? `검증 통과 (${verify.verifyMs}ms)`
                : `검증 불합격 (${verify.verifyMs}ms)`
            }
            color={verify.pass ? C.green : C.red}
          />
        ) : (
          <Badge label="검증 안 됨" color={C.dim} />
        )}
        {board.regenerated && <Badge label="재생성본" color={C.orange} />}
      </View>
      {verify && !verify.pass && verify.issues.length > 0 && (
        <View style={styles.issueList}>
          {verify.issues.map((issue, i) => (
            <Text key={`issue-${i}`} style={styles.issueText}>
              · {issue}
            </Text>
          ))}
        </View>
      )}
      <Text style={styles.kvLabel}>board_prompt</Text>
      <Text style={styles.kvValueMono} selectable>
        {board.boardPrompt || '(빈 문자열)'}
      </Text>
      <ExpandableMono label="실전송 프롬프트 전문" text={board.fullPrompt} />
    </View>
  );
}

/** 이벤트 meta 를 "핵심만" 한 줄 모노스페이스로. */
function eventSummary(e: SessionEvent): string {
  const m = e.meta ?? {};
  const parts: string[] = [];
  if (m.confidence !== undefined && m.confidence !== null) parts.push(`conf=${m.confidence}`);
  if (m.hintCount !== undefined) parts.push(`hint=${m.hintCount}`);
  if (m.wrongStreak !== undefined) parts.push(`wrong=${m.wrongStreak}`);
  if (m.isOnCorrectPath !== undefined && m.isOnCorrectPath !== null)
    parts.push(`onPath=${m.isOnCorrectPath}`);
  if (m.requiresBoard) parts.push('board');
  if (m.boardUpdateNeeded) parts.push('boardUpd');
  if (m.errorType && m.errorType !== 'NONE') parts.push(`err=${m.errorType}`);
  if (m.misconceptionType && m.misconceptionType !== 'NONE')
    parts.push(`misc=${m.misconceptionType}`);
  return parts.join(' ');
}

interface SessionDebugSectionProps {
  debug?: SessionDebugRecord;
  events: SessionEvent[];
}

export default function SessionDebugSection({
  debug,
  events,
}: SessionDebugSectionProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const attempts = debug?.captureAttempts ?? [];
  const boards = debug?.boards ?? [];

  if (!debug && events.length === 0) return null;

  return (
    <View style={styles.container} testID="session-debug-section">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`디버그 섹션 ${open ? '접기' : '펼치기'}`}
        testID="session-debug-toggle"
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.headerRow, pressed && styles.pressed]}
      >
        <Text style={styles.headerTitle}>{'</>'} 디버그</Text>
        <Text style={styles.headerMeta}>
          촬영 {attempts.length} · 판서 {boards.length} · 이벤트 {events.length}
        </Text>
        <Text style={styles.headerChevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>

      {open && (
        <View style={styles.body}>
          {/* 세션 메타 */}
          <View style={styles.kvRow}>
            <Text style={styles.kvLabel}>photoSource</Text>
            <Text style={styles.kvValueMono}>{debug?.photoSource ?? '(미기록)'}</Text>
          </View>
          {debug?.problemFacts ? (
            <ExpandableMono label="problem_facts (문제 전사)" text={debug.problemFacts} />
          ) : (
            <View style={styles.kvRow}>
              <Text style={styles.kvLabel}>problem_facts</Text>
              <Text style={styles.kvValueMono}>(미기록)</Text>
            </View>
          )}

          {/* 촬영 파이프라인 */}
          {attempts.length > 0 && (
            <>
              <SubHeader title={`촬영 파이프라인 (${attempts.length}회)`} />
              {attempts.map((a, i) => (
                <View key={`attempt-${i}`} style={styles.card}>
                  <View style={styles.cardHeaderRow}>
                    <Badge
                      label={STAGE_LABEL[a.stage] ?? a.stage}
                      color={STAGE_COLOR[a.stage] ?? C.dim}
                    />
                    {i === attempts.length - 1 && <Badge label="최종 전송본" color={C.green} />}
                    <Text style={styles.cardMeta}>{timeLabel(a.timestamp)}</Text>
                  </View>
                  {a.box2d && <Text style={styles.kvValueMono}>box_2d [{a.box2d.join(', ')}]</Text>}
                  {a.imageUrl ? (
                    <Image
                      source={{ uri: a.imageUrl }}
                      style={styles.attemptImage}
                      resizeMode="contain"
                      accessibilityLabel={`${STAGE_LABEL[a.stage]} 이미지`}
                    />
                  ) : (
                    <Text style={styles.cardMeta}>이미지 업로드 안 됨</Text>
                  )}
                </View>
              ))}
            </>
          )}

          {/* 판서 기록 */}
          {boards.length > 0 && (
            <>
              <SubHeader title={`판서 생성 (${boards.length}회)`} />
              {boards.map((b, i) => (
                <BoardCard key={`board-dbg-${i}`} board={b} index={i} />
              ))}
            </>
          )}

          {/* 턴 타임라인 */}
          {events.length > 0 && (
            <>
              <SubHeader title={`이벤트 타임라인 (${events.length})`} />
              <View style={styles.card}>
                {events.map((e, i) => (
                  <View key={`ev-${i}`} style={styles.eventRow}>
                    <Text style={styles.eventTime}>{timeLabel(e.timestamp)}</Text>
                    <View style={styles.eventBody}>
                      <Text style={styles.eventState}>{e.fsmState ?? e.appState}</Text>
                      {!!eventSummary(e) && <Text style={styles.eventMeta}>{eventSummary(e)}</Text>}
                    </View>
                  </View>
                ))}
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 24,
    marginBottom: 8,
    borderRadius: 12,
    backgroundColor: C.bg,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: 14,
    gap: 8,
  },
  pressed: {
    opacity: 0.7,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: C.text,
    fontFamily: MONO,
  },
  headerMeta: {
    flex: 1,
    fontSize: 11,
    color: C.dim,
    fontFamily: MONO,
  },
  headerChevron: {
    fontSize: 14,
    color: C.dim,
  },
  body: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 10,
  },
  subHeader: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: '700',
    color: C.dim,
    fontFamily: MONO,
    letterSpacing: 0.4,
  },
  card: {
    backgroundColor: C.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    padding: 10,
    gap: 6,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: C.text,
    fontFamily: MONO,
  },
  cardMeta: {
    flex: 1,
    fontSize: 10,
    color: C.dim,
    fontFamily: MONO,
    textAlign: 'right',
  },
  badge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  issueList: {
    gap: 2,
  },
  issueText: {
    fontSize: 11,
    lineHeight: 16,
    color: C.red,
    fontFamily: MONO,
  },
  kvRow: {
    gap: 2,
  },
  kvLabel: {
    fontSize: 10,
    color: C.dim,
    fontFamily: MONO,
    letterSpacing: 0.4,
  },
  kvValueMono: {
    fontSize: 11,
    lineHeight: 16,
    color: C.text,
    fontFamily: MONO,
  },
  expandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: 6,
  },
  expandChevron: {
    fontSize: 12,
    color: C.dim,
  },
  expandLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: C.text,
    fontFamily: MONO,
  },
  expandMeta: {
    flex: 1,
    fontSize: 10,
    color: C.dim,
    fontFamily: MONO,
    textAlign: 'right',
  },
  monoBlock: {
    backgroundColor: '#1B1918',
    borderRadius: 6,
    padding: 10,
  },
  monoText: {
    fontSize: 10,
    lineHeight: 15,
    color: C.text,
    fontFamily: MONO,
  },
  attemptImage: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 6,
    backgroundColor: '#1B1918',
  },
  eventRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
  },
  eventTime: {
    fontSize: 10,
    color: C.dim,
    fontFamily: MONO,
    width: 56,
    lineHeight: 15,
  },
  eventBody: {
    flex: 1,
    gap: 1,
  },
  eventState: {
    fontSize: 11,
    fontWeight: '700',
    color: C.green,
    fontFamily: MONO,
    lineHeight: 15,
  },
  eventMeta: {
    fontSize: 10,
    color: C.dim,
    fontFamily: MONO,
    lineHeight: 14,
  },
});
