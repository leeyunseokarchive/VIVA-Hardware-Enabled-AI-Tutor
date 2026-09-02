import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

export type EyeState = 'idle' | 'calling' | 'processing' | 'conversation' | 'listening';

interface EyeAnimationProps {
  state: EyeState;
}

const EASE = Easing.inOut(Easing.ease);

export default function EyeAnimation({ state }: EyeAnimationProps): React.JSX.Element {
  const scaleY = useRef(new Animated.Value(1)).current;
  const idleDrift = useRef(new Animated.Value(0)).current;
  const thinkingDrift = useRef(new Animated.Value(0)).current;
  const callingLeftScale = useRef(new Animated.Value(1)).current;
  const callingRightScale = useRef(new Animated.Value(1)).current;
  const callingPulse = useRef(new Animated.Value(1)).current;

  // 폰 화면의 눈은 이 기능의 대상이 아니다 - 로봇 마이크 모드에서 학생은
  // 로봇 얼굴을 보지 폰을 안 본다(2026-08-07 확인). listening 은 타입만
  // 통과시키고 conversation 과 같게 그린다. 실제 끄덕임은 로봇이 그린다
  // (pi-server/eyes.py 의 listening 상태).
  const effectiveState: EyeState = state === 'listening' ? 'conversation' : state;

  // Cross-fade the whole eye subtree whenever `state` changes, instead of
  // hard-swapping the View tree (each state renders a structurally
  // different tree, so this is the simplest smooth transition achievable
  // without migrating off the Animated API).
  const containerOpacity = useRef(new Animated.Value(1)).current;
  const [renderedState, setRenderedState] = useState(effectiveState);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      setRenderedState(effectiveState);
      return;
    }
    if (effectiveState === renderedState) {
      return;
    }
    Animated.timing(containerOpacity, {
      toValue: 0,
      duration: 120,
      easing: EASE,
      useNativeDriver: true,
    }).start(() => {
      setRenderedState(effectiveState);
      Animated.timing(containerOpacity, {
        toValue: 1,
        duration: 180,
        easing: EASE,
        useNativeDriver: true,
      }).start();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveState]);

  // Blinking + subtle idle "breathing" drift for 'idle' and 'conversation'
  useEffect(() => {
    if (renderedState === 'idle' || renderedState === 'conversation') {
      let timeoutId: ReturnType<typeof setTimeout>;

      const blink = () => {
        Animated.sequence([
          Animated.timing(scaleY, {
            toValue: 0.08,
            duration: 150,
            easing: EASE,
            useNativeDriver: true,
          }),
          Animated.timing(scaleY, {
            toValue: 1,
            duration: 150,
            easing: EASE,
            useNativeDriver: true,
          }),
        ]).start();
      };

      const scheduleNextBlink = () => {
        const delay = 3000 + Math.random() * 3000; // 3-6s, feels less mechanical than a fixed interval
        timeoutId = setTimeout(() => {
          blink();
          scheduleNextBlink();
        }, delay);
      };
      scheduleNextBlink();

      const drift = Animated.loop(
        Animated.sequence([
          Animated.timing(idleDrift, {
            toValue: 1,
            duration: 1800,
            easing: EASE,
            useNativeDriver: true,
          }),
          Animated.timing(idleDrift, {
            toValue: 0,
            duration: 1800,
            easing: EASE,
            useNativeDriver: true,
          }),
        ]),
      );
      drift.start();

      return () => {
        clearTimeout(timeoutId);
        drift.stop();
        idleDrift.setValue(0);
      };
    } else {
      scaleY.setValue(1);
    }
    return undefined;
  }, [renderedState, scaleY, idleDrift]);

  // Subtle "considering" breathing motion for the thinking bars in 'processing'
  useEffect(() => {
    if (renderedState === 'processing') {
      const breathe = Animated.loop(
        Animated.sequence([
          Animated.timing(thinkingDrift, {
            toValue: 1,
            duration: 1500,
            easing: EASE,
            useNativeDriver: true,
          }),
          Animated.timing(thinkingDrift, {
            toValue: 0,
            duration: 1500,
            easing: EASE,
            useNativeDriver: true,
          }),
        ]),
      );
      breathe.start();
      return () => {
        breathe.stop();
        thinkingDrift.setValue(0);
      };
    }
    return undefined;
  }, [renderedState, thinkingDrift]);

  // Calling: a quick "startled" asymmetric pop on entry (left eye grows,
  // right eye shrinks, matching the design's surprised reaction), followed
  // by a continuous gentle breathing loop and a pulse on the "!" mark.
  useEffect(() => {
    if (renderedState === 'calling') {
      callingLeftScale.setValue(0.9);
      callingRightScale.setValue(1.1);

      const startle = Animated.parallel([
        Animated.spring(callingLeftScale, {
          toValue: 1,
          friction: 4,
          tension: 60,
          useNativeDriver: true,
        }),
        Animated.spring(callingRightScale, {
          toValue: 1,
          friction: 4,
          tension: 60,
          useNativeDriver: true,
        }),
      ]);

      const breathe = Animated.loop(
        Animated.sequence([
          Animated.timing(callingPulse, {
            toValue: 1.08,
            duration: 800,
            easing: EASE,
            useNativeDriver: true,
          }),
          Animated.timing(callingPulse, {
            toValue: 1,
            duration: 800,
            easing: EASE,
            useNativeDriver: true,
          }),
        ]),
      );

      // Only chain into the breathing loop if the startle animation actually
      // finished on its own. `startle.stop()` (fired by this effect's own
      // cleanup below, e.g. on unmount or a fast state change) also invokes
      // this completion callback with `finished: false` - without this
      // guard, breathe.start() would fire an animation on a component that
      // may already be unmounted, crashing with "Unable to find node on an
      // unmounted component".
      startle.start(({ finished }) => {
        if (finished) breathe.start();
      });

      return () => {
        startle.stop();
        breathe.stop();
        callingLeftScale.setValue(1);
        callingRightScale.setValue(1);
        callingPulse.setValue(1);
      };
    }
    return undefined;
  }, [renderedState, callingLeftScale, callingRightScale, callingPulse]);

  const idleDriftY = idleDrift.interpolate({ inputRange: [0, 1], outputRange: [0, 3] });
  const thinkingScaleY = thinkingDrift.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] });

  // Render eye configurations based on the (fade-lagged) rendered state.
  // Every branch is centered by `styles.root` regardless of parent layout.
  let content: React.JSX.Element;
  if (renderedState === 'processing') {
    content = (
      <View style={styles.eyeRow}>
        <Animated.View style={[styles.thinkingEye, { transform: [{ scaleY: thinkingScaleY }] }]} />
        <Animated.View style={[styles.thinkingEye, { transform: [{ scaleY: thinkingScaleY }] }]} />
      </View>
    );
  } else if (renderedState === 'calling') {
    content = (
      <View style={styles.eyeRowCalling}>
        <Animated.View
          style={[styles.leftCallingEye, { transform: [{ scale: callingLeftScale }] }]}
        />
        <Animated.View
          style={[styles.rightCallingEye, { transform: [{ scale: callingRightScale }] }]}
        />
        <Animated.Text style={[styles.exclamationMark, { transform: [{ scale: callingPulse }] }]}>
          !
        </Animated.Text>
      </View>
    );
  } else {
    // 'idle' or 'conversation'
    content = (
      <View style={styles.defaultContainer}>
        <Animated.View
          style={[styles.defaultEye, { transform: [{ scaleY }, { translateY: idleDriftY }] }]}
        />
        <Animated.View
          style={[styles.defaultEye, { transform: [{ scaleY }, { translateY: idleDriftY }] }]}
        />
      </View>
    );
  }

  return (
    <Animated.View style={[styles.root, { opacity: containerOpacity }]}>{content}</Animated.View>
  );
}

