"""VivaHW head v23 -> v24 : 마이크 소켓 +2mm(풀 링) + 스피커 소켓 재설계 (FDS28 원형 -> Jessinie 2840 사각).

배경 (2026-08-18):
  (1) v22 마이크 소켓(포켓 깊이 3.65)이 얕아서 모듈이 고정 안 됨 -> 벽만 안쪽으로 2mm 연장(깊이 5.65),
      C자 전선 노치는 완전히 제거하고 360° 풀 링으로 (전선은 소켓 열린 안쪽 끝으로 배출).
  (2) 스피커 FDS28(⌀28 원형, 5.2t) -> Jessinie 2840 (40×28 사각 프레임, 총두께 11.5, 자석 ⌀16.5,
      4-⌀3.0 홀 피치 34×22.5). 평면 프레임이라 시트 평면이 내벽보다 ~6mm 안쪽이어야 하고,
      기존 링은 심(z238.70)에 걸쳐 있어 사각 소켓+핀을 한 덩어리로 못 만듦
      -> 사용자 선택: 뒤 쉘 안으로 완전 이동 (A안), 핀 ⌀2.8×4 + 림 + 글루, 그릴 ⌀2.5×19 육각.

입력: 버전관리된 v23 프린트 STL을 역-z이동해 월드좌표 복원 (build_v23_pins.py 방식 계승).
  print_front = world_front + (0,0,-200.70) ,  print_back = world_back + (0,0,-238.70)
출력: v24 월드 셸(블렌더용) + 프린트 STL(front/back/pins/oneplate/tray) + 스피커/마이크 목업.

단위 mm. 모든 좌표는 blend 월드좌표.
"""
import os
import numpy as np
import trimesh
from trimesh.creation import cylinder, box, revolve, extrude_polygon, icosphere
from shapely.geometry import Polygon, Point

HERE = os.path.dirname(os.path.abspath(__file__))
# 입력 STL 탐색 경로 (스크립트 위치 기준 절대경로 -> 실행 디렉토리 무관):
#   1) 스크립트 폴더  2) VivaHW/models/stl  3) archive/hw_stl_legacy
SRC_DIRS = [HERE,
            os.path.join(HERE, os.pardir, "models", "stl"),
            os.path.join(HERE, os.pardir, os.pardir, "archive", "hw_stl_legacy")]


def src(name):
    """입력 STL 을 SRC_DIRS 순서로 찾아 경로 반환. 없으면 탐색 경로를 밝혀 에러."""
    for d in SRC_DIRS:
        p = os.path.normpath(os.path.join(d, name))
        if os.path.exists(p):
            return p
    raise FileNotFoundError(
        "%s 를 찾을 수 없음 — 탐색한 디렉토리: %s"
        % (name, ", ".join(os.path.normpath(d) for d in SRC_DIRS)))


OUT = os.environ.get("V24_OUT", HERE)
ENG = "manifold"

# ---- 기준 좌표 (build_v22/v23 계승) --------------------------------------
HEAD = np.array([150.0, -3.1, 236.3])      # 구 중심
R_IN_MEAS = 49.35                          # 내벽 실측(레이캐스트) — 도면값 49.4
CLEAN_R = 49.42                            # "내벽까지 깎기" 컷터 구 반경 (벽 0.05~0.07 니크, 슬리버 방지)
R_OUT = 51.8
SEAM_Z = 238.70
POST_ANG = [50.0, 230.0, 310.0]
FRONT_DZ, BACK_DZ = -200.70, -238.70

# ---- 핀 (v23 불변, 재출력용) ----------------------------------------------
PIN_R_LOCAL, PIN_D, PIN_LEN, PIN_CH = 46.0, 4.05, 8.4, 0.4
FRONT_DEPTH = 3.6

# ---- (1) 마이크 소켓 ------------------------------------------------------
PAD_C = np.array([124.12, 33.38, 228.52])   # 수음홀 축 상 점 (v22)
MIC_D = 14.0
POCKET_D = MIC_D + 0.6                      # 14.6
SOCK_WALL = 1.6
SOCK_OD = POCKET_D + 2 * SOCK_WALL          # 17.8
FLOOR_R = 49.45                             # 포켓 바닥(불변)
POCKET_DEPTH_OLD = 3.65
POCKET_DEPTH = POCKET_DEPTH_OLD + 2.0       # 5.65  <-- 변경
SOCK_TOP_R = FLOOR_R - POCKET_DEPTH         # 43.80
MIC_PORT_D = 3.0

