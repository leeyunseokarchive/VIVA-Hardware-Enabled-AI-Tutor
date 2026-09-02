import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadAllSessions } from '../services/sessionHistory.service';
import { formatUsd } from '../services/apiPricing.service';
import type { SessionHistoryEntry } from '../types/SessionHistory';
import {
  APP_BACKGROUND_COLOR,
  SURFACE_COLOR,
  SURFACE_BORDER_COLOR,
} from '../services/board.service';
import { MOTION, GREEN, ON_ACCENT, INK_MUTED } from '../theme';

interface HistoryScreenProps {
  onBack: () => void;
  onSelectSession: (sessionId: string) => void;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const period = hours >= 12 ? '오후' : '오전';
  const displayHours = hours > 12 ? hours - 12 : hours || 12;
  return `${month}월 ${day}일 ${period} ${displayHours}:${minutes}`;
}

function stateLabel(state: string): string {
  switch (state) {
    case 'SOLVE_STAGE':
      return '풀이 완료';
    case 'HINT_STAGE':
      return '힌트 중';
    case 'ERROR':
      return '오류';
    default:
      return state;
  }
}

type HistoryTab = 'sessions' | 'wrongNotes';

/** 오답노트 MVP 판정: 힌트를 2회 이상 받았거나 풀이를 끝내지 못한 세션은
 * "다시 봐야 할 문제"로 분류한다. (전용 오답 데이터 모델은 추후 과제 —
 * 시연용으로는 기존 세션 기록에서 파생한다.) */
export function isWrongAnswerNote(entry: SessionHistoryEntry): boolean {
  return entry.kind !== 'concept' && (entry.hintCount >= 2 || entry.finalState !== 'SOLVE_STAGE');
}

/** Gemini가 세션에 직접 기록한 단원명(정답)을 우선 사용하고, 그 필드가 없는
 * 과거 세션(이 필드가 생기기 전에 저장된 것)에 한해서만 대화 텍스트 키워드로
 * 추정하는 구식 휴리스틱으로 폴백한다. */
export function resolveTopic(entry: SessionHistoryEntry): string {
  if (entry.topic && entry.topic.trim().length > 0) return entry.topic;
  return guessTopic(entry);
}

/** 대화 내용 키워드로 취약 단원을 추정하는 구식 휴리스틱 (topic 필드가 없는
 * 과거 세션 전용 폴백 - resolveTopic()을 통해서만 호출할 것). */
export function guessTopic(entry: SessionHistoryEntry): string {
  const text = entry.messages.map((m) => m.message).join(' ');
  if (/(이차방정식|근의 공식|인수분해)/.test(text)) return '이차방정식';
  if (/(일차방정식|방정식)/.test(text)) return '방정식';
  if (/(이차함수|포물선|그래프|함수)/.test(text)) return '함수';
  if (/(삼각형|원|각도|피타고라스|닮음|도형|넓이)/.test(text)) return '도형';
  if (/(확률|경우의 수|통계|평균)/.test(text)) return '확률과 통계';
  if (/(제곱근|루트|무리수)/.test(text)) return '제곱근과 실수';
  return '기타';
}

