// eslint-config-expo: Expo SDK 51 공식 프리셋 (react/react-native/typescript 룰 포함)
module.exports = {
  root: true,
  extends: ['expo', 'prettier'],
  plugins: ['prettier'],
  rules: {
    'prettier/prettier': 'warn',
    // 공용·폰 코드가 디바이스 그래프를 물면 폰 번들 절단이 무너진다.
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/device/**'],
            message: '디바이스 모듈은 src/device/ 와 App.device.tsx 만 import 할 수 있다.',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ['src/device/**', 'App.device.tsx', 'tools/concept-images/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [{ group: ['**/phone/**'], message: '디바이스 그래프는 폰 변종을 import 할 수 없다.' }],
          },
        ],
      },
    },
    {
      files: ['src/phone/**', 'App.phone.tsx'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [{ group: ['**/device/**'], message: '폰 그래프는 디바이스 모듈을 import 할 수 없다.' }],
          },
        ],
      },
    },
  ],
  ignorePatterns: ['node_modules/', '.expo/', 'dist/'],
};
