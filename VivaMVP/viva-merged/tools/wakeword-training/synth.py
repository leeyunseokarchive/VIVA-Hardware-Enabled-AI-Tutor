#!/usr/bin/env python3
"""Google TTS 로 '비바야' 양성/음성 학습 클립 합성 (16kHz LINEAR16 WAV).

- 양성: 한국어 음성 41종 × 문장부호(운율) 변형, 비-Chirp 음성은 rate/pitch 변형 추가.
- 음성(negative): 과외 도메인 문장 + 유사 발음 하드 네거티브 + 일반 문장.
Chirp3-HD 는 pitch/SSML 미지원이라 텍스트 변형만 쓴다.
"""
import base64
import concurrent.futures as cf
import json
import os
import sys
import time
import urllib.error
import urllib.request

KEY = os.environ["TTS_KEY"]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
URL = f"https://texttospeech.googleapis.com/v1/text:synthesize?key={KEY}"

CHIRP = [
    "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe",
    "Callirrhoe", "Charon", "Despina", "Enceladus", "Erinome", "Fenrir",
    "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda", "Orus", "Puck",
    "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar",
    "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi",
]
CHIRP = [f"ko-KR-Chirp3-HD-{n}" for n in CHIRP]
CLASSIC = [
    "ko-KR-Neural2-A", "ko-KR-Neural2-B", "ko-KR-Neural2-C",
    "ko-KR-Wavenet-A", "ko-KR-Wavenet-B", "ko-KR-Wavenet-C", "ko-KR-Wavenet-D",
    "ko-KR-Standard-A", "ko-KR-Standard-B", "ko-KR-Standard-C", "ko-KR-Standard-D",
]

POS_TEXTS = ["비바야", "비바야!", "비바야?", "비바야~", "비바야."]

HARD_NEG = [
    "비바", "바야", "비비야", "바바야", "비마야", "비바다", "리바야", "비봐야",
    "이봐야", "지바야", "비파야", "니바야", "비바요", "봐봐야", "비상야",
]
NEG_SENTENCES = [
    "이 문제 어떻게 풀어", "알았어 고마워", "괜찮아 꺼줘", "다시 설명해줘",
    "몰라 모르겠어", "오백이십이번 어떻게 풀어", "삼각함수가 뭐야", "정답이 뭐야",
    "힌트 좀 줘", "아 진짜 어렵다", "이거 맞아?", "됐어 이제 그만",
    "수학 숙제 해야 되는데", "일차방정식 풀이 알려줘", "미분이 뭐야",
    "확률과 통계 문제야", "몇 번 문제 볼까", "칠판에 써 줘", "다음 문제",
    "잘 모르겠어요", "네 맞아요", "아니요 틀렸어요", "고마워요 선생님",
    "잠깐만 기다려 봐", "책 좀 가져올게", "물 마시고 올게", "숙제 다 했어",
    "오늘 뭐 배우지", "시험이 다음 주야", "점수가 안 나와", "집중이 안 돼",
    "밥 먹고 하자", "졸려 죽겠다", "내일 학교 가야 돼", "친구랑 놀고 싶다",
    "엄마가 부르셔", "텔레비전 소리 좀 줄여", "음악 틀어 줘", "불 좀 켜 줘",
    "창문 닫아 줘", "너무 시끄러워", "조용히 해 줘", "여기 봐 봐",
    "이게 뭐지", "저건 뭐야", "어디까지 했더라", "처음부터 다시",
    "빨리 빨리 하자", "천천히 해도 돼", "한 번만 더", "마지막 문제야",
    "계산기 어디 있지", "연필 좀 빌려줘", "지우개 없어", "공책에 적어",
    "사진 찍어 줘", "화면 보여 줘", "소리가 안 들려", "잘 들려",
    "무슨 말인지 모르겠어", "예를 들어 줘", "그래프로 그려 줘", "공식이 뭐였지",
]

os.makedirs(f"{OUT}/pos", exist_ok=True)
os.makedirs(f"{OUT}/neg", exist_ok=True)


def synth(job):
    path, text, voice, rate, pitch = job
    if os.path.exists(path):
        return None
    body = {
        "input": {"text": text},
        "voice": {"languageCode": "ko-KR", "name": voice},
        "audioConfig": {
            "audioEncoding": "LINEAR16",
            "sampleRateHertz": 16000,
        },
    }
    if rate != 1.0:
        body["audioConfig"]["speakingRate"] = rate
    if pitch != 0.0:
        body["audioConfig"]["pitch"] = pitch
    req = urllib.request.Request(
        URL, json.dumps(body).encode(), {"Content-Type": "application/json"})
    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                audio = json.loads(r.read())["audioContent"]
            with open(path, "wb") as f:
                f.write(base64.b64decode(audio))
            return None
        except urllib.error.HTTPError as e:
            err = f"{path}: HTTP {e.code}"
            if e.code == 429:  # 분당 쿼터 - 물러났다 다시
                time.sleep(20 + attempt * 10)
            else:
                time.sleep(2)
        except Exception as e:  # noqa: BLE001
            err = f"{path}: {type(e).__name__} {e}"
            time.sleep(2)
    return err


jobs = []
# 양성: Chirp 30성 × 5문장 = 150, 클래식 11성 × 5문장 × rate3 × pitch3 = 495
for v in CHIRP:
    for i, t in enumerate(POS_TEXTS):
        jobs.append((f"{OUT}/pos/{v}_{i}.wav", t, v, 1.0, 0.0))
for v in CLASSIC:
    for i, t in enumerate(POS_TEXTS):
        for r in (0.85, 1.0, 1.2):
            for p in (-3.0, 0.0, 3.0):
                jobs.append((f"{OUT}/pos/{v}_{i}_r{r}_p{p}.wav", t, v, r, p))
# 하드 네거티브: 전 음성 41종
for v in CHIRP + CLASSIC:
    for i, t in enumerate(HARD_NEG):
        jobs.append((f"{OUT}/neg/hard_{v}_{i}.wav", t, v, 1.0, 0.0))
# 일반 문장: 문장마다 음성 6종 로테이션
ALL = CHIRP + CLASSIC
for i, t in enumerate(NEG_SENTENCES):
    for k in range(6):
        v = ALL[(i * 6 + k) % len(ALL)]
        jobs.append((f"{OUT}/neg/sent_{i}_{k}.wav", t, v, 1.0, 0.0))

print(f"total jobs: {len(jobs)}")
errs = []
with cf.ThreadPoolExecutor(max_workers=6) as ex:
    for n, err in enumerate(ex.map(synth, jobs)):
        if err:
            errs.append(err)
        if (n + 1) % 100 == 0:
            print(f"{n + 1}/{len(jobs)} done, errs={len(errs)}")
print(f"DONE {len(jobs) - len(errs)}/{len(jobs)} ok")
for e in errs[:10]:
    print("ERR", e)
sys.exit(1 if len(errs) > len(jobs) // 10 else 0)
