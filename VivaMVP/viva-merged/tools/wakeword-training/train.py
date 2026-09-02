#!/usr/bin/env python3
"""'비바야' 웨이크워드 헤드 재학습 파이프라인.

TTS 클립 → 원거리 증강(감쇠·잡음·잔향·저역통과) → openWakeWord 특징
(mel/embedding onnx, 런타임과 동일 스케일: int16 값 그대로 float32) →
윈도우 라벨링 → torch 헤드 학습(기존 bibaya.onnx 와 동일 구조) →
구모델 대비 검증 → ONNX export(동일 입출력 텐서명).

라벨링: 윈도우(~1.96s)의 끝이 발화 종료 -0.15s..+0.5s 안이면 양성 -
런타임이 "새로 끝나는 윈도우만" 채점하는 방식과 정합. 발화 중간에 끝나는
윈도우(단어 앞부분만 들림)는 음성 라벨 - 완성 전 발화("비바...")에 점수를
주지 않게 학습해 게이트 오탐을 줄인다.
"""
import glob
import os
import sys

import numpy as np
import onnx
import onnxruntime as ort
import soundfile as sf
import torch
import torch.nn as nn

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = f"{BASE}/data"
ASSETS = "/Users/leeyunseok/Desktop/Artfly/VIVA/VivaMVP/viva-merged/src/assets/wakeword"
RNG = np.random.default_rng(20260814)
SR = 16000

MEL_BINS = 32
EMB_WINDOW = 76
EMB_STEP = 8
WW_FRAMES = 16
EMB_DIM = 96
MEL_HOP = 160

# 검증 전용 홀드아웃 화자(학습에 안 씀) - 일반화 측정
VAL_VOICES = [
    "ko-KR-Chirp3-HD-Charon", "ko-KR-Chirp3-HD-Kore", "ko-KR-Chirp3-HD-Fenrir",
    "ko-KR-Chirp3-HD-Leda", "ko-KR-Wavenet-D", "ko-KR-Neural2-B",
]

mel_sess = ort.InferenceSession(f"{ASSETS}/melspectrogram.onnx")
emb_sess = ort.InferenceSession(f"{ASSETS}/embedding_model.onnx")