# ---- (2) 스피커 2840 ------------------------------------------------------
# 구 스피커(FDS28) 링/시트판/그릴 — 제거 대상
OLD_AZ = 18.0                               # 링 축(수평) 방위각
OLD_C = np.array([192.037, 10.559, 244.7])  # 링 중심(Speaker_FDS28 오브젝트 위치)
OLD_CUT_R = 18.0                            # 링 OD ~33 -> ⌀36 컷터
# 신규 소켓
SPK_AZ, SPK_EL = 12.0, 26.0                 # 소켓 축 = 구면 법선 (az/el)
SPK_W, SPK_H = 40.0, 28.0                   # 프레임 (e2 가로 × e1 세로)
SPK_TOL = 0.5                               # 편측 (도면 ±0.5)
POCK_W, POCK_H = SPK_W + 2 * SPK_TOL, SPK_H + 2 * SPK_TOL   # 41.0 × 29.0
POCK_CR = 3.5                               # 포켓 모서리 R
RIM_T, RIM_H = 1.6, 2.5                     # 림 두께 / 시트 위 높이
SEAT_T = 42.9                               # 시트 평면 (HEAD 로부터 축 방향 거리) — 포켓 모서리 ρ23.75 에서 내벽 t=43.25
NOTCH_W = 12.0                              # 단자용 림 노치(양쪽 짧은 변)
HOLE_PITCH = (34.0, 22.5)
SPK_PIN_D = 2.8                             # 핀 (프레임 홀 ⌀3.0)
SPK_PIN_L = 4.0
KEEL_R = 1.45                               # 물방울 킬 클립 반경 (홀 R1.5 안)
WIN_D = 26.0                                # 콘 앞 창
GRILLE_D, GRILLE_P, GRILLE_N = 2.5, 5.0, 19 # 육각 19홀
# 스피커 목업(검증용): 프레임판 40×28×3 + 바스켓 ⌀26×5 + 자석 ⌀16.5×3.5 = 11.5
SPK_FRAME_T, SPK_BASKET_D, SPK_BASKET_T, SPK_MAG_D, SPK_MAG_T = 3.0, 26.0, 5.0, 16.5, 3.5


# =========================================================================
def frame_from_dir(az, el):
    """구 중심 기준 (az,el) 방향 법선 n, 면내 위 e1, 면내 가로 e2 -> 4x4 (local x=e2,y=e1,z=n)."""
    a, e = np.radians(az), np.radians(el)
    n = np.array([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)])
    e1 = np.array([0.0, 0.0, 1.0]) - np.dot([0.0, 0.0, 1.0], n) * n
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(n, e1)
    F = np.eye(4)
    F[:3, 0], F[:3, 1], F[:3, 2], F[:3, 3] = e2, e1, n, HEAD
    return F, n, e1, e2


def frame_from_axis(u):
    u = u / np.linalg.norm(u)
    e1 = np.array([0.0, 0.0, 1.0]) - np.dot([0.0, 0.0, 1.0], u) * u
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(u, e1)
    F = np.eye(4)
    F[:3, 0], F[:3, 1], F[:3, 2], F[:3, 3] = e2, e1, u, HEAD
    return F


def lcyl(F, d, t0, t1, xy=(0.0, 0.0), sections=96):
    m = cylinder(radius=d / 2.0, height=t1 - t0, sections=sections)
    m.apply_translation([xy[0], xy[1], (t0 + t1) / 2.0])
    m.apply_transform(F)
    return m


def lbox(F, ext, ctr):
    m = box(extents=ext)
    m.apply_translation(ctr)
    m.apply_transform(F)
    return m


def lprism(F, poly, t0, t1):
    m = extrude_polygon(poly, height=t1 - t0)
    m.apply_translation([0, 0, t0])
    m.apply_transform(F)
    return m


def zcyl(d, z0, z1, xy, sections=96):
    m = cylinder(radius=d / 2.0, height=z1 - z0, sections=sections)
    m.apply_translation([xy[0], xy[1], (z0 + z1) / 2.0])
    return m


def sphere(r, subdiv=5):
    s = icosphere(subdivisions=subdiv, radius=r)
    s.apply_translation(HEAD)
    return s


