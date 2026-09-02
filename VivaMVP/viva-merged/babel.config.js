module.exports = function (api) {
  // APP_VARIANT 별로 캐시를 가른다 - 안 가르면 변형 전환 후에도 이전 alias 로
  // 변환된 캐시가 남는다. 전환 시 번들러 재시작(-c) 필요한 건 동일.
  api.cache.using(() => process.env.APP_VARIANT);
  const variant = process.env.APP_VARIANT === 'phone' ? 'phone' : 'device';
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ['module-resolver', { alias: { '@app': `./App.${variant}` } }],
      // react-native-reanimated는 Babel 플러그인이 반드시 필요하다. 반드시
      // presets/plugins 목록의 마지막 항목이어야 한다 (Reanimated 공식 문서 요구사항).
      'react-native-reanimated/plugin',
    ],
  };
};