const styles = StyleSheet.create({
  // Fills whatever space the parent gives it and centers the eyes within
  // it, so the animation is always screen-centered regardless of which
  // screen/overlay embeds it (no percentage-of-ambiguous-parent sizing).
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  defaultContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 40,
  },
  defaultEye: {
    width: 34,
    height: 66,
    backgroundColor: '#369B75',
    borderRadius: 17,
  },
  eyeRowCalling: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 44,
    position: 'relative',
  },
  leftCallingEye: {
    width: 38,
    height: 76,
    backgroundColor: '#369B75',
    borderRadius: 19,
  },
  rightCallingEye: {
    width: 31,
    height: 60,
    backgroundColor: '#369B75',
    borderRadius: 15.5,
  },
  // Anchored to the eye row itself (a definite-size box) with a fixed
  // pixel offset, rather than a percentage of the outer container - this
  // keeps it correctly placed regardless of what wraps EyeAnimation.
  exclamationMark: {
    fontSize: 56,
    lineHeight: 56,
    fontWeight: '900',
    color: '#369B75',
    position: 'absolute',
    top: -40,
    right: -8,
  },
  eyeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 36,
  },
  thinkingEye: {
    width: 32,
    height: 14,
    backgroundColor: '#369B75',
    borderRadius: 7,
  },
});
