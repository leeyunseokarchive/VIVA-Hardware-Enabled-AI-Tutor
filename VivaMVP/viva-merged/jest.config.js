// babel-preset-expo 는 EXPO_PUBLIC_* 를 "transform 시점"에 리터럴로 인라인한다.
// 그래서 테스트 안에서 process.env 에 대입해봐야 이미 늦다 - 값이 필요한
// 테스트를 위해 Jest 가 아무것도 변환하기 전에 여기서 기본값을 채운다.
// (실제 값은 `npm test` 의 dotenv 가 .env 에서 먼저 채운다.)
process.env.EXPO_PUBLIC_GOOGLE_TTS_API_KEY ||= 'test-tts-key';
process.env.EXPO_PUBLIC_GEMINI_API_KEY ||= 'test-gemini-key';
process.env.EXPO_PUBLIC_GEMINI_IMAGE_SIZE ||= '2K';

module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    '\\.wav$': '<rootDir>/test-mocks/asset-stub.js',
  },
};
