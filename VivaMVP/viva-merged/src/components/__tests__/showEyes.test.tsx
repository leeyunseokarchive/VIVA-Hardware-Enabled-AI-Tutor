import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import CharacterView from '../CharacterView';
import ProcessingView from '../ProcessingView';
import EyeAnimation from '../EyeAnimation';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('showEyes 게이팅', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
  });

  it('CharacterView showEyes=false: 눈 없음 + 중앙 자막 표시', () => {
    act(() => {
      renderer = ReactTestRenderer.create(
        <CharacterView showEyes={false} centerSubtitle="루트 25는 뭘까?" showMic={false} />,
      );
    });
    expect(renderer!.root.findAllByType(EyeAnimation)).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain('루트 25는 뭘까?');
  });

  it('CharacterView 기본값: 눈 표시 (기존 동작 무손상)', () => {
    act(() => {
      renderer = ReactTestRenderer.create(<CharacterView showMic={false} />);
    });
    expect(renderer!.root.findAllByType(EyeAnimation)).toHaveLength(1);
  });

  it('ProcessingView showEyes=false: 눈 없이 문구만', () => {
    act(() => {
      renderer = ReactTestRenderer.create(<ProcessingView showEyes={false} />);
    });
    expect(renderer!.root.findAllByType(EyeAnimation)).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain('찍은 사진');
  });
});
