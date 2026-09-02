import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

/** 순수 View 격자 QR 렌더 - react-native-svg 등 네이티브 모듈 없이 그린다
 * (프로비저닝 스펙 §4). 행별 같은 색 연속 구간(run)을 하나의 View로 합쳐
 * 29x29 기준 셀 841개 대신 run 수백 개만 만든다. 스캐너 규격상 QR 주변엔
 * 4모듈 quiet zone(흰 여백)이 필요해 패딩으로 확보한다. */
const QUIET_MODULES = 4;

interface Props {
  matrix: boolean[][];
  /** quiet zone 포함 전체 한 변(px) */
  size: number;
}

function rowRuns(row: boolean[]): { dark: boolean; len: number }[] {
  const runs: { dark: boolean; len: number }[] = [];
  for (const dark of row) {
    const last = runs[runs.length - 1];
    if (last && last.dark === dark) last.len += 1;
    else runs.push({ dark, len: 1 });
  }
  return runs;
}

export default function QrCodeView({ matrix, size }: Props): React.JSX.Element {
  const n = matrix.length;
  const cell = size / (n + QUIET_MODULES * 2);
  const runsByRow = useMemo(() => matrix.map(rowRuns), [matrix]);
  return (
    <View style={[styles.box, { width: size, height: size, padding: cell * QUIET_MODULES }]}>
      {runsByRow.map((runs, r) => (
        <View key={r} testID="qr-row" style={[styles.row, { height: cell }]}>
          {runs.map((run, i) => (
            <View
              key={i}
              testID="qr-run"
              style={{
                width: run.len * cell,
                backgroundColor: run.dark ? '#000000' : '#FFFFFF',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // 흰 배경 필수 - 카드가 아니라 스캔 대상이라 대비가 규격이다.
  box: { backgroundColor: '#FFFFFF', borderRadius: 12 },
  row: { flexDirection: 'row' },
});