export default function HistoryScreen({
  onBack,
  onSelectSession,
}: HistoryScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  // 예전 고정 paddingTop:60 은 노치 작은 기기에서 상단을 과하게 밀어 리스트를
  // 좁혔다 - safe-area 기준으로 바꿔 공간을 되찾는다.
  const safeTop = Math.max(insets.top + 8, 16);
  const [sessions, setSessions] = useState<SessionHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<HistoryTab>('sessions');
  const [kindFilter, setKindFilter] = useState<'all' | 'concept' | 'solve'>('all');
  // 데모용 "복습 완료" 체크 상태 (세션 재시작 시 초기화되는 목업 수준).
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());

  const wrongNotes = useMemo(() => sessions.filter(isWrongAnswerNote), [sessions]);
  const filteredSessions = useMemo(
    () =>
      kindFilter === 'all' ? sessions : sessions.filter((s) => (s.kind ?? 'solve') === kindFilter),
    [sessions, kindFilter],
  );

  // 필터 전환 시 리스트 페이드 인 (ConversationScreen 자막 크로스페이드와 동일 문법).
  const listAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    listAnim.setValue(0);
    Animated.timing(listAnim, {
      toValue: 1,
      duration: MOTION.base,
      useNativeDriver: true,
    }).start();
  }, [kindFilter, listAnim]);

  const toggleReviewed = useCallback((sessionId: string) => {
    setReviewedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  useEffect(() => {
    loadAllSessions()
      .then(setSessions)
      .finally(() => setLoading(false));
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: SessionHistoryEntry }) => {
      const thumbnailUri = item.problemImageUrl || item.boardImages[0]?.filePath;
      const isConcept = item.kind === 'concept';
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`세션 ${item.preview}`}
          style={({ pressed }) => [styles.sessionCard, pressed && styles.sessionCardPressed]}
          onPress={() => onSelectSession(item.sessionId)}
        >
          <View style={styles.sessionCardContent}>
            <View style={styles.sessionCardText}>
              <View
                style={[
                  styles.kindBadge,
                  isConcept ? styles.kindBadgeConcept : styles.kindBadgeSolve,
                ]}
              >
                <Text style={isConcept ? styles.kindBadgeTextConcept : styles.kindBadgeTextSolve}>
                  {isConcept ? '개념' : '문제풀이'}
                </Text>
              </View>
              <Text style={styles.sessionPreview} numberOfLines={2}>
                {item.preview || '대화 세션'}
              </Text>
              <View style={styles.sessionMeta}>
                <Text style={styles.sessionDate}>{formatDate(item.startedAt)}</Text>
                <View style={styles.metaDot} />
                <Text style={styles.sessionState}>
                  {isConcept ? '개념 대화' : stateLabel(item.finalState)}
                </Text>
                {!isConcept && item.hintCount > 0 && (
                  <>
                    <View style={styles.metaDot} />
                    <Text style={styles.sessionHints}>힌트 {item.hintCount}회</Text>
                  </>
                )}
                {item.usage && item.usage.costUsd > 0 && (
                  <>
                    <View style={styles.metaDot} />
                    <Text
                      style={styles.sessionCost}
                      testID={`session-cost-badge-${item.sessionId}`}
                    >
                      {formatUsd(item.usage.costUsd)}
                    </Text>
                  </>
                )}
              </View>
            </View>
            {thumbnailUri && <Image source={{ uri: thumbnailUri }} style={styles.boardThumbnail} />}
          </View>
        </Pressable>
      );
    },
    [onSelectSession],
  );

  const renderNoteItem = useCallback(
    ({ item }: { item: SessionHistoryEntry }) => {
      const reviewed = reviewedIds.has(item.sessionId);
      const unfinished = item.finalState !== 'SOLVE_STAGE';
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`오답노트 ${item.preview}`}
          testID={`wrong-note-card-${item.sessionId}`}
          style={({ pressed }) => [
            styles.sessionCard,
            reviewed && styles.noteCardReviewed,
            pressed && styles.sessionCardPressed,
          ]}
          onPress={() => onSelectSession(item.sessionId)}
        >
          <View style={styles.sessionCardContent}>
            <View style={styles.sessionCardText}>
              <View style={styles.noteBadgeRow}>
                <View style={styles.topicBadge}>
                  <Text style={styles.topicBadgeText}>{resolveTopic(item)}</Text>
                </View>
                <View style={[styles.reasonBadge, unfinished && styles.reasonBadgeUnfinished]}>
                  <Text
                    style={[styles.reasonBadgeText, unfinished && styles.reasonBadgeTextUnfinished]}
                  >
                    {unfinished ? '풀이 미완료' : `힌트 ${item.hintCount}회 만에 해결`}
                  </Text>
                </View>
              </View>
              <Text
                style={[styles.sessionPreview, reviewed && styles.notePreviewReviewed]}
                numberOfLines={2}
              >
                {item.preview || '대화 세션'}
              </Text>
              {item.mistakeReason && (
                <Text
                  style={styles.mistakeReasonText}
                  numberOfLines={2}
                  testID={`wrong-note-mistake-reason-${item.sessionId}`}
                >
                  틀린 이유: {item.mistakeReason}
                </Text>
              )}
              <View style={styles.sessionMeta}>
                <Text style={styles.sessionDate}>{formatDate(item.startedAt)}</Text>
              </View>
            </View>
            {(item.problemImageUrl || item.boardImages.length > 0) && (
              <Image
                source={{ uri: item.problemImageUrl || item.boardImages[0].filePath }}
                style={styles.boardThumbnail}
              />
            )}
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: reviewed }}
              accessibilityLabel="복습 완료 표시"
              testID={`wrong-note-reviewed-${item.sessionId}`}
              hitSlop={8}
              style={[styles.reviewCheck, reviewed && styles.reviewCheckOn]}
              onPress={() => toggleReviewed(item.sessionId)}
            >
              <Text style={[styles.reviewCheckMark, reviewed && styles.reviewCheckMarkOn]}>✓</Text>
            </Pressable>
          </View>
        </Pressable>
      );
    },
    [onSelectSession, reviewedIds, toggleReviewed],
  );

  const keyExtractor = useCallback((item: SessionHistoryEntry) => item.sessionId, []);

  const showingNotes = tab === 'wrongNotes';
  const listData = showingNotes ? wrongNotes : filteredSessions;
  const kindFilters: { key: 'all' | 'concept' | 'solve'; label: string }[] = [
    { key: 'all', label: '전체' },
    { key: 'concept', label: '개념' },
    { key: 'solve', label: '문제풀이' },
  ];

  return (
    <View style={styles.container} testID="history-screen">
      {/* Header */}
      <View style={[styles.header, { paddingTop: safeTop }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="뒤로 가기"
          testID="history-back-button"
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={onBack}
        >
          <Text style={styles.backButtonText}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>학습 기록</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: !showingNotes }}
          testID="history-tab-sessions"
          style={[styles.tabButton, !showingNotes && styles.tabButtonActive]}
          onPress={() => setTab('sessions')}
        >
          <Text style={[styles.tabText, !showingNotes && styles.tabTextActive]}>대화 기록</Text>
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: showingNotes }}
          testID="history-tab-wrong-notes"
          style={[styles.tabButton, showingNotes && styles.tabButtonActive]}
          onPress={() => setTab('wrongNotes')}
        >
          <Text style={[styles.tabText, showingNotes && styles.tabTextActive]}>
            오답노트{wrongNotes.length > 0 ? ` ${wrongNotes.length}` : ''}
          </Text>
        </Pressable>
      </View>

      {/* 대화 기록 종류 필터 — 풀폭 세그먼트 바 대신 작은 좌측 칩(SolveModeToggle
       * 과 같은 톤: 선택 시 그린 채움, 아니면 테두리만). 상단 크롬을 절반으로
       * 줄여 리스트 공간을 되찾는다. */}
      {!showingNotes && (
        <View style={styles.chipRow}>
          {kindFilters.map(({ key, label }) => {
            const selected = kindFilter === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                testID={`history-kind-filter-${key}`}
                hitSlop={{ top: 8, bottom: 8 }}
                style={[styles.chip, selected && styles.chipSelected]}
                onPress={() => setKindFilter(key)}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* Content */}
      {loading ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>불러오는 중...</Text>
        </View>
      ) : listData.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>
            {showingNotes ? '오답노트가 아직 비었어' : '아직 대화 기록이 없어'}
          </Text>
          <Text style={styles.emptySubtitle}>
            {showingNotes
              ? '헤맸던 문제가 생기면 여기에 모아둘게'
              : '비바랑 얘기하면 여기에 남을 거야'}
          </Text>
        </View>
      ) : (
        <Animated.View style={[styles.listWrap, { opacity: listAnim }]}>
          <FlatList
            data={listData}
            renderItem={showingNotes ? renderNoteItem : renderItem}
            keyExtractor={keyExtractor}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: APP_BACKGROUND_COLOR,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    // paddingTop 은 safe-area 기준으로 런타임에 주입한다 (styles 엔 없음).
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -8,
  },
  backButtonPressed: {
    opacity: 0.5,
  },
  backButtonText: {
    fontSize: 30,
    fontWeight: '400',
    color: '#2B2926',
    lineHeight: 34,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: '#2B2926',
    textAlign: 'center',
    fontFamily: 'Pretendard',
  },
  headerSpacer: {
    width: 44,
  },
  tabRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: 'rgba(43, 41, 38, 0.05)',
    borderRadius: 12,
    padding: 3,
  },
  // 종류 필터 칩 - 좌측 정렬, 작은 pill. 선택 시 그린 채움(SolveModeToggle 톤).
  chipRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginHorizontal: 16,
    marginBottom: 10,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 13,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    backgroundColor: 'transparent',
  },
  chipSelected: {
    backgroundColor: GREEN,
    borderColor: GREEN,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '500',
    color: INK_MUTED,
    fontFamily: 'Pretendard',
  },
  chipTextSelected: {
    color: ON_ACCENT,
    fontWeight: '600',
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
  },
  tabButtonActive: {
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1,
    borderColor: SURFACE_BORDER_COLOR,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '500',
    color: 'rgba(43, 41, 38, 0.5)',
    fontFamily: 'Pretendard',
  },
  tabTextActive: {
    color: '#2B2926',
    fontWeight: '600',
  },
  noteBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  topicBadge: {
    backgroundColor: 'rgba(54, 155, 117, 0.12)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 6,
  },
  topicBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#369B75',
    fontFamily: 'Pretendard',
  },
  reasonBadge: {
    backgroundColor: 'rgba(43, 41, 38, 0.06)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  reasonBadgeUnfinished: {
    backgroundColor: 'rgba(214, 106, 77, 0.12)',
  },
  reasonBadgeText: {
    fontSize: 11,
    fontWeight: '500',
    color: 'rgba(43, 41, 38, 0.6)',
    fontFamily: 'Pretendard',
  },
  reasonBadgeTextUnfinished: {
    color: '#D66A4D',
    fontWeight: '600',
  },
  mistakeReasonText: {
    fontSize: 12,
    color: '#D66A4D',
    marginTop: 4,
    fontFamily: 'Pretendard',
  },
  noteCardReviewed: {
    opacity: 0.55,
  },
  notePreviewReviewed: {
    textDecorationLine: 'line-through',
  },
  reviewCheck: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: 'rgba(43, 41, 38, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
  },
  reviewCheckOn: {
    backgroundColor: '#369B75',
    borderColor: '#369B75',
  },
  reviewCheckMark: {
    fontSize: 14,
    color: 'rgba(43, 41, 38, 0.25)',
  },
  reviewCheckMarkOn: {
    color: '#FFFFFF',
  },
  listWrap: {
    flex: 1,
  },
  kindBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    marginBottom: 5,
  },
  kindBadgeConcept: {
    backgroundColor: 'rgba(54, 155, 117, 0.12)',
  },
  kindBadgeSolve: {
    backgroundColor: 'rgba(43, 41, 38, 0.06)',
  },
  kindBadgeTextConcept: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Pretendard',
    color: '#369B75',
  },
  kindBadgeTextSolve: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Pretendard',
    color: 'rgba(43, 41, 38, 0.6)',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  sessionCard: {
    backgroundColor: SURFACE_COLOR,
    borderRadius: 14,
    padding: 13,
    marginBottom: 8,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
  },
  sessionCardPressed: {
    backgroundColor: 'rgba(43, 41, 38, 0.02)',
  },
  sessionCardContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sessionCardText: {
    flex: 1,
    marginRight: 12,
  },
  sessionPreview: {
    fontSize: 15,
    fontWeight: '500',
    color: '#2B2926',
    lineHeight: 22,
    fontFamily: 'Pretendard',
  },
  sessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  sessionDate: {
    fontSize: 12,
    color: 'rgba(43, 41, 38, 0.45)',
    fontFamily: 'Pretendard',
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(43, 41, 38, 0.2)',
    marginHorizontal: 6,
  },
  sessionState: {
    fontSize: 12,
    color: '#369B75',
    fontWeight: '500',
    fontFamily: 'Pretendard',
  },
  sessionHints: {
    fontSize: 12,
    color: 'rgba(43, 41, 38, 0.45)',
    fontFamily: 'Pretendard',
  },
  sessionCost: {
    fontSize: 12,
    color: 'rgba(43, 41, 38, 0.45)',
    fontFamily: 'Pretendard',
  },
  boardThumbnail: {
    width: 56,
    height: 42,
    borderRadius: 8,
    backgroundColor: APP_BACKGROUND_COLOR,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#2B2926',
    textAlign: 'center',
    fontFamily: 'Pretendard',
  },
  emptySubtitle: {
    fontSize: 14,
    color: 'rgba(43, 41, 38, 0.5)',
    textAlign: 'center',
    marginTop: 8,
    fontFamily: 'Pretendard',
  },
  emptyText: {
    fontSize: 14,
    color: 'rgba(43, 41, 38, 0.5)',
    fontFamily: 'Pretendard',
  },
});
