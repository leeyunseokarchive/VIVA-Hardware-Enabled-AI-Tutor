import * as ImageManipulator from 'expo-image-manipulator';

/**
 * 앱이 이미 들고 있는 사진(폰 촬영 등 Pi 보관본이 없는 경우)에서 Gemini
 * box_2d 영역을 잘라낸다. 좌표계·여유 마진은 pi-server/imaging.py 의
 * crop_box2d 와 동일: [ymin,xmin,ymax,xmax] 0~1000 정규화, 각 변에 bbox
 * 크기의 5% 패딩 후 프레임 경계로 클램프.
 */
const CROP_MARGIN = 0.05;

export async function cropBase64Image(imageBase64: string, box2d: number[]): Promise<string> {
  const [ymin, xmin, ymax, xmax] = box2d;
  const uri = `data:image/jpeg;base64,${imageBase64}`;
  // 액션 없는 호출로 원본 픽셀 크기만 읽는다.
  const { width, height } = await ImageManipulator.manipulateAsync(uri, []);
  const top = (ymin / 1000) * height;
  const left = (xmin / 1000) * width;
  const bottom = (ymax / 1000) * height;
  const right = (xmax / 1000) * width;
  const padY = (bottom - top) * CROP_MARGIN;
  const padX = (right - left) * CROP_MARGIN;
  const originX = Math.max(0, Math.round(left - padX));
  const originY = Math.max(0, Math.round(top - padY));
  const crop = {
    originX,
    originY,
    width: Math.min(width, Math.round(right + padX)) - originX,
    height: Math.min(height, Math.round(bottom + padY)) - originY,
  };
  const result = await ImageManipulator.manipulateAsync(uri, [{ crop }], {
    compress: 0.8,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  });
  if (!result.base64) throw new Error('crop produced no base64');
  return result.base64;
}