# --- 증강 -------------------------------------------------------------------
def pink_noise(n):
    white = RNG.standard_normal(n // 2 + 1) + 1j * RNG.standard_normal(n // 2 + 1)
    f = np.arange(1, n // 2 + 2)
    spec = white / np.sqrt(f)
    return np.fft.irfft(spec, n).astype(np.float32)


def synth_rir(rt60):
    n = int(rt60 * SR)
    t = np.arange(n) / SR
    h = RNG.standard_normal(n).astype(np.float32) * np.exp(-6.9 * t / rt60)
    h[0] = 1.0  # 직접음
    return h / np.abs(h).sum() * 3.0


def lowpass(x, cutoff):
    from scipy.signal import butter, lfilter
    b, a = butter(4, cutoff / (SR / 2), btype="low")
    return lfilter(b, a, x).astype(np.float32)


def augment(wav, far=True):
    """정규화 float(-1..1) 입력 -> int16 스케일 float32 출력."""
    x = wav.astype(np.float32)
    peak = np.abs(x).max() + 1e-9
    x = x / peak
    if far:
        if RNG.random() < 0.7:
            x = np.convolve(x, synth_rir(RNG.uniform(0.15, 0.5)))[: len(x) + SR // 2]
        if RNG.random() < 0.6:
            x = lowpass(x, RNG.uniform(3000, 7000))
        # 실기기 발화 피크 amp 2천~9천/32767 ≈ 0.06~0.27
        target_peak = np.exp(RNG.uniform(np.log(0.04), np.log(0.35)))
    else:
        target_peak = np.exp(RNG.uniform(np.log(0.2), np.log(0.9)))
    x = x / (np.abs(x).max() + 1e-9) * target_peak
    # 잡음: 실기기 유휴 RMS ~0.004 근방 + SNR 변주
    noise = pink_noise(len(x)) if RNG.random() < 0.6 else RNG.standard_normal(len(x)).astype(np.float32)
    snr_db = RNG.uniform(4, 22)
    sig_rms = np.sqrt((x ** 2).mean()) + 1e-9
    noise = noise / (np.sqrt((noise ** 2).mean()) + 1e-9) * sig_rms / (10 ** (snr_db / 20))
    x = x + noise
    return np.clip(x * 32767, -32768, 32767).astype(np.float32)


# --- 특징 -------------------------------------------------------------------
def clip_features(samples_i16f):
    """int16 스케일 float32 파형 -> (임베딩 [K,96], 프레임 수)."""
    mel_out = mel_sess.run(None, {"input": samples_i16f[None, :]})[0]
    mel = mel_out.reshape(-1, MEL_BINS) / 10.0 + 2.0
    frames = mel.shape[0]
    K = (frames - EMB_WINDOW) // EMB_STEP + 1
    if K < WW_FRAMES:
        return None, frames
    idx = np.arange(EMB_WINDOW)[None, :] + (np.arange(K) * EMB_STEP)[:, None]
    batch = mel[idx][:, :, :, None].astype(np.float32)  # [K,76,32,1]
    emb = emb_sess.run(None, {"input_1": batch})[0].reshape(K, EMB_DIM)
    return emb, frames


def windows_from_emb(emb):
    K = emb.shape[0]
    W = K - WW_FRAMES + 1
    if W <= 0:
        return np.empty((0, WW_FRAMES, EMB_DIM), np.float32)
    idx = np.arange(WW_FRAMES)[None, :] + np.arange(W)[:, None]
    return emb[idx]  # [W,16,96]


def window_end_sample(w):
    return ((w + WW_FRAMES - 1) * EMB_STEP + EMB_WINDOW) * MEL_HOP


def load_wav(path):
    x, sr = sf.read(path, dtype="float32", always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    assert sr == SR, f"{path}: sr={sr}"
    return x


def trim_silence(x, thresh=0.02):
    a = np.abs(x)
    peak = a.max() + 1e-9
    on = np.where(a > peak * thresh)[0]
    return x[max(0, on[0] - 800): on[-1] + 800] if len(on) else x


# --- 데이터셋 구축 ----------------------------------------------------------
def build():
    Xtr, ytr, wtr, Xva, yva, wva = [], [], [], [], [], []

    def emit(feats, label, weight, is_val):
        (Xva if is_val else Xtr).append(feats)
        (yva if is_val else ytr).append(label)
        (wva if is_val else wtr).append(weight)

    pos_files = sorted(glob.glob(f"{DATA}/pos/*.wav"))
    neg_files = sorted(glob.glob(f"{DATA}/neg/*.wav"))
    print(f"pos clips={len(pos_files)} neg clips={len(neg_files)}")

    for pi, path in enumerate(pos_files):
        voice = os.path.basename(path).split("_")[0]
        is_val = voice in VAL_VOICES
        utt = trim_silence(load_wav(path))
        n_aug = 3 if is_val else 5
        for ai in range(n_aug):
            far = ai != 0  # 1개는 근거리 클린 유지
            # 2.6초 컨텍스트에 랜덤 배치(정렬 다양화)
            ctx = np.zeros(int(2.6 * SR), np.float32)
            max_start = len(ctx) - len(utt) - 1600
            if max_start <= SR:  # 발화가 길면 앞쪽 고정
                start = 1600
            else:
                start = int(RNG.uniform(SR * 0.8, max_start))
            end = start + len(utt)
            ctx[start:end] += utt[: len(ctx) - start]
            x = augment(ctx, far=far)
            emb, _ = clip_features(x)
            if emb is None:
                continue
            wins = windows_from_emb(emb)
            for w in range(wins.shape[0]):
                we = window_end_sample(w)
                if end - int(0.15 * SR) <= we <= end + int(0.5 * SR):
                    emit(wins[w], 1.0, 1.0, is_val)
                elif start + int(0.1 * SR) <= we <= end - int(0.2 * SR):
                    emit(wins[w], 0.0, 0.5, is_val)  # 단어 앞부분만 = 음성(저가중)
                elif we < start - int(0.2 * SR):
                    emit(wins[w], 0.0, 0.3, is_val)  # 발화 전 잡음
        if (pi + 1) % 100 == 0:
            print(f"  pos {pi + 1}/{len(pos_files)}")

    for ni, path in enumerate(neg_files):
        base = os.path.basename(path)
        voice = base.split("_", 1)[1].rsplit("_", 1)[0] if base.startswith("hard") else ""
        is_val = voice in VAL_VOICES or (base.startswith("sent") and ni % 11 == 0)
        raw = load_wav(path)
        hard = base.startswith("hard")
        for ai in range(2):
            pad = np.zeros(max(int(2.2 * SR), len(raw) + SR), np.float32)
            off = int(RNG.uniform(0, SR * 0.5))
            pad[off: off + len(raw)] += raw
            x = augment(pad, far=ai == 1)
            emb, _ = clip_features(x)
            if emb is None:
                continue
            wins = windows_from_emb(emb)
            weight = 2.0 if hard else 1.0  # 유사 발음은 세게
            for w in range(wins.shape[0]):
                emit(wins[w], 0.0, weight, is_val)
        if (ni + 1) % 200 == 0:
            print(f"  neg {ni + 1}/{len(neg_files)}")

    # 잡음 단독 (기기 유휴 상태 위양성 방어)
    for i in range(80):
        n = int(2.5 * SR)
        x = pink_noise(n) if i % 2 else RNG.standard_normal(n).astype(np.float32)
        x = x / (np.abs(x).max() + 1e-9) * np.exp(RNG.uniform(np.log(0.003), np.log(0.05)))
        x = np.clip(x * 32767, -32768, 32767).astype(np.float32)
        emb, _ = clip_features(x)
        if emb is None:
            continue
        wins = windows_from_emb(emb)
        for w in range(wins.shape[0]):
            emit(wins[w], 0.0, 1.0, i % 10 == 0)

    def pack(X, y, wt):
        return (np.stack(X).astype(np.float32), np.array(y, np.float32),
                np.array(wt, np.float32))

    return pack(Xtr, ytr, wtr), pack(Xva, yva, wva)


# --- 모델 (bibaya.onnx 와 동일 구조) ---------------------------------------
class Head(nn.Module):
    def __init__(self):
        super().__init__()
        self.flatten = nn.Flatten()
        self.layer1 = nn.Linear(WW_FRAMES * EMB_DIM, 128)
        self.layernorm1 = nn.LayerNorm(128)
        self.relu1 = nn.ReLU()
        self.layer2 = nn.Linear(128, 1)

    def forward(self, x):
        h = self.relu1(self.layernorm1(self.layer1(self.flatten(x))))
        return torch.sigmoid(self.layer2(h))


def evaluate(scores, y, name):
    pos = scores[y == 1]
    neg = scores[y == 0]
    print(f"  [{name}] pos n={len(pos)} neg n={len(neg)}")
    for th in (0.05, 0.08, 0.1, 0.2, 0.3, 0.5):
        rec = (pos >= th).mean() if len(pos) else 0
        fpr = (neg >= th).mean() if len(neg) else 0
        print(f"    th={th:0.2f} recall={rec:0.3f} neg_fp={fpr * 100:0.3f}%")


def main():
    (Xtr, ytr, wtr), (Xva, yva, wva) = build()
    print(f"train windows={len(ytr)} (pos {int(ytr.sum())}) "
          f"val windows={len(yva)} (pos {int(yva.sum())})")
    np.savez_compressed(f"{BASE}/dataset_val.npz", X=Xva, y=yva)

    dev = torch.device("cpu")
    model = Head().to(dev)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    Xt = torch.from_numpy(Xtr)
    yt = torch.from_numpy(ytr)
    wt = torch.from_numpy(wtr)
    # 클래스 균형 - 양성 희소 보정
    pos_ratio = ytr.mean()
    wt = wt * torch.where(yt > 0.5, (1 - pos_ratio) / max(pos_ratio, 1e-3), 1.0)

    best_state, best_metric, patience = None, -1.0, 0
    n = len(yt)
    for epoch in range(60):
        model.train()
        perm = torch.randperm(n)
        total = 0.0
        for i in range(0, n, 512):
            idx = perm[i: i + 512]
            opt.zero_grad()
            p = model(Xt[idx]).squeeze(-1)
            loss = nn.functional.binary_cross_entropy(p, yt[idx], weight=wt[idx])
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        model.eval()
        with torch.no_grad():
            sva = model(torch.from_numpy(Xva)).squeeze(-1).numpy()
        rec = (sva[yva == 1] >= 0.1).mean()
        fpr = (sva[yva == 0] >= 0.1).mean()
        metric = rec - fpr * 20  # 오탐 벌점
        if metric > best_metric:
            best_metric, best_state, patience = metric, {
                k: v.clone() for k, v in model.state_dict().items()}, 0
        else:
            patience += 1
        print(f"epoch {epoch} loss={total / n:0.4f} val_recall@0.1={rec:0.3f} "
              f"val_fp@0.1={fpr * 100:0.2f}% {'*' if patience == 0 else ''}")
        if patience >= 8:
            break
    model.load_state_dict(best_state)

    # 최종 평가: 신모델 vs 구모델
    model.eval()
    with torch.no_grad():
        s_new = model(torch.from_numpy(Xva)).squeeze(-1).numpy()
    old = ort.InferenceSession(f"{ASSETS}/bibaya.onnx")
    s_old = old.run(None, {"onnx::Flatten_0": Xva})[0].reshape(-1)
    print("=== validation (홀드아웃 화자 + 미학습 증강) ===")
    evaluate(s_new, yva, "NEW")
    evaluate(s_old, yva, "OLD bibaya.onnx")

    # export - 입출력 텐서명을 기존 모델과 동일하게
    out_path = f"{BASE}/bibaya_ko.onnx"
    dummy = torch.zeros(1, WW_FRAMES, EMB_DIM)
    torch.onnx.export(
        model, dummy, out_path,
        input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=13,
    )
    m = onnx.load(out_path)
    m.graph.input[0].name = "onnx::Flatten_0"
    for node in m.graph.node:
        node.input[:] = ["onnx::Flatten_0" if i == "input" else i for i in node.input]
    onnx.checker.check_model(m)
    onnx.save(m, out_path)
    # ort 스모크: 이름/shape/값 일치
    sess = ort.InferenceSession(out_path)
    chk = sess.run(None, {"onnx::Flatten_0": Xva[:8]})[0].reshape(-1)
    ref = s_new[:8]
    assert np.allclose(chk, ref, atol=1e-4), (chk, ref)
    print(f"exported {out_path} ({os.path.getsize(out_path)} bytes) - ort smoke ok")


if __name__ == "__main__":
    sys.exit(main())
