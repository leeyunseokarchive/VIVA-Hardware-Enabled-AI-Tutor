"""VivaHW head v21 -> v22.

실조립 피드백 반영:
 1) 앞뒤 쉘 결합 부실 -> 기존 테이프 3점 보스(50/230/310deg)에 핀홀 + 별도 핀 3개
 2) 마이크 모듈 고정 -> 기존 D14 보스 제거 + 벽에 바로 원형 소켓(상단 개방) + 수음홀 재개방
 3) 뒤 쉘 내부 공간 -> Pi 트레이 +6mm(x) / 팔 꺾어 7.5mm 하강 / 포스트 높이 절반
 4) 전원 케이블 꺾임 -> 위와 동일 이동으로 -x 여유 31.8 -> 37.8mm
 5) 트레이 삽입 난이도 -> 셸 포스트 r44.8->43.9, 팔 끝 r47.3->46.3
 6) 드라이버 보드 지지대 4mm 하강
 7) 조인트 판 개방 (바깥링 + 포스트 스트랩 2개만 잔류)

단위 mm. 모든 좌표는 blend 월드좌표 그대로.
"""
# =========================================================================
# 실행 불가 — 기록용 스크립트.
#   이 스크립트가 먹는 입력(Head_v21_front.stl / Head_v21_back.stl)은 작업 세션
#   임시 폴더에만 있던 v21 월드좌표 셸이고, 이 저장소에 커밋된 적이 한 번도 없다
#   (git log --all 및 파일시스템 확인 완료. models/stl 과 archive/hw_stl_legacy 에
#   있는 VivaHW_print_v21_* 는 프린트 좌표 파일이고 _back 도 없다).
#   따라서 v22 는 재빌드할 수 없으며, 이 파일은 "v22 에서 무엇을 바꿨는가"의
#   기록으로만 남긴다. 아래 SRC_DIRS/src() 는 v23/v24 스크립트와 형태를 맞춘 것으로,
#   v21 월드 셸이 언젠가 복구되면 그 경로들에 넣으면 그대로 돌아간다.
# =========================================================================
import os
import numpy as np, trimesh
from trimesh.creation import cylinder, box, cone, revolve

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


OUT = os.environ.get("V22_OUT", HERE)   # 결과 STL 저장 위치
ENG = "manifold"

HEAD = np.array([150.0, -3.1, 236.3])   # 구 중심
R_IN, R_OUT = 49.4, 51.8
SEAM_Z = 238.70

# --- 1) 핀 ---------------------------------------------------------------
POST_ANG = [50.0, 230.0, 310.0]         # 기존 테이프 보스 = 트레이 포스트 각도
PIN_R_LOCAL = 45.5                      # 보스 반경폭 42.6~48.37 의 중앙
HOLE_D = 3.2                            # 프린트 후 실치수 ~3.0
PIN_D = 3.05
FRONT_DEPTH, BACK_DEPTH = 3.6, 5.0      # 앞 보스 4.6t / 뒤 보스 7.5t
PIN_LEN = FRONT_DEPTH + BACK_DEPTH - 0.2
PIN_CH = 0.4

# --- 2) 마이크 소켓 (벽면 직접 안착) --------------------------------------
PAD_C = np.array([124.12, 33.38, 228.52])   # 기존 pad(=D3 홀) 중심, 실측
MIC_D = 14.0                                # 원형 PCB
POCKET_D = MIC_D + 0.6                      # 편측 0.3 공차
SOCK_WALL = 1.6
POCKET_DEPTH = 3.65
FLOOR_R = 49.45                             # 포켓 바닥 = 내벽(49.4)에 낸 평면 시트
MIC_PORT_D = 3.0

