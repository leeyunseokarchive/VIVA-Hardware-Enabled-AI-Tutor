import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { loadAllSessions } from '../services/sessionHistory.service';
import { loadSessionEvents, type SessionEvent } from '../services/sessionLog.service';
import { formatUsd, formatWithCommas } from '../services/apiPricing.service';
import { cleanMathForSubtitle } from '../utils/mathTextProcessor';
import type { SessionHistoryEntry, HistoryMessage } from '../types/SessionHistory';
import SessionDebugSection from '../components/SessionDebugSection';

import {
  APP_BACKGROUND_COLOR,
  SURFACE_COLOR,
  SURFACE_BORDER_COLOR,
} from '../services/board.service';
import { GREEN, MOTION } from '../theme';
import { resolveTopic } from './HistoryScreen';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

interface SessionDetailScreenProps {
  sessionId: string;
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

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const period = hours >= 12 ? '오후' : '오전';
  const displayHours = hours > 12 ? hours - 12 : hours || 12;
  return `${period} ${displayHours}:${minutes}`;
}

export default function SessionDetailScreen({
  sessionId,
  onBack,
  onSelectSession,
}: SessionDetailScreenProps): React.JSX.Element {
  const [session, setSession] = useState<SessionHistoryEntry | null>(null);
  const [followUps, setFollowUps] = useState<SessionHistoryEntry[]>([]);
  const [parent, setParent] = useState<SessionHistoryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  // __DEV__ 디버그 섹션용 턴 이벤트 (viva_session_events 의 유일한 리더).
  const [debugEvents, setDebugEvents] = useState<SessionEvent[]>([]);
  const [expandedMsgIndex, setExpandedMsgIndex] = useState<number | null>(null);
  // 개념↔문제풀이 링크 섹션 등장 페이드 (MOTION.fast).
  const linkFade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    loadAllSessions()
      .then((all) => {
        const found = all.find((s) => s.sessionId === sessionId) || null;
        setSession(found);
        setFollowUps(all.filter((s) => s.parentConceptSessionId === sessionId));
        setParent(
          found?.parentConceptSessionId
            ? all.find((s) => s.sessionId === found.parentConceptSessionId) || null
            : null,
        );
      })
      .finally(() => setLoading(false));
    if (__DEV__) {
      loadSessionEvents(sessionId).then(setDebugEvents);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!session) return;
    Animated.timing(linkFade, {
      toValue: 1,
      duration: MOTION.fast,
      useNativeDriver: true,
    }).start();
  }, [session, followUps, parent, linkFade]);

  /** 메시지 발화 시각과 ±5초 안에서 가장 가까운 턴 이벤트 (타임스탬프 버그
   * 수정 이후 저장된 세션에서만 의미 있게 매칭된다). */
  const eventNearMessage = useCallback(
    (msg: HistoryMessage): SessionEvent | undefined => {
      if (!__DEV__ || msg.role !== 'model') return undefined;
      let best: SessionEvent | undefined;
      let bestGap = 5000;
      for (const e of debugEvents) {
        const gap = Math.abs(e.timestamp - msg.timestamp);
        if (gap <= bestGap) {
          best = e;
          bestGap = gap;
        }
      }
      return best;
    },
    [debugEvents],
  );

  const handleShareBoardImage = useCallback(async (imageUrl: string) => {
    try {
      // imageUrl is now a Supabase Storage public URL (not a local file path),
      // so we share the remote URL directly instead of checking a local path.
      await Share.share({
        url: imageUrl,
        message: imageUrl,
      });
    } catch (err) {
      console.warn('[SessionDetail] Share failed:', err);
    }
  }, []);

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="뒤로 가기"
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={onBack}
          >
            <Text style={styles.backButtonText}>‹</Text>
          </Pressable>
          <Text style={styles.headerTitle}>불러오는 중...</Text>
          <View style={styles.headerSpacer} />
        </View>
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="뒤로 가기"
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={onBack}
          >
            <Text style={styles.backButtonText}>‹</Text>
          </Pressable>
          <Text style={styles.headerTitle}>기록을 못 찾았어</Text>
          <View style={styles.headerSpacer} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="session-detail-screen">
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="뒤로 가기"
          testID="session-detail-back-button"
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={onBack}
        >
          <Text style={styles.backButtonText}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{formatDate(session.startedAt)}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* 문제 풀이 → 시작한 개념 대화로 돌아가는 링크 */}
      {session.kind === 'solve' && session.parentConceptSessionId && (
        <Animated.View style={{ opacity: linkFade }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${parent?.preview || '개념 대화'} 개념 대화로 이동`}
            testID="session-detail-parent-link"
            style={({ pressed }) => [
              styles.linkCard,
              styles.linkCardTop,
              pressed && styles.linkCardPressed,
            ]}
            onPress={() => onSelectSession(session.parentConceptSessionId!)}
          >
            <Text style={styles.linkChevron}>‹</Text>
            <View style={styles.kindBadgeConcept}>
              <Text style={styles.kindBadgeConceptText}>개념</Text>
            </View>
            <Text style={styles.linkText} numberOfLines={1}>
              {parent?.preview || '개념 대화'} 에서 시작됨
            </Text>
          </Pressable>
        </Animated.View>
      )}

      {/* 단원 + 힌트 횟수 */}
      <View style={styles.metaRow}>
        <View style={styles.topicBadge}>
          <Text style={styles.topicBadgeText}>{resolveTopic(session)}</Text>
        </View>
        {session.kind !== 'concept' && session.hintCount > 0 && (
          <Text style={styles.metaHintText}>힌트 {session.hintCount}회</Text>
        )}
      </View>

      {/* 틀린 이유 */}
      {session.mistakeReason && (
        <View style={styles.mistakeReasonRow} testID="session-detail-mistake-reason">
          <Text style={styles.mistakeReasonLabel}>틀린 이유</Text>
          <Text style={styles.mistakeReasonValue}>{session.mistakeReason}</Text>
        </View>
      )}

      {/* Messages */}
      <ScrollView
        style={styles.messagesContainer}
        contentContainerStyle={styles.messagesContent}
        showsVerticalScrollIndicator={false}
      >
        {session.messages.map((msg: HistoryMessage, index: number) => {
          const nearEvent = eventNearMessage(msg);
          return (
            <View key={`msg-${index}`}>
              <View
                style={[
                  styles.messageBubbleContainer,
                  msg.role === 'user' ? styles.userBubbleContainer : styles.modelBubbleContainer,
                ]}
              >
                {msg.role === 'model' && (
                  <View style={styles.modelAvatar}>
                    <Text style={styles.modelAvatarText}>V</Text>
                  </View>
                )}
                <View
                  style={[
                    styles.messageBubble,
                    msg.role === 'user' ? styles.userBubble : styles.modelBubble,
                  ]}
                >
                  <Text
                    style={[
                      styles.messageText,
                      msg.role === 'user' ? styles.userMessageText : styles.modelMessageText,
                    ]}
                  >
                    {msg.role === 'model' ? cleanMathForSubtitle(msg.message) : msg.message}
                  </Text>
                </View>
                {nearEvent && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="이 턴의 상태 보기"
                    hitSlop={10}
                    onPress={() => setExpandedMsgIndex(expandedMsgIndex === index ? null : index)}
                    style={({ pressed }) => [styles.turnBadge, pressed && { opacity: 0.6 }]}
                  >
                    <Text style={styles.turnBadgeText}>
                      {nearEvent.fsmState ?? nearEvent.appState}
                    </Text>
                  </Pressable>
                )}
              </View>
              {nearEvent && expandedMsgIndex === index && (
                <View style={styles.turnDetail}>
                  <Text style={styles.turnDetailText} selectable>
                    {JSON.stringify(nearEvent.meta ?? {}, null, 1)
                      .replace(/[{}"]/g, '')
                      .trim()}
                  </Text>
                </View>
              )}
            </View>
          );
        })}

        {/* Board images at the end */}
        {session.boardImages.length > 0 && (
          <View style={styles.boardSection}>
            <Text style={styles.boardSectionTitle}>판서 이미지</Text>
            {session.boardImages.map((board, index) => (
              <Pressable
                key={`board-${index}`}
                accessibilityRole="button"
                accessibilityLabel="판서 이미지 공유"
                onLongPress={() => handleShareBoardImage(board.filePath)}
                style={({ pressed }) => [
                  styles.boardImageContainer,
                  pressed && styles.boardImagePressed,
                ]}
              >
                <Image
                  source={{ uri: board.filePath }}
                  style={styles.boardImage}
                  resizeMode="contain"
                />
                <Text style={styles.boardTimestamp}>
                  {formatTime(board.timestamp)} · 길게 눌러서 저장/공유
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {session.usage && session.usage.textCalls + session.usage.imageCalls > 0 && (
          <View style={styles.usageSection} testID="session-usage-section">
            <Text style={styles.usageSectionTitle}>API 사용량</Text>
            <View style={styles.usageCard}>
              <View style={styles.usageRow}>
                <Text style={styles.usageLabel}>총 토큰</Text>
                <Text style={styles.usageValue}>{formatWithCommas(session.usage.totalTokens)}</Text>
              </View>
              <View style={styles.usageRow}>
                <Text style={styles.usageLabel}>입력 · 출력 토큰</Text>
                <Text style={styles.usageValue}>
                  {formatWithCommas(session.usage.promptTokens)} ·{' '}
                  {formatWithCommas(session.usage.candidateTokens)}
                </Text>
              </View>
              <View style={styles.usageRow}>
                <Text style={styles.usageLabel}>API 호출</Text>
                <Text style={styles.usageValue}>
                  텍스트 {session.usage.textCalls}회 · 이미지 {session.usage.imageCalls}회
                </Text>
              </View>
              <View style={[styles.usageRow, styles.usageCostRow]}>
                <Text style={styles.usageLabel}>예상 비용</Text>
                <Text style={styles.usageCostValue} testID="session-usage-cost-value">
                  {formatUsd(session.usage.costUsd)}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* 개발 빌드 전용 디버그 섹션 (스펙 2026-07-29) */}
        {__DEV__ && <SessionDebugSection debug={session.debug} events={debugEvents} />}

        {/* 개념 대화에서 이어진 문제 풀이 세션들 */}
        {session.kind === 'concept' && followUps.length > 0 && (
          <Animated.View style={[styles.boardSection, { opacity: linkFade }]}>
            <Text style={styles.boardSectionTitle}>이어지는 문제 풀이</Text>
            {followUps.map((followUp) => (
              <Pressable
                key={`followup-${followUp.sessionId}`}
                accessibilityRole="button"
                accessibilityLabel={`문제 풀이 ${followUp.preview}로 이동`}
                testID={`session-detail-followup-${followUp.sessionId}`}
                style={({ pressed }) => [styles.linkCard, pressed && styles.linkCardPressed]}
                onPress={() => onSelectSession(followUp.sessionId)}
              >
                <View style={styles.kindBadgeSolve}>
                  <Text style={styles.kindBadgeSolveText}>문제풀이</Text>
                </View>
                <View style={styles.linkCardBody}>
                  <Text style={styles.linkCardTitle} numberOfLines={2}>
                    {followUp.preview || '문제 풀이'}
                  </Text>
                  <Text style={styles.linkCardDate}>{formatDate(followUp.startedAt)}</Text>
                </View>
              </Pressable>
            ))}
          </Animated.View>
        )}
      </ScrollView>
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
    paddingTop: 60,
    paddingHorizontal: 16,
    paddingBottom: 16,
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
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  messageBubbleContainer: {
    flexDirection: 'row',
    marginBottom: 12,
    alignItems: 'flex-end',
  },
  userBubbleContainer: {
    justifyContent: 'flex-end',
  },
  modelBubbleContainer: {
    justifyContent: 'flex-start',
  },
  modelAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#369B75',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginBottom: 2,
  },
  modelAvatarText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
    fontFamily: 'Pretendard',
  },
  messageBubble: {
    maxWidth: '75%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 16,
  },
  userBubble: {
    backgroundColor: '#369B75',
    borderBottomRightRadius: 4,
    marginLeft: 'auto',
  },
  modelBubble: {
    backgroundColor: SURFACE_COLOR,
    borderBottomLeftRadius: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 3,
    elevation: 1,
  },
  messageText: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: 'Pretendard',
  },
  userMessageText: {
    color: '#FFFFFF',
  },
  modelMessageText: {
    color: '#2B2926',
  },
  boardSection: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(43, 41, 38, 0.08)',
  },
  boardSectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(43, 41, 38, 0.5)',
    marginBottom: 12,
    fontFamily: 'Pretendard',
  },
  boardImageContainer: {
    marginBottom: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: SURFACE_COLOR,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  boardImagePressed: {
    opacity: 0.85,
  },
  boardImage: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: APP_BACKGROUND_COLOR,
  },
  boardTimestamp: {
    fontSize: 11,
    color: 'rgba(43, 41, 38, 0.35)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: 'Pretendard',
  },
  usageSection: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(43, 41, 38, 0.08)',
  },
  usageSectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(43, 41, 38, 0.5)',
    marginBottom: 12,
    fontFamily: 'Pretendard',
  },
  usageCard: {
    backgroundColor: SURFACE_COLOR,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    gap: 10,
  },
  usageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  usageCostRow: {
    marginTop: 4,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(43, 41, 38, 0.08)',
  },
  usageLabel: {
    fontSize: 13,
    color: 'rgba(43, 41, 38, 0.5)',
    fontFamily: 'Pretendard',
  },
  usageValue: {
    fontSize: 13,
    fontWeight: '500',
    color: '#2B2926',
    fontFamily: 'Pretendard',
  },
  usageCostValue: {
    fontSize: 15,
    fontWeight: '700',
    color: '#369B75',
    fontFamily: 'Pretendard',
  },
  // 개념↔문제풀이 링크 카드 (surface 스타일)
  linkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  linkCardTop: {
    marginHorizontal: 16,
    marginBottom: 12,
  },
  linkCardPressed: {
    opacity: 0.85,
  },
  linkChevron: {
    fontSize: 22,
    fontWeight: '400',
    color: GREEN,
    marginLeft: -2,
    lineHeight: 24,
  },
  linkText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: GREEN,
    fontFamily: 'Pretendard',
  },
  linkCardBody: {
    flex: 1,
    gap: 4,
  },
  linkCardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2B2926',
    lineHeight: 20,
    fontFamily: 'Pretendard',
  },
  linkCardDate: {
    fontSize: 12,
    color: 'rgba(43, 41, 38, 0.5)',
    fontFamily: 'Pretendard',
  },
  // kind 배지 (히스토리 목록과 동일 스펙)
  kindBadgeConcept: {
    backgroundColor: 'rgba(54, 155, 117, 0.12)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  kindBadgeConceptText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#369B75',
    fontFamily: 'Pretendard',
  },
  kindBadgeSolve: {
    backgroundColor: 'rgba(43, 41, 38, 0.06)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  kindBadgeSolveText: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(43, 41, 38, 0.6)',
    fontFamily: 'Pretendard',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  topicBadge: {
    backgroundColor: 'rgba(54, 155, 117, 0.12)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  topicBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#369B75',
    fontFamily: 'Pretendard',
  },
  metaHintText: {
    fontSize: 12,
    fontWeight: '500',
    color: 'rgba(43, 41, 38, 0.5)',
    fontFamily: 'Pretendard',
  },
  mistakeReasonRow: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  mistakeReasonLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#D66A4D',
    marginBottom: 4,
    fontFamily: 'Pretendard',
  },
  mistakeReasonValue: {
    fontSize: 13,
    color: '#2B2926',
    lineHeight: 19,
    fontFamily: 'Pretendard',
  },
  // __DEV__ 턴 상태 뱃지 (메시지 버블 옆)
  turnBadge: {
    alignSelf: 'flex-end',
    marginLeft: 6,
    marginBottom: 2,
    borderWidth: 1,
    borderColor: 'rgba(43, 41, 38, 0.25)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  turnBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: 'rgba(43, 41, 38, 0.55)',
    fontFamily: MONO,
  },
  turnDetail: {
    marginLeft: 36,
    marginBottom: 12,
    marginTop: -6,
    backgroundColor: '#232120',
    borderRadius: 8,
    padding: 10,
  },
  turnDetailText: {
    fontSize: 10,
    lineHeight: 15,
    color: '#E8E4DC',
    fontFamily: MONO,
  },
});
