/**
 * box_2d 정규화 좌표 -> 픽셀 crop 변환이 pi-server/imaging.py 의 crop_box2d
 * 와 같은 규칙(5% 마진 + 프레임 클램프)인지 확인한다. 네트워크·네이티브 없음.
 */
import { cropBase64Image } from '../cropImage';

const mockManipulate = jest.fn();
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...args: unknown[]) => mockManipulate(...args),
  SaveFormat: { JPEG: 'jpeg' },
}));

beforeEach(() => {
  mockManipulate.mockReset();
  // 1차 호출: 크기 조회 (2000x1000), 2차 호출: 실제 크롭.
  mockManipulate
    .mockResolvedValueOnce({ width: 2000, height: 1000 })
    .mockResolvedValueOnce({ base64: 'cropped-b64' });
});

it('crops the normalized bbox with 5% margin, clamped to the frame', async () => {
  // bbox: y 100~500, x 250~750 (0~1000) -> px y 100~500, x 500~1500
  const result = await cropBase64Image('src-b64', [100, 250, 500, 750]);

  expect(result).toBe('cropped-b64');
  const [, actions] = mockManipulate.mock.calls[1];
  // pad_y = 400*0.05 = 20, pad_x = 1000*0.05 = 50
  expect(actions).toEqual([{ crop: { originX: 450, originY: 80, width: 1100, height: 440 } }]);
});

it('clamps the margin at the frame edges', async () => {
  // bbox 가 프레임 왼쪽 위 모서리에 붙어 있음 - 마진이 음수 좌표로 못 나간다.
  await cropBase64Image('src-b64', [0, 0, 500, 500]);

  const [, actions] = mockManipulate.mock.calls[1];
  expect(actions[0].crop.originX).toBe(0);
  expect(actions[0].crop.originY).toBe(0);
});