def rrect(w, h, cr, res=24):
    """모서리 R 사각형 (shapely)."""
    from shapely.geometry import box as sbox
    return sbox(-w / 2 + cr, -h / 2 + cr, w / 2 - cr, h / 2 - cr).buffer(cr, resolution=res)


def post_xy(ang, r):
    a = np.radians(ang)
    return HEAD[0] + r * np.cos(a), HEAD[1] + r * np.sin(a)


def heal(m):
    for dg in (6, 5, 4):
        m.merge_vertices(digits_vertex=dg)
        m.update_faces(m.nondegenerate_faces())
        m.update_faces(m.unique_faces())
        m.remove_unreferenced_vertices()
        if m.is_watertight:
            return m
    return m


def strip_slivers(m, min_verts=50):
    comps = m.split(only_watertight=False)
    if len(comps) <= 1:
        return m
    keep = [c for c in comps if len(c.vertices) >= min_verts]
    if len(comps) - len(keep):
        print(f"    슬리버 {len(comps) - len(keep)}개 제거")
    return trimesh.util.concatenate(keep) if len(keep) > 1 else keep[0]


def chk(name, m):
    print(f"  {name:20s} watertight={m.is_watertight} volume={m.volume:10.2f} faces={len(m.faces)}")
    return m


def ray_r(m, az, el):
    """구 중심에서 (az,el) 방향 레이 히트 반경 리스트."""
    a, e = np.radians(az), np.radians(el)
    d = np.array([[np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)]])
    loc, _, _ = m.ray.intersects_location(HEAD[None, :], d, multiple_hits=True)
    return sorted(np.linalg.norm(loc - HEAD, axis=1).round(2).tolist())


# =========================================================================
print("== load v23 print STL -> world ==")
front = trimesh.load(src("VivaHW_print_v23_front.stl")); front.apply_translation([0, 0, -FRONT_DZ])
back = trimesh.load(src("VivaHW_print_v23_back.stl")); back.apply_translation([0, 0, -BACK_DZ])
front, back = strip_slivers(heal(front)), strip_slivers(heal(back))
chk("v23_front", front); chk("v23_back", back)
V0F, V0B = front.volume, back.volume

# =========================================================================
print("== (1) 마이크 소켓: 깊이 3.65 -> 5.65, C자 노치 제거(풀 링) ==")
FM = frame_from_axis(PAD_C - HEAD)
u_mic = FM[:3, 2]
# 링 전체(바닥~벽 속)를 다시 union -> 노치 메움 + 2mm 연장, 그 후 포켓/수음홀 재관통
front = front.union(lcyl(FM, SOCK_OD, SOCK_TOP_R, 50.3), engine=ENG)
front = front.difference(lcyl(FM, POCKET_D, 30.0, FLOOR_R), engine=ENG)
front = front.difference(lcyl(FM, MIC_PORT_D, 30.0, 53.0), engine=ENG)
front = strip_slivers(heal(front))
chk("front + mic v24", front)
mic_mock = lcyl(FM, MIC_D, FLOOR_R - 3.0, FLOOR_R - 0.01)
print(f"  mic D14x3.0 간섭 = {front.intersection(mic_mock, engine=ENG).volume:.4f} mm3")
port = np.array([HEAD + u_mic * r for r in (44.0, 46.0, 48.0, 50.0, 51.0)])
print("  수음홀 관통(전부 False):", front.contains(port).tolist())
# 소켓 프로파일: 축에서 반경 ρ 별로 t 스캔 (링 벽 t=43.8~49.45 solid, 포켓 안 empty, 노치 없음)
def prof(rho, ang_deg):
    a = np.radians(ang_deg)
    pts = np.array([(FM @ np.array([rho * np.cos(a), rho * np.sin(a), t, 1.0]))[:3] for t in np.arange(42.0, 50.5, 0.1)])
    s = front.contains(pts)
    ts = np.arange(42.0, 50.5, 0.1)[s]
    return (round(ts.min(), 2), round(ts.max(), 2)) if len(ts) else None
print("  포켓 안(ρ6.5) 4방향 solid t범위:", [prof(6.5, a) for a in (0, 90, 180, 270)])
print("  링 벽(ρ8.1) 4방향 solid t범위 (43.8~ 이어야, 90°=구 노치 방향):", [prof(8.1, a) for a in (0, 90, 180, 270)])
print("  노치 자리(ρ8.1, 60~120°) solid 시작 t:", [prof(8.1, a)[0] if prof(8.1, a) else None for a in range(60, 121, 15)])

