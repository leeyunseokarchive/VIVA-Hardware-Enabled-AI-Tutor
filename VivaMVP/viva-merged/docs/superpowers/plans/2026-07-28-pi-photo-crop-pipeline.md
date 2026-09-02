# Pi Photo Crop Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pi 사진 인식률 개선 — 재촬영 없이 Pi가 보관한 12MP 원본을 Gemini가 준 문제별 bbox로 크롭해 문제당 유효 픽셀을 극대화한다.

**Architecture:** Pi가 촬영 시 12MP 원본을 디스크에 보관하고 전송용 2048폭 축소본을 따로 만든다(앱 쪽 이중 JPEG 리사이즈 삭제). 1차 Gemini 분석(analyzeImage)이 문제별 bbox(`problems[]`, 0~1000 정규화)를 함께 반환한다. 문제 2개 이상이면 FSM이 "몇 번 문제 풀고 있어?"를 묻고, 대답에 매칭된 bbox를 Pi `/photo/crop`으로 잘라 고해상 크롭으로 튜터링을 시작한다. 문제 1개 + 인식 실패면 크롭 재분석 1회 후에야 재촬영을 요청한다. 모든 크롭 실패는 풀프레임 폴백 — 최악이 현상 유지.

**Tech Stack:** Python 3 + Flask + Pillow (pi-server), React Native + TypeScript + Jest (앱), `@google/generative-ai` SDK (변경 없음).

**Spec:** `docs/superpowers/specs/2026-07-28-pi-photo-crop-pipeline-design.md`

## Global Constraints

- 작업 디렉터리: 저장소 루트의 `viva-merged/`. 아래 모든 경로는 `viva-merged/` 기준, 모든 명령은 `viva-merged/`에서 실행.
- 브랜치: `fix/pi-photo-crop` (main에서 분기, Task 1 Step 0에서 생성).
- Jest: `npx jest <경로>`. 타입체크: `npx tsc --noEmit` — **기존 에러 5개는 무시** (CameraScreen `inset` 스타일, expo-av `AVPlaybackStatus.error` 내로잉, 오래된 테스트 타입 2건). 새 에러만 0개 유지.
- pi-server 테스트는 Pillow 필요: `python3 -c "import PIL"` 실패 시 `pip3 install --user pillow`.
- 폰 카메라 경로(CameraScreen)는 변경 금지. `problems` 필드는 어디서도 필수값이 아니다.
- bbox 좌표계는 전 구간 Gemini `box_2d` 그대로: `[ymin, xmin, ymax, xmax]`, 0~1000 정규화.
- SDK 교체·`media_resolution`·AWB·OpenCV는 범위 외 (스펙 "범위 외" 참조).

---

### Task 1: pi-server 순수 이미지 함수 (imaging.py)

**Files:**
- Create: `pi-server/imaging.py`
- Test: `pi-server/test_imaging.py`

**Interfaces:**
- Produces: `parse_box2d(args) -> tuple[tuple[int,int,int,int]|None, str|None]`, `crop_box2d(img, box2d, margin=0.05) -> Image`, `resize_to_width(img, width) -> Image`, `write_transfer_copy(src_path, dst_path, width=2048, quality=85) -> None` — Task 2의 app.py가 사용.

- [ ] **Step 0: 브랜치 생성**

```bash
git checkout -b fix/pi-photo-crop
```

- [ ] **Step 1: 실패하는 테스트 작성**

`pi-server/test_imaging.py`:

```python
"""imaging.py 단위 체크. 하드웨어 없이 python3 test_imaging.py 로 돈다."""
from PIL import Image

from imaging import crop_box2d, parse_box2d, resize_to_width


def make_test_image(w=1000, h=800):
    """회색 배경에 좌표를 아는 흰 사각형(px 300..699 x, 200..599 y)."""
    img = Image.new("RGB", (w, h), (128, 128, 128))
    for x in range(300, 700):
        for y in range(200, 600):
            img.putpixel((x, y), (255, 255, 255))
    return img


def test_crop_contains_white_box_with_margin():
    img = make_test_image()
    # 흰 사각형과 정확히 일치하는 bbox (0~1000 정규화; w=1000, h=800이라
    # x는 그대로, y는 200/800*1000=250, 600/800*1000=750)
    out = crop_box2d(img, (250, 300, 750, 700), margin=0.05)
    # 5% 여백이 붙어 흰 영역보다 커야 한다
    assert out.width > 400, f"width {out.width} should exceed box width 400"
    assert out.height > 400, f"height {out.height} should exceed box height 400"
    # 크롭 중앙은 흰색
    assert out.getpixel((out.width // 2, out.height // 2)) == (255, 255, 255)
    # 크롭이 이미지 전체는 아니어야 한다 (실제로 잘렸는지)
    assert out.width < img.width and out.height < img.height


def test_crop_clamps_at_frame_edge():
    img = make_test_image()
    # 프레임 좌상단 모서리에 걸친 bbox - 여백이 음수 좌표로 나가면 안 된다
    out = crop_box2d(img, (0, 0, 300, 300), margin=0.05)
    assert out.width <= img.width and out.height <= img.height
    assert out.width > 0 and out.height > 0


def test_resize_to_width_shrinks_and_keeps_aspect():
    img = make_test_image(4000, 2000)
    out = resize_to_width(img, 2048)
    assert out.width == 2048
    assert out.height == 1024


def test_resize_to_width_never_upscales():
    img = make_test_image(1000, 800)
    out = resize_to_width(img, 2048)
    assert (out.width, out.height) == (1000, 800)


def test_parse_box2d_valid():
    box, err = parse_box2d({"ymin": "250", "xmin": "300", "ymax": "750", "xmax": "700"})
    assert err is None
    assert box == (250, 300, 750, 700)


def test_parse_box2d_rejects_bad_input():
    for args in [
        {},  # 누락
        {"ymin": "a", "xmin": "0", "ymax": "10", "xmax": "10"},  # 숫자 아님
        {"ymin": "500", "xmin": "0", "ymax": "100", "xmax": "10"},  # min >= max
        {"ymin": "0", "xmin": "0", "ymax": "1001", "xmax": "10"},  # 범위 밖
        {"ymin": "-1", "xmin": "0", "ymax": "10", "xmax": "10"},  # 음수
    ]:
        box, err = parse_box2d(args)
        assert box is None and err is not None, f"should reject {args}"


if __name__ == "__main__":
    test_crop_contains_white_box_with_margin()
    test_crop_clamps_at_frame_edge()
    test_resize_to_width_shrinks_and_keeps_aspect()
    test_resize_to_width_never_upscales()
    test_parse_box2d_valid()
    test_parse_box2d_rejects_bad_input()
    print("imaging.py: all checks passed")
```

- [ ] **Step 2: 실패 확인**

Run: `cd pi-server && python3 test_imaging.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'imaging'`

