// openWakeWord용 .onnx 모델을 Metro가 에셋으로 번들하도록 확장자를 등록한다.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('onnx');

// Metro 변환 캐시는 APP_VARIANT 를 모른다 - babel alias 가 @app 을 변형별로
// 다르게 풀어도 캐시 키가 같아, 변형 전환 후 이전 변형 번들이 그대로 나온다
// (Task 8 실측: --clear 없이 phone/device export 가 byte-identical).
// cacheVersion 에 변형을 박아 전환 즉시 캐시가 갈리게 한다.
const variant = process.env.APP_VARIANT === 'phone' ? 'phone' : 'device';
config.cacheVersion = `${config.cacheVersion ? `${config.cacheVersion}-` : ''}${variant}`;

module.exports = config;
