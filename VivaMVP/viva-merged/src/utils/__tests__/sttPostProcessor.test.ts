import { postProcessSTT } from '../sttPostProcessor';

describe('postProcessSTT', () => {
  it('keeps normal Korean text unchanged', () => {
    expect(postProcessSTT('이 문제 어떻게 풀어')).toBe('이 문제 어떻게 풀어');
  });
  it('corrects "루트 48" to "√48"', () => {
    expect(postProcessSTT('루트 48이 뭐야')).toBe('√48이 뭐야');
  });
  it('corrects "엑스" to "x"', () => {
    expect(postProcessSTT('엑스 더하기 3')).toBe('x 더하기 3');
  });
  it('corrects "사인 세타" to "sin θ"', () => {
    expect(postProcessSTT('사인 세타가 뭐야')).toBe('sin θ가 뭐야');
  });
  it('corrects compound math terms', () => {
    expect(postProcessSTT('이차 방정식')).toBe('이차방정식');
    expect(postProcessSTT('삼각 비')).toBe('삼각비');
    expect(postProcessSTT('인수 분해')).toBe('인수분해');
  });
  it('corrects "파이 알 제곱" to "πr²"', () => {
    expect(postProcessSTT('파이 알 제곱')).toBe('πr²');
  });
  it('corrects "엑스의 제곱" to "x²"', () => {
    expect(postProcessSTT('엑스의 제곱 더하기 3')).toBe('x² 더하기 3');
  });
});