- [ ] **Step 3: 구현**

`pi-server/imaging.py`:

```python
"""Pi 사진 크롭/리사이즈 순수 함수. picamera2/flask 의존 없음 - 개발
머신에서 test_imaging.py 로 하드웨어 없이 검증한다.

좌표계는 Gemini box_2d 그대로: [ymin, xmin, ymax, xmax], 0~1000 정규화.
"""
from PIL import Image

BOX_KEYS = ("ymin", "xmin", "ymax", "xmax")


def parse_box2d(args):
    """쿼리 파라미터 dict -> ((ymin,xmin,ymax,xmax), None) 또는 (None, 에러문자열)."""
    try:
        ymin, xmin, ymax, xmax = (int(args[k]) for k in BOX_KEYS)
    except (KeyError, TypeError, ValueError):
        return None, "query params ymin,xmin,ymax,xmax (int 0~1000) required"
    if not (0 <= ymin < ymax <= 1000 and 0 <= xmin < xmax <= 1000):
        return None, "coords must satisfy 0 <= min < max <= 1000"
    return (ymin, xmin, ymax, xmax), None


def crop_box2d(img, box2d, margin=0.05):
    """0~1000 정규화 bbox 영역을 crop해 돌려준다. 각 변에 bbox 크기의
    margin 비율만큼 여백을 더하고 프레임 경계로 클램프한다 - Gemini 박스가
    몇 px 어긋나도 지문/풀이가 잘리지 않게."""
    ymin, xmin, ymax, xmax = box2d
    top = ymin / 1000 * img.height
    left = xmin / 1000 * img.width
    bottom = ymax / 1000 * img.height
    right = xmax / 1000 * img.width
    pad_y = (bottom - top) * margin
    pad_x = (right - left) * margin
    return img.crop((
        max(0, round(left - pad_x)),
        max(0, round(top - pad_y)),
        min(img.width, round(right + pad_x)),
        min(img.height, round(bottom + pad_y)),
    ))


def resize_to_width(img, width):
    """폭 기준 축소 (업스케일 안 함, 종횡비 유지)."""
    if img.width <= width:
        return img
    return img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)


def write_transfer_copy(src_path, dst_path, width=2048, quality=85):
    """보관 원본 -> 전송용 축소본. draft 는 JPEG 디코드 자체를 다운스케일로
    시작해 Pi Zero 급 CPU 에서도 12MP 리사이즈가 수 초씩 걸리지 않게 한다."""
    with Image.open(src_path) as img:
        img.draft("JPEG", (width * 2, width * 2))
        resize_to_width(img, width).save(dst_path, "JPEG", quality=quality)
```

- [ ] **Step 4: 통과 확인**

Run: `cd pi-server && python3 test_imaging.py`
Expected: `imaging.py: all checks passed`

- [ ] **Step 5: 커밋**

```bash
git add pi-server/imaging.py pi-server/test_imaging.py
git commit -m "feat(pi-server): pure crop/resize helpers for retained-frame crop pipeline"
```

---

### Task 2: pi-server 원본 보관 + /photo/crop 엔드포인트

**Files:**
- Modify: `pi-server/app.py`

**Interfaces:**
- Consumes: Task 1의 `imaging.parse_box2d/crop_box2d/resize_to_width/write_transfer_copy`
- Produces: `GET /photo/crop?ymin=&xmin=&ymax=&xmax=` (0~1000 정규화, JPEG 응답; 400 좌표 오류, 404 보관본 없음) — Task 5의 `fetchPiPhotoCropBase64()`가 호출. `/capture/photo`는 이제 2048폭 q85 축소본을 준다.

- [ ] **Step 1: 경로 상수와 import 추가**

`pi-server/app.py`의 `from libcamera import controls` 아래에 추가:

```python
from PIL import Image

from imaging import crop_box2d, parse_box2d, resize_to_width, write_transfer_copy
```

`PHOTO_PATH = "/tmp/photo.jpg"` 아래에 추가:

```python
# 크롭 파이프라인(2026-07-28 스펙): 촬영 원본(12MP, q95)은 FULL_PHOTO_PATH에
# 보관하고, 앱으로 내려가는 PHOTO_PATH는 2048폭 축소본이다. 고해상도가
# 필요하면 재촬영 대신 /photo/crop 이 보관본에서 잘라낸다.
FULL_PHOTO_PATH = "/tmp/photo_full.jpg"
CROP_PATH = "/tmp/photo_crop.jpg"
TRANSFER_WIDTH = 2048
```

- [ ] **Step 2: 촬영 함수가 원본 보관 + 축소본 생성하도록 수정**

`picam2.start()` 아래에 JPEG 품질 설정 추가:

```python
picam2.options["quality"] = 95
```

`_capture_full`을 다음으로 교체:

```python
def _capture_full(path: str) -> None:
    """전체 프레임 촬영 (Tier 1). auto 모드면 촬영 직전 실제 피사체로
    초점을 맞춘 뒤 찍는다. 원본은 FULL_PHOTO_PATH 에 보관하고(크롭용),
    path 에는 전송용 축소본을 쓴다."""
    with _capture_lock:
        if FOCUS_MODE != "manual":
            _autofocus_or_log()
        picam2.capture_file(FULL_PHOTO_PATH)
        write_transfer_copy(FULL_PHOTO_PATH, path, TRANSFER_WIDTH)
```

`_capture_region`의 `picam2.capture_file(path)` 를 다음으로 교체 (ScalerCrop 재촬영 경로도 같은 보관+축소 규칙을 따르게):

```python
        picam2.capture_file(FULL_PHOTO_PATH)
        write_transfer_copy(FULL_PHOTO_PATH, path, TRANSFER_WIDTH)
```

- [ ] **Step 3: /photo/crop 엔드포인트 추가**

`get_photo()` 라우트 아래에 추가:

```python
@app.route("/photo/crop", methods=["GET"])
def photo_crop():
    """보관 원본(FULL_PHOTO_PATH)에서 Gemini box_2d 좌표(0~1000 정규화,
    ymin/xmin/ymax/xmax 쿼리 파라미터)로 잘라 돌려준다. 재촬영 없음 -
    초점은 이미 맞아 있고 AF 사이클(1~2초)을 다시 돌 이유가 없다."""
    box, err = parse_box2d(request.args)
    if err:
        return jsonify({"error": err}), 400
    if not os.path.exists(FULL_PHOTO_PATH):
        return jsonify({"error": "no photo yet"}), 404
    # 크롭 도중 새 촬영이 보관본을 덮어쓰지 않게 촬영 lock 을 같이 쓴다.
    with _capture_lock:
        with Image.open(FULL_PHOTO_PATH) as img:
            cropped = resize_to_width(crop_box2d(img, box), TRANSFER_WIDTH)
            cropped.save(CROP_PATH, "JPEG", quality=95)
    return send_file(CROP_PATH, mimetype="image/jpeg")
```

