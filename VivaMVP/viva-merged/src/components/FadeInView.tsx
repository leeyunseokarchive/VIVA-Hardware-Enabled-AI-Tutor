import React, { useEffect, useRef } from 'react';
import { Animated, type StyleProp, type ViewStyle } from 'react-native';
import { MOTION } from '../theme';

interface FadeInViewProps {
  children: React.ReactNode;
  /** 기본 MOTION.base(220ms) - 화면 전환 등 큰 요소는 MOTION.slow, 배지 등
   * 작은 요소는 MOTION.fast 를 넘긴다. */
  duration?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * 마운트 시 opacity 0→1 로 한 번 페이드인만 하는 최소 래퍼 (2026-08-13 UX
 * 통일). RN 은 언마운트를 즉시 처리하므로 exit 애니메이션은 지원하지 않는다
 * - ponytail: 화면 전환 상태 머신 없이 마운트 시점 페이드 하나로 충분.
 * 다시 재생하려면 부모가 key prop 을 바꿔 리마운트시키면 된다.
 */
export default function FadeInView({
  children,
  duration = MOTION.base,
  style,
}: FadeInViewProps): React.JSX.Element {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.timing(opacity, {
      toValue: 1,
      duration,
      useNativeDriver: true,
    });
    anim.start();
    // 진행 중 언마운트되면 타이머가 남아 죽은 스코프를 건드리는 걸 막는다.
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Animated.View style={[style, { opacity }]}>{children}</Animated.View>;
}