# =========================================================================
print("== (2a) 구 FDS28 링/시트판 제거 (앞·뒤) ==")
a_old = np.array([np.cos(np.radians(OLD_AZ)), np.sin(np.radians(OLD_AZ)), 0.0])
FO = np.eye(4); e2o = np.cross(a_old, [0, 0, 1.0]); FO[:3, 0], FO[:3, 1], FO[:3, 2], FO[:3, 3] = e2o, [0, 0, 1.0], a_old, OLD_C
old_cut = cylinder(radius=OLD_CUT_R, height=30.0, sections=128); old_cut.apply_translation([0, 0, -5.0]); old_cut.apply_transform(FO)  # s=-20..+10
old_cut = old_cut.intersection(sphere(CLEAN_R), engine=ENG)
vf, vb = front.volume, back.volume
front = strip_slivers(heal(front.difference(old_cut, engine=ENG)))
back = strip_slivers(heal(back.difference(old_cut, engine=ENG)))
print(f"  제거 front {vf - front.volume:.2f} / back {vb - back.volume:.2f} mm3")
for az, el in ((18, 10.8), (18, -8), (18, 29), (0, 10), (36, 10)):
    print(f"  ring zone az{az} el{el}: front {ray_r(front, az, el)} back {ray_r(back, az, el)}")

print("== (2b) 구 그릴 7홀 메움 ==")
# 방사 레이 그리드로 관통 방향 검출 -> 각 홀 방향으로 플러그
azs = np.arange(5, 31, 0.25); els = np.arange(0, 22, 0.25)
A, E = np.meshgrid(np.radians(azs), np.radians(els))
D = np.stack([np.cos(E) * np.cos(A), np.cos(E) * np.sin(A), np.sin(E)], -1).reshape(-1, 3)
hit = back.ray.intersects_any(np.repeat(HEAD[None, :], len(D), 0), D)
thr = np.stack([np.degrees(A).ravel(), np.degrees(E).ravel()], 1)[~hit]
zthr = HEAD[2] + R_IN_MEAS * np.sin(np.radians(thr[:, 1]))
thr = thr[zthr > SEAM_Z + 0.5]            # 심 아래(뒤 쉘 없음) 제외
from scipy.cluster.hierarchy import fcluster, linkage
lab = fcluster(linkage(thr, 'single'), 0.6, 'distance')
plugs = []
for k in np.unique(lab):
    c = thr[lab == k].mean(0)
    n_ = np.array([np.cos(np.radians(c[1])) * np.cos(np.radians(c[0])), np.cos(np.radians(c[1])) * np.sin(np.radians(c[0])), np.sin(np.radians(c[1]))])
    Fp = frame_from_axis(n_)
    plugs.append(lcyl(Fp, 4.0, CLEAN_R - 0.02, 53.0, sections=48))
    print(f"  hole az{c[0]:.2f} el{c[1]:.2f} n={np.sum(lab == k)}")
print(f"  검출 홀 {len(plugs)}개 (7 이어야)")
plug = trimesh.boolean.union(plugs, engine=ENG).intersection(sphere(R_OUT), engine=ENG)
# 하단 2홀(el~4.9) 플러그가 심 아래로 0.2 삐져나옴 -> 심 평면에서 클립 (앞 쉘과 겹치지 않게)
plug = plug.intersection(box(extents=[200, 200, 100]).apply_translation([HEAD[0], HEAD[1], SEAM_Z + 50.0]), engine=ENG)
back = strip_slivers(heal(back.union(plug, engine=ENG)))
hit2 = back.ray.intersects_any(np.repeat(HEAD[None, :], len(D), 0), D)
thr2 = np.stack([np.degrees(A).ravel(), np.degrees(E).ravel()], 1)[~hit2]
print(f"  메운 후 관통 방향 수 (심 위): {int(np.sum(HEAD[2] + R_IN_MEAS * np.sin(np.radians(thr2[:, 1])) > SEAM_Z + 0.5))} (0 이어야)")
chk("back cleaned", back)

# =========================================================================
print("== (2c) 신규 스피커 소켓 (az12 el26, 뒤 쉘) ==")
FS, n_s, e1_s, e2_s = frame_from_dir(SPK_AZ, SPK_EL)
def L(x, y, t):  # local -> world
    return (FS @ np.array([x, y, t, 1.0]))[:3]