- [ ] **Step 4: 문법 검증** (picamera2가 없어 로컬 실행 불가 — 컴파일 체크만)

Run: `python3 -m py_compile pi-server/app.py && python3 -m py_compile pi-server/imaging.py && echo OK`
Expected: `OK`

- [ ] **Step 5: 커밋**

```bash
git add pi-server/app.py
git commit -m "feat(pi-server): retain 12MP original, serve 2048px transfer copy, add /photo/crop"
```

---

### Task 3: problems 필드 — 타입 + responseSchema + 프롬프트

**Files:**
- Modify: `src/types/Tutoring.ts`
- Modify: `src/services/gemini.service.ts` (RESPONSE_SCHEMA)
- Modify: `src/prompts/system_prompt.ts`
- Test: `src/prompts/__tests__/system_prompt.problems.test.ts` (신규)

**Interfaces:**
- Produces: `ProblemBox { label: string; box_2d: number[] }`, `GeminiTutoringResponse.problems?: ProblemBox[]` — Task 4의 `matchProblemLabel`, Task 7의 FSM이 사용. `problems`는 스키마 `required`에 넣지 않는다 (폰 경로 포함 어디서도 필수 아님).

- [ ] **Step 1: 실패하는 테스트 작성**

`src/prompts/__tests__/system_prompt.problems.test.ts`:

```typescript
import { buildSystemPrompt } from '../system_prompt';

describe('PROBLEM_DETECTION_POLICY', () => {
  it('includes box_2d instructions when a problem image is present', () => {
    const prompt = buildSystemPrompt({ hasProblemImage: true });
    expect(prompt).toContain('box_2d');
    expect(prompt).toContain('0-1000');
  });

  it('omits problem-detection instructions for no-photo concept questions', () => {
    const prompt = buildSystemPrompt({ noPhotoConceptQuestion: true });
    expect(prompt).not.toContain('box_2d');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/prompts/__tests__/system_prompt.problems.test.ts`
Expected: FAIL — `Expected substring: "box_2d"` (프롬프트에 아직 없음)

- [ ] **Step 3: 타입 추가**

`src/types/Tutoring.ts`의 `GeminiTutoringResponse` 인터페이스 위에 추가:

```typescript
/** 사진 속에서 감지된 개별 문제 하나. box_2d 는 Gemini 좌표계 그대로
 * [ymin, xmin, ymax, xmax], 0~1000 정규화 - Pi /photo/crop 에 그대로 넘긴다. */
export interface ProblemBox {
  /** 학생이 부를 문제 식별자, 예: "3번". */
  label: string;
  /** [ymin, xmin, ymax, xmax], 0~1000. */
  box_2d: number[];
}
```

`GeminiTutoringResponse`의 `title: string;` 아래에 추가:

```typescript
  /** 사진에서 감지된 문제들(사진 분석 턴에만 올 수 있음). 2개 이상이면
   * FSM 이 "몇 번 풀고 있어?" 를 묻고 해당 bbox 크롭으로 재분석한다.
   * 필수 아님 - 없으면 문제 1개로 간주하고 현행 흐름. */
  problems?: ProblemBox[];
```

- [ ] **Step 4: responseSchema 추가**

`src/services/gemini.service.ts`의 `RESPONSE_SCHEMA` `properties` 안, `title: { type: SchemaType.STRING },` 아래에 추가 (`required` 배열에는 넣지 않는다):

```typescript
    problems: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          label: { type: SchemaType.STRING },
          box_2d: { type: SchemaType.ARRAY, items: { type: SchemaType.NUMBER } },
        },
        required: ['label', 'box_2d'],
      },
    },
```

- [ ] **Step 5: 프롬프트 정책 추가**

`src/prompts/system_prompt.ts`의 `ERROR_POLICY` 상수 아래에 추가:

```typescript
const PROBLEM_DETECTION_POLICY = `Problem detection (photos only) - fill \`problems\`:
- List EVERY distinct printed problem visible in the photo: label = the problem's printed number as the student would say it (e.g. "3번"; if no number is printed, use sequential "1번","2번" in reading order), box_2d = [ymin, xmin, ymax, xmax] normalized to 0-1000, covering that problem's statement, choices/figures, AND any student handwriting belonging to it.
- If you can already tell WHICH problem the student is working on (handwriting location, what they said), return ONLY that one problem.
- If no readable problem is visible, return an empty \`problems\` array.`;
```

`buildSystemPrompt` 안의 `const errorSection = context?.hasProblemImage ? `\n${ERROR_POLICY}` : '';` 를 다음으로 교체:

```typescript
  const errorSection = context?.hasProblemImage
    ? `\n${ERROR_POLICY}\n${PROBLEM_DETECTION_POLICY}`
    : '';
```

- [ ] **Step 6: 통과 확인 + 기존 스위트 회귀 확인**

Run: `npx jest src/prompts && npx tsc --noEmit`
Expected: 신규 테스트 포함 prompts 스위트 PASS. tsc는 기존 에러 5개만.

- [ ] **Step 7: 커밋**

```bash
git add src/types/Tutoring.ts src/services/gemini.service.ts src/prompts/system_prompt.ts src/prompts/__tests__/system_prompt.problems.test.ts
git commit -m "feat: per-problem bbox (problems[]) in Gemini schema, types, and prompt"
```

---

### Task 4: 학생 대답 → 문제 매칭 유틸

**Files:**
- Create: `src/utils/problemChoice.ts`
- Test: `src/utils/__tests__/problemChoice.test.ts`

**Interfaces:**
- Consumes: `ProblemBox` (Task 3, `src/types/Tutoring.ts`)
- Produces: `matchProblemLabel(text: string, problems: ProblemBox[]): ProblemBox | null` — Task 7의 FSM이 사용.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/utils/__tests__/problemChoice.test.ts`:

```typescript
import { matchProblemLabel } from '../problemChoice';
import type { ProblemBox } from '../../types/Tutoring';

const PROBLEMS: ProblemBox[] = [
  { label: '3번', box_2d: [100, 100, 400, 500] },
  { label: '13번', box_2d: [450, 100, 800, 500] },
];

describe('matchProblemLabel', () => {
  it.each([
    ['3번', '3번'],
    ['3번이요', '3번'],
    ['지금 3번 풀고 있어', '3번'],
    ['삼번', '3번'],
    ['세번째 문제', '3번'],
    ['13번', '13번'],
    ['십삼번', '13번'],
    ['3', '3번'], // 숫자만 말한 경우
  ])('matches %s -> %s', (utterance, expectedLabel) => {
    expect(matchProblemLabel(utterance, PROBLEMS)?.label).toBe(expectedLabel);
  });

  it.each([
    ['몰라'],
    ['이거 뭐야'], // "이" 가 sino-2 로 오인되면 안 됨 ("번" 없이)
    ['7번'], // 목록에 없는 번호
    [''],
  ])('returns null for %s', (utterance) => {
    expect(matchProblemLabel(utterance, PROBLEMS)).toBeNull();
  });

  it('returns null when problems list is empty', () => {
    expect(matchProblemLabel('3번', [])).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/utils/__tests__/problemChoice.test.ts`