# --- 3) Pi 트레이 ---------------------------------------------------------
DX = 6.0                                    # +x = 페이스 볼 때 오른쪽
TRAY_DROP = 7.5                             # 팔 중간에서 꺾어 프레임만 하강
PAD_Z0, PAD_Z1 = 246.30, 248.80             # 팔 끝(보스 위) — 불변
PLATE_Z0, PLATE_Z1 = PAD_Z0 - TRAY_DROP, PAD_Z1 - TRAY_DROP   # 238.80 ~ 241.30
# 꺾임(수직 다리) 위치: 심 보스(r42.6~48.37, z238.70~246.20) 안쪽이어야 함.
# 다리 상단 팔은 보스 상면(246.20) 위라 자유, 다리 본체만 r+D/2 < 42.6 조건.
LEG_R = 38.4                                # 다리 중심 로컬반경 (외경 40.9 < 42.6)
LEG_D = 5.0                                 # Pi 보드/헤더 옆을 지나야 해서 가늘게
BAR_W = 7.0
POST_XY = [(150.0 + sx * 11.5 + DX, -5.37 + sy * 29.0) for sx in (-1, 1) for sy in (-1, 1)]
POST_BASE_D, POST_PIN_D = 5.0, 2.4
POST_BASE_H = 1.75                          # 기존 3.5의 절반
POST_BASE_Z1 = PLATE_Z1 + POST_BASE_H       # 243.05  (Pi 보드 하면)
POST_PIN_Z1 = POST_BASE_Z1 + 2.9            # 245.95
POST_TIP_Z1 = POST_PIN_Z1 + 1.0             # 246.95
PAD_D, PAD_HOLE_D = 9.2, 2.7
POST_R_OLD, POST_R = 44.8, 43.9             # 셸 포스트 안쪽 이동 (삽입성)
TRAY_R_MAX = 46.3                           # z248.8 내벽 47.79 대비 1.49 여유
PI_BOARD = (141.0, 171.0, -37.87, 27.13)    # 이동 후 보드 풋프린트 (다리 회피용)

# --- 6) 디스플레이 드라이버 보드 지지대 ------------------------------------
DB_XY = [(150.0 + sx * 25.0, -3.1 + sy * 29.0) for sx in (-1, 1) for sy in (-1, 1)]
DB_SHAFT_D, DB_PIN_D = 6.0, 2.0
DB_SEAT_OLD, DB_PIN_TOP_OLD = 215.90, 218.80
DB_DROP = 4.0
DB_SEAT = DB_SEAT_OLD - DB_DROP             # 211.90
DB_PIN_TOP = DB_PIN_TOP_OLD - DB_DROP       # 214.80

# --- 7) 조인트 판 개방 -----------------------------------------------------
JP_Z0, JP_Z1 = 274.06, 279.06               # 판 (두께 5.0)
JP_KEEP_R = 27.5                            # 이 반경 바깥은 링으로 잔류 (링벽 r29~30 기저)
JP_POST_R = 20.25                           # 조인트 포스트 2개, +-x 축
JP_STRAP_W = 9.0
JP_STRAP_R0 = 16.0                          # 스트랩 안쪽 끝


def post_xy(ang, r):
    a = np.radians(ang)
    return HEAD[0] + r * np.cos(a), HEAD[1] + r * np.sin(a)


def zcyl(d, z0, z1, xy, sections=64):
    m = cylinder(radius=d / 2.0, height=z1 - z0, sections=sections)
    m.apply_translation([xy[0], xy[1], (z0 + z1) / 2.0])
    return m


def zbox(x0, x1, y0, y1, z0, z1):
    m = box(extents=[x1 - x0, y1 - y0, z1 - z0])
    m.apply_translation([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2])
    return m


def chk(name, m):
    print(f"  {name:22s} watertight={m.is_watertight} volume={m.volume:10.2f} "
          f"euler={m.euler_number} faces={len(m.faces)}")
    return m


def heal(path):
    """STL 재임포트 시 생기는 퇴화/중복 페이스 제거 (process.md 힐링 루프)."""
    m = trimesh.load(path)
    for d in (6, 5, 4):
        m.merge_vertices(digits_vertex=d)
        m.update_faces(m.nondegenerate_faces())
        m.update_faces(m.unique_faces())
        m.remove_unreferenced_vertices()
        if m.is_watertight:
            return m
    raise RuntimeError(f"{path} not watertight after heal")


# =========================================================================
print("== load ==")
front = heal(src("Head_v21_front.stl"))
back = heal(src("Head_v21_back.stl"))
chk("v21_front", front)
chk("v21_back", back)