# 시트/림 슬랩: 림 외곽 rounded-rect 프리즘 (t=SEAT_T-RIM_H .. 52) ∩ 구 r51.0 (벽 속에 묻힘, 외부 돌출 없음)
rim_poly = rrect(POCK_W + 2 * RIM_T, POCK_H + 2 * RIM_T, POCK_CR + RIM_T)
slab = lprism(FS, rim_poly, SEAT_T - RIM_H, 52.0).intersection(sphere(51.0), engine=ENG)
vb = back.volume
back = back.union(slab, engine=ENG)
print(f"  슬랩+림 union: +{back.volume - vb:.1f} mm3")
# 포켓 (시트 평면 t=SEAT_T)
back = back.difference(lprism(FS, rrect(POCK_W, POCK_H, POCK_CR), 30.0, SEAT_T), engine=ENG)
# 단자 노치 (양쪽 짧은 변, 림만)
for sx in (-1, 1):
    back = back.difference(lbox(FS, [RIM_T + 3.0, NOTCH_W, SEAT_T - 30.0], [sx * (POCK_W / 2 + RIM_T / 2 + 0.5), 0.0, (SEAT_T + 30.0) / 2]), engine=ENG)
# 콘 앞 창: 시트 평면 위 슬랩을 내벽까지 파냄 (벽은 유지)
win = lcyl(FS, WIN_D, 30.0, 60.0, sections=128).intersection(sphere(CLEAN_R), engine=ENG)
back = back.difference(win, engine=ENG)
# 그릴 19홀 (축 평행, 벽 관통)
gpts = [(0.0, 0.0)]
for i in range(6):
    a = np.radians(60 * i); gpts.append((GRILLE_P * np.cos(a), GRILLE_P * np.sin(a)))
for i in range(6):
    a = np.radians(60 * i); b_ = np.radians(60 * i + 60)
    gpts.append((2 * GRILLE_P * np.cos(a), 2 * GRILLE_P * np.sin(a)))
    gpts.append((GRILLE_P * (np.cos(a) + np.cos(b_)), GRILLE_P * (np.sin(a) + np.sin(b_))))
assert len(gpts) == GRILLE_N
grille = trimesh.boolean.union([lcyl(FS, GRILLE_D, 44.0, 56.0, xy=p, sections=32) for p in gpts], engine=ENG)
back = back.difference(grille, engine=ENG)
# 핀 4개: 물방울(킬) 단면 — 원 ⌀2.8 ∪ 45° 킬(-e1 방향) 을 R1.45 원으로 클립
circ = Point(0, 0).buffer(SPK_PIN_D / 2, resolution=32)
r_ = SPK_PIN_D / 2
keel = Polygon([(r_ * np.cos(np.radians(-45)), r_ * np.sin(np.radians(-45))), (-r_ * np.cos(np.radians(-45)), r_ * np.sin(np.radians(-45))), (0.0, -r_ * np.sqrt(2))])
pin_poly = circ.union(keel).intersection(Point(0, 0).buffer(KEEL_R, resolution=32))
for sx in (-1, 1):
    for sy in (-1, 1):
        p = lprism(FS, pin_poly, SEAT_T - SPK_PIN_L, SEAT_T + 0.3)
        p.apply_translation(sx * (HOLE_PITCH[0] / 2) * e2_s + sy * (HOLE_PITCH[1] / 2) * e1_s)
        back = back.union(p, engine=ENG)
back = strip_slivers(heal(back))
chk("back + speaker socket", back)
print(f"  뒤 쉘 순증 {back.volume - V0B:+.1f} mm3 (v23 {V0B:.1f})")

# ---- 검증 -------------------------------------------------------------
print("== 스피커 소켓 검증 ==")
# 시트 평면/림/핀 프로빙
def solid_t(x, y, t0=28.0, t1=51.0, step=0.1):
    ts = np.arange(t0, t1, step)
    s = back.contains(np.array([L(x, y, t) for t in ts]))
    return ts[s]