Expected: FAIL — `Cannot find module '../problemChoice'`

- [ ] **Step 3: 구현**

`src/utils/problemChoice.ts`:

```typescript
/**
 * "몇 번 문제 풀고 있어?" 에 대한 학생 대답(STT 텍스트)을 problems 목록의
 * label 과 매칭한다. STT 는 대개 "3번"처럼 아라비아 숫자로 정규화해 주지만,
 * "삼번"/"세번째" 같은 한글 수사도 흔해 최소한만 지원한다.
 *
 * ponytail: 1~19 까지의 한자어 수사 + 고유어 서수(첫/한/두/세/네)만 파싱.
 * 20 이상 한글 수사가 필요해지면 그때 확장.
 */
import type { ProblemBox } from '../types/Tutoring';

const SINO: Record<string, number> = {
  일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9,
};
const NATIVE: Record<string, number> = {
  첫: 1, 한: 1, 두: 2, 세: 3, 네: 4,
};

/** "십삼" -> 13, "십" -> 10, "삼" -> 3. 파싱 불가면 null. */
function parseSino(word: string): number | null {
  const m = /^(십)?([일이삼사오육칠팔구])?$/.exec(word);
  if (!m || (!m[1] && !m[2])) return null;
  return (m[1] ? 10 : 0) + (m[2] ? SINO[m[2]] : 0);
}

/** 발화에서 문제 번호 하나를 뽑는다. 우선순위: "N번" > 한글수사+번 > 숫자만. */
export function extractProblemNumber(text: string): number | null {
  const digits = /(\d+)\s*번/.exec(text);
  if (digits) return parseInt(digits[1], 10);

  const sino = /(십?[일이삼사오육칠팔구]?)\s*번/.exec(text);
  if (sino && sino[1]) {
    const n = parseSino(sino[1]);
    if (n !== null) return n;
  }

  const native = /(첫|한|두|세|네)\s*번/.exec(text);
  if (native) return NATIVE[native[1]];

  const bare = /^\s*(\d+)\s*$/.exec(text);
  if (bare) return parseInt(bare[1], 10);

  return null;
}

export function matchProblemLabel(
  text: string,
  problems: ProblemBox[],
): ProblemBox | null {
  const wanted = extractProblemNumber(text);
  if (wanted === null) return null;
  return (
    problems.find(p => extractProblemNumber(p.label) === wanted) ?? null
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/utils/__tests__/problemChoice.test.ts`
Expected: PASS (전부)

- [ ] **Step 5: 커밋**

```bash
git add src/utils/problemChoice.ts src/utils/__tests__/problemChoice.test.ts
git commit -m "feat: match student's spoken problem number to detected problem bbox"
```

---

### Task 5: piBridge — 이중 리사이즈 제거 + 크롭 fetch

**Files:**
- Modify: `src/services/piBridge.service.ts`

**Interfaces:**
- Produces: `fetchPiPhotoCropBase64(box2d: number[]): Promise<string>` — Task 6에서 ConversationScreen이 FSM에 주입. `fetchPiPhotoBase64()`는 이제 Pi가 만든 2048폭 축소본을 그대로 반환(리사이즈 없음).

단위 테스트 없음(순수 I/O 래퍼 — fetch/FileReader/FileSystem 목킹 비용 대비 로직이 없다). 매칭·분기 로직은 Task 4/7 테스트가 담당. 검증은 tsc + 기존 스위트 회귀.

- [ ] **Step 1: fetchPiPhotoBase64 단순화**

`fetchPiPhotoBase64` 함수 전체(독스트링 포함, 133~162행 부근)를 다음으로 교체:

```typescript
/** stopPiRecording() 또는 capturePhotoNow() 이후 호출. JPEG base64를
 * 돌려준다 - analyzeImage(images, ...)에 그대로 넣으면 된다.
 *
 * 리사이즈는 이제 Pi 가 한다(app.py 가 12MP 원본을 보관하고 전송용
 * 2048폭 q85 축소본을 /capture/photo 로 준다) - 예전처럼 여기서
 * manipulateAsync 로 또 줄이면 JPEG 를 두 번 인코딩해 획이 뭉개진다. */
export async function fetchPiPhotoBase64(): Promise<string> {
  // Pi Zero 의 약한 CPU/WiFi 를 감안해 기본 8초보다 넉넉히 둔다.
  const res = await fetchWithTimeout(`${PI_BASE_URL}/capture/photo`, {}, 20000);
  if (!res.ok) throw new Error(`Pi capture/photo failed: ${res.status}`);
  return blobToBase64(await res.blob());
}
```

- [ ] **Step 2: fetchPiPhotoCropBase64 추가**

`fetchPiPhotoBase64` 아래에 추가:

```typescript
/** Pi 가 보관 중인 12MP 원본에서 Gemini box_2d([ymin,xmin,ymax,xmax],
 * 0~1000 정규화) 영역을 잘라 받아온다. 재촬영 없음(AF 사이클 없음) -
 * 원본과 같은 초점의 고해상 크롭이 온다. 실패는 throw - 호출부(FSM)가
 * 풀프레임 폴백을 책임진다. */
export async function fetchPiPhotoCropBase64(box2d: number[]): Promise<string> {
  const [ymin, xmin, ymax, xmax] = box2d;
  const res = await fetchWithTimeout(
    `${PI_BASE_URL}/photo/crop?ymin=${ymin}&xmin=${xmin}&ymax=${ymax}&xmax=${xmax}`,
    {},
    20000,
  );
  if (!res.ok) throw new Error(`Pi photo/crop failed: ${res.status}`);
  return blobToBase64(await res.blob());
}
```

- [ ] **Step 3: 죽은 import 제거**

파일 상단 `import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';` 삭제. `FileSystem` import는 `playAudioOnPi`가 아직 쓰므로 유지. `capturePiRegion`의 독스트링에서 "리사이즈 로직은 fetchPiPhotoBase64()가 공통으로 처리한다" 문장을 "리사이즈는 Pi 서버가 처리한다"로 수정.

- [ ] **Step 4: 검증**