# ---- 핀홀 ---------------------------------------------------------------
print("== pin holes ==")
centers = [post_xy(a, PIN_R_LOCAL) for a in POST_ANG]
probe_f = np.array([[x, y, SEAM_Z - FRONT_DEPTH / 2] for x, y in centers])
probe_b = np.array([[x, y, SEAM_Z + BACK_DEPTH / 2] for x, y in centers])
assert front.contains(probe_f).all() and back.contains(probe_b).all(), "보스에 살 없음"
v0f, v0b = front.volume, back.volume
for xy in centers:
    front = front.difference(zcyl(HOLE_D, SEAM_Z - FRONT_DEPTH, SEAM_Z + 2.0, xy), engine=ENG)
    back = back.difference(zcyl(HOLE_D, SEAM_Z - 2.0, SEAM_Z + BACK_DEPTH, xy), engine=ENG)
print(f"  front 제거 {v0f - front.volume:7.2f} / back 제거 {v0b - back.volume:7.2f}")

# ---- 트레이 포스트 안으로 이동 (삽입성) ----------------------------------
print("== relocate tray posts ==")
SP_Z0, SP_Z1, SP_TIP = 246.20, 248.60, 249.40
for ang in POST_ANG:
    old, new = post_xy(ang, POST_R_OLD), post_xy(ang, POST_R)
    back = back.difference(zcyl(3.0, SP_Z0 - 0.05, SP_TIP + 0.6, old), engine=ENG)
    back = back.union(zcyl(POST_PIN_D, SP_Z0 - 0.5, SP_Z1, new), engine=ENG)
    tip = cone(radius=POST_PIN_D / 2, height=SP_TIP - SP_Z1 + 0.3, sections=32)
    tip.apply_translation([new[0], new[1], SP_Z1 - 0.3])
    back = back.union(tip, engine=ENG)
print(f"  post span r = {POST_R - POST_PIN_D/2:.2f} ~ {POST_R + POST_PIN_D/2:.2f} (보스 42.60~48.37)")
print("  new posts solid:", back.contains(np.array([[*post_xy(a, POST_R), SP_Z1 - 0.5] for a in POST_ANG])))
print("  old posts gone :", ~back.contains(np.array([[*post_xy(a, 46.0), SP_Z1 - 0.5] for a in POST_ANG])))

# ---- 조인트 판 개방 -------------------------------------------------------
print("== open joint plate ==")
v0 = back.volume
cutter = zcyl(JP_KEEP_R * 2, JP_Z0 - 0.6, JP_Z1 + 0.6, (HEAD[0], HEAD[1]), sections=192)
for s in (+1, -1):
    r0, r1 = sorted((HEAD[0] + s * JP_STRAP_R0, HEAD[0] + s * (JP_KEEP_R + 1.5)))
    cutter = cutter.difference(
        zbox(r0, r1, HEAD[1] - JP_STRAP_W / 2, HEAD[1] + JP_STRAP_W / 2, JP_Z0 - 1.0, JP_Z1 + 1.0), engine=ENG)
back = back.difference(cutter, engine=ENG)
print(f"  판 제거 {v0 - back.volume:8.2f} mm3")
# 검증: 포스트 2개는 스트랩 위에 그대로 서 있어야, 스트랩 사이(±y)는 뚫려야
pz = (JP_Z0 + JP_Z1) / 2
print("  포스트 하부 살아있음:", back.contains(np.array([
    [HEAD[0] + s * JP_POST_R, HEAD[1], pz] for s in (+1, -1)])))
print("  ±y 개방 확인:", ~back.contains(np.array([
    [HEAD[0], HEAD[1] + s * 20.0, pz] for s in (+1, -1)])))
print("  바깥링 잔류:", back.contains(np.array([
    [HEAD[0], HEAD[1] + s * 31.0, pz] for s in (+1, -1)])))
chk("v22_back", back)

# ---- 마이크: 기존 보스 제거 + 벽면 소켓 + 수음홀 재개방 --------------------
print("== mic socket ==")
u = PAD_C - HEAD
r_pad = float(np.linalg.norm(u))
u = u / r_pad
e1 = np.array([0.0, 0.0, 1.0]) - np.dot([0.0, 0.0, 1.0], u) * u   # 면내 '위'
e1 /= np.linalg.norm(e1)
e2 = np.cross(u, e1)
F = np.eye(4)                      # local(x=e2, y=e1, z=u) -> world
F[:3, 0], F[:3, 1], F[:3, 2] = e2, e1, u
F[:3, 3] = HEAD
print(f"  기존 pad r={r_pad:.3f} -> 신규 시트 r={FLOOR_R}  (모듈이 {FLOOR_R - r_pad:.2f}mm 바깥으로)")