for (x, y, tag) in ((0, 0, "중앙(창)"), (15, 0, "창 밖 시트"), (0, 13.5, "시트 위쪽 가장자리"), (19.5, 13.5, "포켓 모서리 근처"),
                    (19.2, 13.2, "포켓 모서리 안(시트)"), (21.5, 0, "림 노치(림 없음, 시트~벽)"), (21.5, 10.0, "림 우측"), (0, 15.3, "림 위"), (0, -15.3, "림 아래"),
                    (17, 11.25, "핀 RT"), (-17, -11.25, "핀 LB")):
    ts = solid_t(x, y)
    print(f"  {tag:18s} local({x:5.1f},{y:6.2f}) solid t: {ts.min() if len(ts) else None} .. {ts.max() if len(ts) else None}")
# 그릴 관통
gm = np.array([L(px, py, 50.5) for px, py in gpts]); print("  그릴 19홀 벽 중간 비어있음:", (~back.contains(gm)).all())
# 심 여유: 소켓 최저 z
low = min(L(x, -(POCK_H / 2 + RIM_T), SEAT_T - RIM_H)[2] for x in (-22, 0, 22))
print(f"  소켓 최저 z = {low:.2f} (심 {SEAM_Z}, 여유 {low - SEAM_Z:.2f})")
# 상단 벽 확인 (az 0~25, el 40~50 내벽 깨끗)
print("  상단 내벽 r:", {(az, el): ray_r(back, az, el)[:1] for az in (0, 12, 25) for el in (40, 45, 50)})
# 스피커 목업 (프레임판 + 바스켓 + 자석) — 시트에 안착
spk_mock = trimesh.boolean.union([
    lprism(FS, rrect(SPK_W, SPK_H, 3.0), SEAT_T - SPK_FRAME_T, SEAT_T - 0.01),
    lcyl(FS, SPK_BASKET_D, SEAT_T - SPK_FRAME_T - SPK_BASKET_T, SEAT_T - SPK_FRAME_T + 0.01),
    lcyl(FS, SPK_MAG_D, SEAT_T - SPK_FRAME_T - SPK_BASKET_T - SPK_MAG_T, SEAT_T - SPK_FRAME_T - SPK_BASKET_T + 0.01)], engine=ENG)
# 프레임 홀
for sx in (-1, 1):
    for sy in (-1, 1):
        spk_mock = spk_mock.difference(lcyl(FS, 3.0, SEAT_T - 10, SEAT_T + 1, xy=(sx * HOLE_PITCH[0] / 2, sy * HOLE_PITCH[1] / 2)), engine=ENG)
print(f"  spk mock wt={spk_mock.is_watertight} vol={spk_mock.volume:.1f}")
print(f"  스피커 ∩ 뒤쉘 = {spk_mock.intersection(back, engine=ENG).volume:.4f} mm3")
print(f"  스피커 ∩ 앞쉘 = {spk_mock.intersection(front, engine=ENG).volume:.4f} mm3")
# 트레이(월드): 프린트 STL은 플레이트 배치(회전)라 xy 복원 불가 -> 블렌더 Head_v23_tray 를 월드 STL로 덤프한 파일 사용
_tp = os.path.join(OUT, "w_tray_v24.stl")
if os.path.exists(_tp):
    tray = trimesh.load(_tp)
    print(f"  스피커 ∩ 트레이 = {spk_mock.intersection(tray, engine=ENG).volume:.4f} mm3   (트레이 bb {tray.bounds.round(1).tolist()})")
    print(f"  트레이 ∩ 뒤쉘 = {tray.intersection(back, engine=ENG).volume:.4f} mm3")
    from trimesh.proximity import closest_point
    print(f"  스피커~트레이 최소 간격 {closest_point(tray, spk_mock.vertices)[1].min():.2f} mm")
else:
    tray = None
    print("  (w_tray_v24.stl 없음 — 트레이 간섭 검증 생략; 블렌더에서 Head_v23_tray 월드 덤프 필요)")
print(f"  앞쉘 ∩ 뒤쉘 (조립) = {front.intersection(back, engine=ENG).volume:.4f} mm3   back z_min={back.bounds[0][2]:.2f} front z_max={front.bounds[1][2]:.2f}")
# 주변 전자부품 bbox 거리 (Blender Electronics_v11 bb 기준)
def bbox_gap(mesh, bb):
    b0, b1 = np.array(bb[0]), np.array(bb[1])
    v = mesh.vertices
    q = np.clip(v, b0, b1)
    return float(np.min(np.linalg.norm(v - q, axis=1)))