Run: `npx tsc --noEmit && npx jest src/services`
Expected: tsc 기존 에러 5개만. services 스위트 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/services/piBridge.service.ts
git commit -m "feat: fetch Pi crop by box_2d; drop app-side double resize (Pi resizes now)"
```

---

### Task 6: photoSource 배선 (payload → 화면 → FSM seed)

**Files:**
- Modify: `src/types/AppState.ts` (ConversationPayload)
- Modify: `App.tsx` (handleAnalyzed/handlePiCameraTest/toConversationPayload)
- Modify: `src/screens/ConversationScreen.tsx` (startSession seed)

**Interfaces:**
- Produces: `ConversationPayload.photoSource?: 'pi' | 'phone'`, `startSession` seed의 `photoSource` — Task 7의 FSM 분기 게이트. Pi 경로만 `'pi'`; 폰 경로는 값을 안 실어 분기가 아예 안 열린다.

- [ ] **Step 1: ConversationPayload에 필드 추가**

`src/types/AppState.ts`의 `ConversationPayload` 인터페이스에 추가 (기존 옵셔널 필드들 옆):

```typescript
  /** 문제 사진 출처. 'pi' 일 때만 FSM 이 보관본 크롭 흐름(다문제 되묻기,
   * 인식 실패 시 크롭 재분석)을 연다 - 폰 사진은 크롭 소스가 없다. */
  photoSource?: 'pi' | 'phone';
```

- [ ] **Step 2: App.tsx 배선**

`toConversationPayload`(App.tsx 54행 부근)에 다섯 번째 파라미터 추가:

```typescript
function toConversationPayload(
  response: GeminiTutoringResponse & { usage?: TokenUsage },
  imageBase64: string,
  initialQuestion?: string,
  resumeSession?: ResumeSessionSnapshot,
  photoSource?: 'pi' | 'phone',
): ConversationPayload {
  return {
    fsmState: response.fsm_state,
    message: response.message,
    requires_board: response.requires_board,
    board_update_needed: response.board_update_needed,
    board_prompt: response.board_prompt,
    initialAnalysis: response,
    problemImageBase64: imageBase64,
    initialQuestion,
    initialUsage: response.usage,
    resumeSession,
    photoSource,
  };
}
```

`handleAnalyzed`에 세 번째 파라미터 추가하고 전달:

```typescript
  const handleAnalyzed = useCallback((
    response: GeminiTutoringResponse,
    imageBase64: string,
    photoSource: 'pi' | 'phone' = 'phone',
  ) => {
    const resume = resumeSessionRef.current;
    resumeSessionRef.current = undefined;
    startProcessing();
    enterConversation(
      toConversationPayload(
        response,
        imageBase64,
        appState.status === 'capturing' ? appState.initialQuestion : undefined,
        resume,
        photoSource,
      ),
    );
  }, [appState, startProcessing, enterConversation]);
```

`handlePiCameraTest`의 마지막 줄을 `handleAnalyzed(response, photoBase64, 'pi');` 로 변경. (CameraScreen의 `onAnalyzed={handleAnalyzed}`는 그대로 — 기본값 `'phone'`.)

- [ ] **Step 3: ConversationScreen seed에 전달**

`src/screens/ConversationScreen.tsx`의 `startSession(...)` 호출(284행 부근)에서 seed 객체 양쪽 분기(resumeSession 있는 쪽/없는 쪽) 모두에 `photoSource: conversation.photoSource,` 를 추가.

- [ ] **Step 4: 검증**

Run: `npx tsc --noEmit && npx jest src/hooks/__tests__/useAppState.test.ts src/screens`
Expected: tsc 기존 에러 5개만(참고: `startSession` seed 타입에 `photoSource`가 없어 새 에러가 나면 Task 7의 seed 타입 확장이 선행 필요 — 그 경우 Task 7 Step 3의 타입 변경만 먼저 적용). 스위트 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/types/AppState.ts App.tsx src/screens/ConversationScreen.tsx
git commit -m "feat: thread photoSource ('pi'|'phone') from capture entry to FSM seed"
```

---

### Task 7: FSM — 다문제 되묻기 + 인식 실패 크롭 재분석

**Files:**
- Modify: `src/hooks/useTutoringFSM.ts`
- Modify: `src/screens/ConversationScreen.tsx` (FSM 옵션 주입)
- Test: `src/hooks/__tests__/useTutoringFSM.problemChoice.test.ts` (신규)

**Interfaces:**
- Consumes: `matchProblemLabel` (Task 4), `fetchPiPhotoCropBase64` (Task 5, ConversationScreen이 주입), `analyzeImage` (gemini.service, 기본값), `ProblemBox`/`problems` (Task 3), seed `photoSource` (Task 6)
- Produces: `UseTutoringFSMOptions.analyzeImageFn?`, `UseTutoringFSMOptions.fetchProblemCropFn?: (box2d: number[]) => Promise<string>`, `startSession` seed 타입에 `photoSource?: 'pi' | 'phone'`