def ucyl(d, r0, r1, sections=64):
    m = cylinder(radius=d / 2.0, height=r1 - r0, sections=sections)
    m.apply_translation([0, 0, (r0 + r1) / 2.0])
    m.apply_transform(F)
    return m


def ubox(ext, ctr):
    m = box(extents=ext)
    m.apply_translation(ctr)
    m.apply_transform(F)
    return m


sock_od = POCKET_D + 2 * SOCK_WALL                  # 17.8
front = front.union(ucyl(sock_od, FLOOR_R - POCKET_DEPTH, 50.3), engine=ENG)
front = front.difference(ucyl(POCKET_D, 30.0, FLOOR_R), engine=ENG)   # 기존 D14 보스 제거 + 포켓 + 평면시트
front = front.difference(ubox([16.0, 11.0, 4.5], [0.0, 11.0, 47.25]), engine=ENG)  # 전선 노치 r45.0~49.5
front = front.difference(ucyl(MIC_PORT_D, 30.0, 53.0), engine=ENG)    # 수음홀 재개방 (v22 1차에서 막혔던 것)
chk("front + mic socket", front)
mic = ucyl(MIC_D, FLOOR_R - 3.0, FLOOR_R - 0.01)
print(f"  mic D14x3.0 간섭 = {front.intersection(mic, engine=ENG).volume:.4f} mm3")
port = np.array([HEAD + u * r for r in (46.0, 48.0, 50.0, 51.0)])
print("  수음홀 관통 확인 (전부 False 여야):", front.contains(port))
print("  노치/하벽 =", front.contains(np.array([
    (F @ np.array([0.0, 8.1, FLOOR_R - 1.8, 1.0]))[:3],
    (F @ np.array([0.0, -8.1, FLOOR_R - 1.8, 1.0]))[:3]])))

# ---- 드라이버 보드 지지대 4mm 하강 ----------------------------------------
print("== lower driver-board posts ==")
v0 = front.volume
for xy in DB_XY:
    front = front.difference(zcyl(DB_SHAFT_D + 0.4, DB_SEAT, DB_PIN_TOP_OLD + 2.0, xy), engine=ENG)
    front = front.union(zcyl(DB_PIN_D, DB_SEAT - 0.5, DB_PIN_TOP, xy), engine=ENG)
print(f"  제거 {v0 - front.volume:7.2f} mm3, 안착면 {DB_SEAT_OLD} -> {DB_SEAT}, 핀끝 {DB_PIN_TOP}")
print("  안착면 아래 살:", front.contains(np.array([[x, y, DB_SEAT - 1.0] for x, y in DB_XY])))
print("  구 높이 제거 :", ~front.contains(np.array([[x, y, DB_SEAT_OLD - 1.0] for x, y in DB_XY])))
chk("v22_front", front)

# ---- 트레이 (팔 꺾어 하강) -------------------------------------------------
print("== tray ==")
xs, ys = sorted({p[0] for p in POST_XY}), sorted({p[1] for p in POST_XY})
x0, x1 = xs[0] - BAR_W / 2, xs[1] + BAR_W / 2
y0, y1 = ys[0] - BAR_W / 2, ys[1] + BAR_W / 2
tray = zbox(x0, x1, y0, y1, PLATE_Z0, PLATE_Z1).difference(
    zbox(x0 + BAR_W, x1 - BAR_W, y0 + BAR_W, y1 - BAR_W, PLATE_Z0 - 2, PLATE_Z1 + 2), engine=ENG)

corner = {50.0: (x1 - BAR_W / 2, y1 - BAR_W / 2),
          230.0: (x0 + BAR_W / 2, y0 + BAR_W / 2),
          310.0: (x1 - BAR_W / 2, y0 + BAR_W / 2)}
bx0, bx1, by0, by1 = PI_BOARD
HDR = (166.15, 171.25, -32.60, 18.40)       # 이동 후 Pi 헤더 (z244.45~252.95)


def rect_gap(pt, rect, half):
    x0, x1, y0, y1 = rect
    n = np.array([min(max(pt[0], x0), x1), min(max(pt[1], y0), y1)])
    return float(np.linalg.norm(pt - n)) - half