for name, bb in (("Pi_header", ((166.1, -32.6, 244.4), (171.2, 18.4, 252.9))), ("Pi_board", ((141.0, -37.9, 243.1), (171.0, 27.1, 244.5))),
                 ("Amp_MAX98357A(재배치 예정)", ((165.0, -18.1, 248.8), (183.0, -0.1, 251.8))), ("Cable_CamFPC_1(가상)", ((175.2, -7.5, 234.0), (180.8, 29.3, 249.4))),
                 ("Cable_CamFPC_2(가상)", ((163.2, -29.7, 247.9), (180.8, -6.5, 256.5)))):
    print(f"  스피커 목업 ~ {name}: 최소 간격 {bbox_gap(spk_mock, bb):.2f} mm")
print(f"  스피커 뒷면(자석) 중심 r = {SEAT_T - 11.5:.1f}, 월드 {L(0, 0, SEAT_T - 11.5).round(1)}")
chk("v24_front", front); chk("v24_back", back)
print(f"  필라멘트 앞+뒤: v23 {V0F + V0B:.1f} -> v24 {front.volume + back.volume:.1f} mm3")

# =========================================================================
print("== export ==")
front.export(os.path.join(OUT, "w_front_v24.stl")); back.export(os.path.join(OUT, "w_back_v24.stl"))
spk_mock.export(os.path.join(OUT, "w_speaker2840_v24.stl")); mic_mock.export(os.path.join(OUT, "w_mic_mock_v24.stl"))
# 핀 fit (v23 동일)
R = PIN_D / 2.0
prof_ = np.array([[0, 0], [R - PIN_CH, 0], [R, PIN_CH], [R, PIN_LEN - PIN_CH], [R - PIN_CH, PIN_LEN], [0, PIN_LEN]])
one = revolve(prof_, sections=64)
def pinset_at(cs, z0):
    ps = []
    for (x, y) in cs:
        p = one.copy(); p.apply_translation([x, y, z0]); ps.append(p)
    return trimesh.util.concatenate(ps)
for a in POST_ANG:
    pinset_at([post_xy(a, PIN_R_LOCAL)], SEAM_Z - (FRONT_DEPTH - 0.1)).export(os.path.join(OUT, f"w_pinfit_{int(a)}_v24.stl"))
# 프린트 STL
pf = front.copy(); pf.apply_translation([0, 0, FRONT_DZ]); pf.export(os.path.join(OUT, "VivaHW_print_v24_front.stl"))
pb = back.copy(); pb.apply_translation([0, 0, BACK_DZ]); pb.export(os.path.join(OUT, "VivaHW_print_v24_back.stl"))
# oneplate: v23 배치 계승 (front/back 만 교체)
op = trimesh.load(src("VivaHW_print_v23_oneplate.stl"))
comps = sorted(op.split(only_watertight=False), key=lambda m: -len(m.vertices))
op_front, op_back, op_tray = comps[0], comps[1], strip_slivers(comps[2])
op_pins = comps[3:6]
pf_pl = pf.copy(); pf_pl.apply_translation(op_front.bounds[0] - pf.bounds[0])
pb_pl = pb.copy(); pb_pl.apply_translation(op_back.bounds[0] - pb.bounds[0])
plate_pins = [pinset_at([((c.bounds[0][0] + c.bounds[1][0]) / 2, (c.bounds[0][1] + c.bounds[1][1]) / 2)], 0.0) for c in op_pins]
_opath = os.path.join(OUT, "VivaHW_print_v24_oneplate.stl")
strip_slivers(trimesh.util.concatenate([pf_pl, pb_pl, op_tray] + plate_pins)).export(_opath)
strip_slivers(trimesh.load(_opath)).export(_opath)
pinset_at([(0.0, 0.0), (10.0, 0.0), (20.0, 0.0)], 0.0).export(os.path.join(OUT, "VivaHW_print_v24_pins.stl"))
op_tray.export(os.path.join(OUT, "VivaHW_print_v24_tray.stl"))
print("\n== done ==")
for n in ("VivaHW_print_v24_front", "VivaHW_print_v24_back", "VivaHW_print_v24_pins", "VivaHW_print_v24_oneplate", "VivaHW_print_v24_tray"):
    m = trimesh.load(os.path.join(OUT, n + ".stl"))
    print(f"  {n}.stl  wt={m.is_watertight}  bounds_z={m.bounds[0][2]:.1f}..{m.bounds[1][2]:.1f}")