동작 규칙 (스펙 §흐름):
- `photoSource==='pi'` && `problems.length>=2` → 세션 시딩 없이 "몇 번 풀고 있어?" 발화 후 대답 대기. 대답이 매칭되면 크롭 → 재분석 → `startSession` 재진입(문제 확정본). 매칭 실패/크롭 실패 → 원래 풀프레임 분석으로 `startSession` 재진입 (되묻기 반복 없음).
- `photoSource==='pi'` && ERROR(OCR_FAILED/LOW_IMAGE_QUALITY) && bbox 있음 → 에러 메시지 발화 전에 크롭 재분석 1회. 실패 시 현행 에러 흐름(발화 + onCameraNeeded).
- 재진입 시 `problems`를 벗겨(`problems: undefined`) 무한 되묻기/재시도 루프 차단.
- `fetchProblemCropFn` 미주입 또는 `photoSource !== 'pi'` → 두 분기 모두 닫힘 = 현행 동작.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/hooks/__tests__/useTutoringFSM.problemChoice.test.ts` (기존 `useTutoringFSM.test.ts`의 `baseResponse`/`renderFsm` 패턴을 따르되 옵션 확장):

```typescript
/**
 * 다문제 되묻기 + 인식 실패 크롭 재분석 (2026-07-28 크롭 파이프라인 스펙).
 * fetchProblemCropFn/analyzeImageFn 을 목으로 주입해 네트워크 없이 분기만
 * 검증한다.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { useTutoringFSM, UseTutoringFSMResult } from '../useTutoringFSM';
import type { GeminiTutoringResponse } from '../../types/Tutoring';

function baseResponse(
  overrides: Partial<GeminiTutoringResponse> = {},
): GeminiTutoringResponse {
  return {
    fsm_state: 'HINT_STAGE',
    explicit_answer_request: false,
    is_on_correct_path: null,
    requires_board: false,
    board_update_needed: false,
    message: 'default message',
    board_prompt: '',
    confidence: 0.9,
    error_type: 'NONE',
    misconception_type: 'NONE',
    topic: '기타',
    title: 'default title',
    ...overrides,
  };
}

const TWO_PROBLEMS = [
  { label: '3번', box_2d: [100, 100, 400, 500] },
  { label: '4번', box_2d: [450, 100, 800, 500] },
];

function renderFsm(options: {
  speakFn?: jest.Mock;
  analyzeImageFn?: jest.Mock;
  fetchProblemCropFn?: jest.Mock;
  onCameraNeeded?: jest.Mock;
  evaluateStudentInputFn?: jest.Mock;
}) {
  const speakFn = options.speakFn ?? jest.fn().mockResolvedValue(undefined);
  const ref: { current: UseTutoringFSMResult | null } = { current: null };

  function Harness() {
    ref.current = useTutoringFSM({
      evaluateStudentInputFn:
        options.evaluateStudentInputFn ?? jest.fn().mockResolvedValue(baseResponse()),
      speakFn,
      analyzeImageFn: options.analyzeImageFn,
      fetchProblemCropFn: options.fetchProblemCropFn,
      onCameraNeeded: options.onCameraNeeded,
    });
    return null;
  }
  act(() => {
    ReactTestRenderer.create(React.createElement(Harness));
  });
  return { ref: ref as { current: UseTutoringFSMResult }, speakFn };
}

const PI_SEED = {
  sessionId: 's1',
  problemImageBase64: 'full-frame-b64',
  photoSource: 'pi' as const,
};

describe('multi-problem ask flow', () => {
  it('asks which problem instead of tutoring when 2+ problems from pi', async () => {
    const fetchProblemCropFn = jest.fn();
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: 'tutoring msg', problems: TWO_PROBLEMS }),
        PI_SEED,
      );
    });
    expect(speakFn.mock.calls[0][0]).toContain('몇 번');
    expect(speakFn.mock.calls[0][0]).not.toBe('tutoring msg');
    expect(ref.current.phase).toBe('awaiting_input');
    expect(fetchProblemCropFn).not.toHaveBeenCalled(); // 대답 전엔 크롭 안 함
  });

  it('crops the matched problem and re-analyzes on answer', async () => {
    const fetchProblemCropFn = jest.fn().mockResolvedValue('crop-b64');
    const analyzeImageFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: 'cropped tutoring msg' }));
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn, analyzeImageFn });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({ problems: TWO_PROBLEMS }),
        PI_SEED,
      );
    });
    await act(async () => {
      await ref.current.submitStudentInput('3번이요');
    });
    expect(fetchProblemCropFn).toHaveBeenCalledWith([100, 100, 400, 500]);
    expect(analyzeImageFn).toHaveBeenCalledWith(
      'crop-b64',
      expect.anything(),
      expect.any(String),
      undefined,
      undefined,
    );
    expect(speakFn).toHaveBeenLastCalledWith('cropped tutoring msg');
    expect(ref.current.session.problemImageBase64).toBe('crop-b64');
  });

  it('falls back to full-frame analysis when the answer matches nothing', async () => {
    const fetchProblemCropFn = jest.fn();
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: 'full-frame msg', problems: TWO_PROBLEMS }),
        PI_SEED,
      );
    });
    await act(async () => {
      await ref.current.submitStudentInput('몰라');
    });
    expect(fetchProblemCropFn).not.toHaveBeenCalled();
    expect(speakFn).toHaveBeenLastCalledWith('full-frame msg');
    expect(ref.current.phase).toBe('awaiting_input');
  });

  it('falls back to full-frame analysis when the crop fetch fails', async () => {
    const fetchProblemCropFn = jest.fn().mockRejectedValue(new Error('network'));
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: 'full-frame msg', problems: TWO_PROBLEMS }),
        PI_SEED,
      );
    });
    await act(async () => {
      await ref.current.submitStudentInput('3번');
    });
    expect(speakFn).toHaveBeenLastCalledWith('full-frame msg');
  });

  it('does NOT ask when photoSource is not pi', async () => {
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn: jest.fn() });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: 'tutoring msg', problems: TWO_PROBLEMS }),
        { sessionId: 's1', problemImageBase64: 'b64' }, // photoSource 없음
      );
    });
    expect(speakFn).toHaveBeenCalledWith('tutoring msg');
  });
});

describe('OCR-failure crop retry', () => {
  const ERROR_ANALYSIS = baseResponse({
    fsm_state: 'ERROR',
    error_type: 'OCR_FAILED',
    message: 'retake please',
    problems: [TWO_PROBLEMS[0]],
  });

  it('retries with a crop before asking for a retake', async () => {
    const fetchProblemCropFn = jest.fn().mockResolvedValue('crop-b64');
    const analyzeImageFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: 'recovered msg' }));
    const onCameraNeeded = jest.fn();
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn, analyzeImageFn, onCameraNeeded });
    await act(async () => {
      await ref.current.startSession(ERROR_ANALYSIS, PI_SEED);
    });
    expect(fetchProblemCropFn).toHaveBeenCalledWith([100, 100, 400, 500]);
    expect(speakFn).toHaveBeenLastCalledWith('recovered msg');
    expect(onCameraNeeded).not.toHaveBeenCalled();
  });

  it('falls through to the retake flow when the crop retry also errors', async () => {
    const fetchProblemCropFn = jest.fn().mockResolvedValue('crop-b64');
    const analyzeImageFn = jest.fn().mockResolvedValue(
      baseResponse({ fsm_state: 'ERROR', error_type: 'OCR_FAILED', message: 'still bad' }),
    );
    const onCameraNeeded = jest.fn();
    const { ref } = renderFsm({ fetchProblemCropFn, analyzeImageFn, onCameraNeeded });
    await act(async () => {
      await ref.current.startSession(ERROR_ANALYSIS, PI_SEED);
    });
    expect(onCameraNeeded).toHaveBeenCalled();
  });

  it('skips the retry entirely without a crop fn (phone path safety)', async () => {
    const onCameraNeeded = jest.fn();
    const { ref, speakFn } = renderFsm({ onCameraNeeded });
    await act(async () => {
      await ref.current.startSession(ERROR_ANALYSIS, PI_SEED);
    });
    expect(speakFn).toHaveBeenCalledWith('retake please');
    expect(onCameraNeeded).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/hooks/__tests__/useTutoringFSM.problemChoice.test.ts`
Expected: FAIL — `analyzeImageFn`/`fetchProblemCropFn` 옵션이 없어 TS 에러 또는 되묻기 미동작 assertion 실패.

- [ ] **Step 3: FSM 구현**

`src/hooks/useTutoringFSM.ts` 수정:

(a) import 추가:

```typescript
import { analyzeImage as defaultAnalyzeImage } from '../services/gemini.service';
import { matchProblemLabel } from '../utils/problemChoice';
```

(기존 `evaluateStudentInput as defaultEvaluateStudentInput` import 줄에 이어서.)

(b) 상수 추가 (`isConsentPhrase` 위쪽 모듈 레벨):

```typescript
/** 다문제 사진에서 어떤 문제를 풀고 있는지 묻는 고정 발화. */
export const PROBLEM_CHOICE_QUESTION = '책상에 문제가 여러 개 보이네! 지금 몇 번 문제 풀고 있어?';
/** 크롭 재분석(~3초) 동안의 무음을 메우는 필러 발화. */
const CROP_RETRY_FILLER = '잠깐만, 문제를 다시 자세히 볼게.';
```

(c) `UseTutoringFSMOptions`에 추가:

```typescript
  /** Injectable for tests; defaults to the real Gemini analyzeImage. 크롭
   * 재분석(다문제 선택 후 / OCR 실패 후)에 쓴다. */
  analyzeImageFn?: typeof defaultAnalyzeImage;
  /** Pi 보관 원본에서 box_2d([ymin,xmin,ymax,xmax] 0~1000) 크롭을 받아오는
   * 함수. 미주입이면(폰 경로) 크롭 분기 전체가 닫힌다. */
  fetchProblemCropFn?: (box2d: number[]) => Promise<string>;