for ang in POST_ANG:
    P = np.array(post_xy(ang, POST_R))
    L = np.array(post_xy(ang, LEG_R))       # 수직 다리: 같은 각도, 보스 안쪽 반경
    C = np.array(corner[ang])
    gb, gh = rect_gap(L, PI_BOARD, LEG_D / 2), rect_gap(L, HDR, LEG_D / 2)
    print(f"  arm {ang:5.0f}  leg=({L[0]:7.2f},{L[1]:7.2f}) 외경r={LEG_R + LEG_D/2:5.2f}  "
          f"~Pi보드 {gb:5.2f}  ~헤더 {gh:5.2f}  윗팔 캔틸레버 {np.linalg.norm(P - L):4.1f}mm")
    assert gb > 0.5 and gh > 0.5, f"arm {ang} 다리 간섭"
    pad = zcyl(PAD_D, PAD_Z0, PAD_Z1, P)
    up = trimesh.convex.convex_hull(np.vstack([
        pad.vertices, zcyl(LEG_D, PAD_Z0, PAD_Z1, L).vertices]))          # 보스 상면 위 수평 팔
    leg = zcyl(LEG_D, PLATE_Z0, PAD_Z1, L)                                 # 직각 수직 다리
    low = trimesh.convex.convex_hull(np.vstack([
        zcyl(LEG_D, PLATE_Z0, PLATE_Z1, L).vertices,
        zcyl(BAR_W, PLATE_Z0, PLATE_Z1, C).vertices]))
    for part in (pad, up, leg, low):
        tray = tray.union(part, engine=ENG)

tray = tray.intersection(zcyl(TRAY_R_MAX * 2, PLATE_Z0 - 1, PAD_Z1 + 1,
                              (HEAD[0], HEAD[1]), sections=256), engine=ENG)
for ang in POST_ANG:
    tray = tray.difference(zcyl(PAD_HOLE_D, PAD_Z0 - 1, PAD_Z1 + 1, post_xy(ang, POST_R)), engine=ENG)
for xy in POST_XY:
    tray = tray.union(zcyl(POST_BASE_D, PLATE_Z1 - 0.5, POST_BASE_Z1, xy), engine=ENG)
    tray = tray.union(zcyl(POST_PIN_D, POST_BASE_Z1 - 0.5, POST_PIN_Z1, xy), engine=ENG)
    tip = cone(radius=POST_PIN_D / 2, height=POST_TIP_Z1 - POST_PIN_Z1 + 0.3, sections=32)
    tip.apply_translation([xy[0], xy[1], POST_PIN_Z1 - 0.3])
    tray = tray.union(tip, engine=ENG)
chk("v22_tray", tray)
print(f"  Pi 보드 하면 z={POST_BASE_Z1} (v21 252.30, {252.30 - POST_BASE_Z1:.2f}mm 하강)")
print(f"  프레임 z={PLATE_Z0}~{PLATE_Z1} (심 {SEAM_Z} 위 {PLATE_Z0 - SEAM_Z:.2f}mm)")
print(f"  tray ∩ back = {tray.intersection(back, engine=ENG).volume:.4f} mm3")
print(f"  tray ∩ front = {tray.intersection(front, engine=ENG).volume:.4f} mm3")

# ---- 핀 3개 -------------------------------------------------------------
R = PIN_D / 2.0
prof = np.array([[0, 0], [R - PIN_CH, 0], [R, PIN_CH],
                 [R, PIN_LEN - PIN_CH], [R - PIN_CH, PIN_LEN], [0, PIN_LEN]])
one = revolve(prof, sections=48)
pins = []
for i in range(3):
    p = one.copy()
    p.apply_translation([i * 10.0, 0, 0])
    pins.append(p)
pinset = trimesh.util.concatenate(pins)
chk("pins x3", pinset)

# ---- 출력 ---------------------------------------------------------------
print("== export ==")
for n, m in (("Head_v22_front", front), ("Head_v22_back", back),
             ("Head_v22_tray", tray), ("Pin_v22_x3", pinset)):
    m.export(os.path.join(OUT, f"{n}.stl"))
    print(f"  {n}.stl  watertight={m.is_watertight} vol={m.volume:.1f}")