```

훅 시그니처의 구조분해에 `analyzeImageFn = defaultAnalyzeImage, fetchProblemCropFn,` 추가.

(d) `startSession` seed 타입 확장 — `UseTutoringFSMResult.startSession`과 실제 `useCallback` 양쪽:

```typescript
    seed: Pick<TutoringSession, 'sessionId' | 'problemImageBase64'> &
      Partial<ResumeSessionSnapshot> & { photoSource?: 'pi' | 'phone' },
```

(e) 상태 ref + 헬퍼 추가 (`turnIdRef` 선언부 근처):

```typescript
  // 다문제 되묻기 대기 상태. startSession 이 세션을 시딩하지 않고 여기 얹어둔
  // 채 "몇 번 풀고 있어?" 를 물으면, 다음 submitStudentInput 이 가로채 크롭
  // 재분석 또는 풀프레임 폴백으로 소비한다.
  const pendingProblemChoiceRef = useRef<{
    analysis: GeminiTutoringResponse;
    seed: Pick<TutoringSession, 'sessionId' | 'problemImageBase64'> &
      Partial<ResumeSessionSnapshot> & { photoSource?: 'pi' | 'phone' };
    initialQuestion?: string;
    initialUsage?: TokenUsage;
  } | null>(null);
```

모듈 레벨 헬퍼 (`forHistory` 근처):

```typescript
/** 크롭 재분석 호출용 세션 컨텍스트 - 아직 시딩 전이므로 seed 값만으로 만든다. */
function sessionFromSeed(
  seed: Pick<TutoringSession, 'sessionId' | 'problemImageBase64'> &
    Partial<ResumeSessionSnapshot>,
): TutoringSession {
  return {
    sessionId: seed.sessionId,
    problemImageBase64: '',
    fsmState: 'HINT_STAGE',
    hintCount: seed.hintCount ?? 0,
    wrongStreak: seed.wrongStreak ?? 0,
    boardRegenerationCount: 0,
    history: seed.history,
  };
}
```

(f) `startSession` 재진입용 ref — `startSession` useCallback은 자기 자신을 deps에 넣을 수 없으므로 정의 직후에:

```typescript
  // 크롭 재분석 후 startSession 을 재진입하기 위한 자기 참조 (useCallback 은
  // 자기 자신을 deps 로 가질 수 없다).
  const startSessionRef = useRef(startSession);
  startSessionRef.current = startSession;
```

(g) `startSession` 본문 — `problemImageUrlRef.current = undefined;` 직후, SOLVE_STAGE 백스톱 이전에 두 분기 삽입:

```typescript
      const problems = analysis.problems ?? [];
      const cropFlowOpen = seed.photoSource === 'pi' && !!fetchProblemCropFn;

      // 분기 1 (다문제): 세션을 시딩하지 않고 어떤 문제인지부터 묻는다.
      // 대답은 submitStudentInput 의 인터셉트가 소비한다. 재진입 시엔
      // problems 를 벗겨서 오므로 (problems: undefined) 다시 안 열린다.
      if (cropFlowOpen && problems.length >= 2) {
        pendingProblemChoiceRef.current = { analysis, seed, initialQuestion, initialUsage };
        setConversation(
          toConversationPayload({ ...analysis, message: PROBLEM_CHOICE_QUESTION }),
        );
        await speakAndWait(PROBLEM_CHOICE_QUESTION, 'awaiting_input', myTurnId);
        return;
      }

      // 분기 2 (문제 1개 + 인식 실패): 재촬영을 요구하기 전에, 보관 원본의
      // 해당 bbox 크롭으로 조용히 1회 재분석한다. 같은 초점의 고해상 크롭이라
      // 현행 "다시 찍어달라" 보다 빠르고 성공률이 높다. 재분석도 실패하면
      // 재진입된 startSession 이 (problems 없음) 현행 에러 흐름을 탄다.
      if (
        cropFlowOpen &&
        analysis.fsm_state === 'ERROR' &&
        (analysis.error_type === 'OCR_FAILED' || analysis.error_type === 'LOW_IMAGE_QUALITY') &&
        problems.length >= 1
      ) {
        try {
          speakFn(CROP_RETRY_FILLER).catch(() => {}); // 재분석 3초의 무음 메우기
          const crop = await fetchProblemCropFn!(problems[0].box_2d);
          if (isStale(myTurnId)) return;
          const retrySystemPrompt = buildSystemPrompt({
            hasProblemImage: true,
            directSolveMode,
          });
          const fresh = await analyzeImageFn(
            crop, sessionFromSeed(seed), retrySystemPrompt, initialQuestion, directSolveMode,
          );
          if (isStale(myTurnId)) return;
          await startSessionRef.current(
            { ...fresh, problems: undefined },
            { ...seed, problemImageBase64: crop },
            initialQuestion,
            fresh.usage,
          );
          return;
        } catch (err) {
          console.warn('[FSM] crop retry failed - falling back to full-frame error flow:', err);
          // fall through: 아래 기존 흐름이 에러 메시지 발화 + onCameraNeeded 처리
        }
      }
```

`startSession`의 deps 배열에 `speakFn, analyzeImageFn, fetchProblemCropFn` 추가.

(h) `submitStudentInput` 본문 맨 앞(turn epoch 확보 이전이 아니라 **확보 직후**, `stopSpeakingFn` 호출 다음)에 인터셉트 삽입:

```typescript
      // 다문제 되묻기 대답 인터셉트: 이 발화는 튜터링 입력이 아니라 문제
      // 선택이다. 매칭 성공 -> 해당 bbox 크롭으로 재분석해 세션 시작.
      // 매칭 실패/크롭 실패 -> 원래 풀프레임 분석으로 세션 시작 (되묻기
      // 반복 없음 - 학생을 두 번 붙잡지 않는다).
      const pending = pendingProblemChoiceRef.current;
      if (pending) {
        pendingProblemChoiceRef.current = null;
        const matched = matchProblemLabel(text, pending.analysis.problems ?? []);
        if (matched && fetchProblemCropFn) {
          try {
            setPhase('evaluating');
            const crop = await fetchProblemCropFn(matched.box_2d);
            if (isStale(myTurnId)) return;
            const choiceSystemPrompt = buildSystemPrompt({
              hasProblemImage: true,
              directSolveMode: effectiveDirectSolveMode,
            });
            const fresh = await analyzeImageFn(
              crop,
              sessionFromSeed(pending.seed),
              choiceSystemPrompt,
              pending.initialQuestion,
              effectiveDirectSolveMode || undefined,
            );
            if (isStale(myTurnId)) return;
            await startSessionRef.current(
              { ...fresh, problems: undefined },
              { ...pending.seed, problemImageBase64: crop },
              pending.initialQuestion,
              fresh.usage,
            );
            return;
          } catch (err) {
            console.warn('[FSM] problem-choice crop failed - falling back to full frame:', err);
          }
        }
        await startSessionRef.current(
          { ...pending.analysis, problems: undefined },
          pending.seed,
          pending.initialQuestion,
          pending.initialUsage,
        );
        return;
      }
```

`submitStudentInput` deps에 `analyzeImageFn, fetchProblemCropFn` 추가.

주의: `analyzeImageFn`의 반환 타입은 `GeminiTutoringResponse & { usage: TokenUsage }` — `fresh.usage` 그대로 전달하면 된다. 테스트 목이 usage 없이 resolve해도 `initialUsage`는 옵셔널이라 통과한다.

- [ ] **Step 4: ConversationScreen 주입**

`src/screens/ConversationScreen.tsx`:

```typescript
import { fetchPiPhotoCropBase64 } from '../services/piBridge.service';
```

`useTutoringFSM({ ... })` 옵션 객체(174행 부근)에 `fetchProblemCropFn: fetchPiPhotoCropBase64,` 추가. (`analyzeImageFn`은 기본값 사용 — 주입 불필요. `photoSource !== 'pi'`면 FSM이 어차피 분기를 안 연다.)

- [ ] **Step 5: 신규 + 기존 FSM 테스트 통과 확인**

Run: `npx jest src/hooks/__tests__/useTutoringFSM.problemChoice.test.ts src/hooks/__tests__/useTutoringFSM.test.ts src/screens`
Expected: 전부 PASS (기존 FSM 테스트는 `photoSource` 미지정이라 분기가 닫혀 회귀 없음)

- [ ] **Step 6: 전체 검증**

Run: `npx jest && npx tsc --noEmit`
Expected: 전체 스위트 PASS (20+ suites), tsc는 기존 에러 5개만.

- [ ] **Step 7: 커밋**

```bash
git add src/hooks/useTutoringFSM.ts src/screens/ConversationScreen.tsx src/hooks/__tests__/useTutoringFSM.problemChoice.test.ts
git commit -m "feat: multi-problem ask flow and OCR-failure crop retry in tutoring FSM"
```

---

### Task 8: 문서 갱신 + PR

**Files:**
- Modify: `docs/SESSION_HANDOFF.md` (덮어씀 — Pi 카메라 항목/튜닝 노브 갱신)
- Modify: `docs/process.md` (6주차 한 일에 한 줄 append)

- [ ] **Step 1: SESSION_HANDOFF.md의 "Pi 카메라" 항목 갱신**

기존 "Pi 카메라" 불릿을 다음 내용으로 교체 (파일의 다른 부분은 유지):

```markdown
- **Pi 카메라**: 촬영 시 12MP 원본(q95)을 `/tmp/photo_full.jpg` 에 보관하고 `/capture/photo` 는 2048폭 q85 축소본을 준다(앱 쪽 리사이즈 삭제 - JPEG 인코딩 1회). `GET /photo/crop?ymin=&xmin=&ymax=&xmax=` (0~1000 정규화, Gemini box_2d 그대로)가 보관본에서 재촬영 없이 크롭. 1차 분석이 `problems[]`(문제별 label+bbox)를 주고, 2개 이상이면 FSM 이 "몇 번 풀고 있어?" 후 해당 크롭으로 재분석, OCR 실패면 크롭 재분석 1회 후에야 재촬영 요청. 크롭 실패는 전부 풀프레임 폴백. AF 는 기존대로 Macro+Fast (`VIVA_AF_RANGE=normal` 폴백).
```

미해결 섹션에 추가:

```markdown
- Pi 실기기 미검증: /photo/crop 실측(크롭 화질·지연), Pi 의 2048 축소 생성 시간(Pillow draft 적용 상태), 다문제 되묻기 실사용 흐름. 실측 후 process.md 에 기록할 것.
```

- [ ] **Step 2: process.md 6주차 한 일에 추가**

```markdown
- Pi 사진 크롭 파이프라인 구현 (D-14 설계대로): pi-server 원본 보관+`/photo/crop`, Gemini `problems[]` bbox, FSM 다문제 되묻기·OCR 실패 크롭 재분석, 앱 이중 리사이즈 삭제 (커밋해시들)
```

(커밋해시들은 실제 해시로 치환.)

- [ ] **Step 3: 커밋 + PR**

```bash
git add docs/SESSION_HANDOFF.md docs/process.md
git commit -m "docs: record crop pipeline implementation status and tuning knobs"
git push -u origin fix/pi-photo-crop
gh pr create --title "feat: Pi photo crop pipeline (D-14)" --body "..."
```

PR 본문에는 스펙 링크(`docs/superpowers/specs/2026-07-28-pi-photo-crop-pipeline-design.md`), 지연 분석 표, "Pi 실기기 실측 미완" 명시. 머지는 사용자 확인 후 (COLLABORATION.md 관례: 머지 커밋, 스쿼시 아님).

---

## Self-Review 결과

- 스펙 커버리지: Pi 보관+축소(Task 1·2), `/photo/crop`(Task 2), schema/타입/프롬프트(Task 3), 대답 매칭(Task 4), piBridge(Task 5), photoSource(Task 6), FSM 분기 3종+폴백(Task 7), 문서(Task 8). 스펙의 "실측(수동)" 항목은 Pi 하드웨어 필요 — Task 8 SESSION_HANDOFF 미해결 항목으로 인계.
- 타입 일관성: `box_2d: number[]` (Tutoring.ts ↔ problemChoice ↔ piBridge ↔ FSM), seed `photoSource` (Task 6 Step 3 ↔ Task 7 Step 3-d), `fetchProblemCropFn(box2d: number[])` (Task 5 ↔ Task 7) 일치 확인.
- 순서 의존: Task 6 Step 4의 tsc가 Task 7의 seed 타입 확장에 의존할 수 있음 — Step 4에 선행 적용 안내 명시함. Task 7은 Task 3·4·5·6 산출물 전부 소비.
