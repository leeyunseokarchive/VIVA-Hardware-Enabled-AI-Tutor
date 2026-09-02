"""VivaHW head v22 -> v23 : 핀/핀홀 보강 (실조립 핀 파손 대응).

배경: v22 앞/뒤 쉘 결합 핀(⌀3.05 × 8.4, 3점 @ 50/230/310deg)이 출력·조립 중 부러짐.
원인 2가지 — (1) 핀이 가늘다, (2) 핀을 세워서 출력해 레이어가 축에 수직(굽힘에 약함).

측정(build 시점 v22 월드 셸 프로빙, 심 z=238.70 보스 중앙):
  - 보스 반경 살: r 42.6 ~ 50.9 (바깥은 셸벽과 합체)
  - v22 홀(⌀3.2 @ r45.5): 반경 안쪽 벽 1.4mm(빡빡) / 바깥 벽 3.9mm(여유) — 비대칭
  => 안쪽 1.4mm만 제약. 핀 중심을 0.5mm 바깥으로 옮기면 안쪽 벽 유지하며 홀 확대 가능.

변경(사용자 선택: "강하게, 중심 이동"):
  - 핀 중심  r 45.5 -> 46.0  (0.5mm 바깥)
  - 핀홀 ⌀  3.2  -> 4.2
  - 핀   ⌀  3.05 -> 4.05  (홀-핀 간극 0.15 유지 = v22 압입 캘리브레이션 계승)
  - 길이/깊이/챔퍼 불변: 앞깊이 3.6 / 뒤깊이 5.0 / 핀길이 8.4 / 리드챔퍼 0.4
  결과 예상 벽: 반경 안쪽 ~1.3mm(유지) / 바깥 ~2.8mm / 접선 ~1.8mm.
  핀 굽힘강도 ~ (4.05/3.05)^3 = 2.34배, 단면적 ~ 1.76배.

입력: 버전관리된 v22 프린트 STL을 역-z이동해 월드좌표 복원 (완전 재현 가능).
  print_front = world_front + (0,0,-200.70) ,  print_back = world_back + (0,0,-238.70)
출력: v23 월드 셸(블렌더용) + 프린트 STL(front/back/pins/oneplate/tray).

단위 mm. ⚠ 앞·뒤 쉘과 핀은 반드시 같은 v23 세트로 출력할 것(중심 반경 바뀜).
"""
import os
import numpy as np
import trimesh
from trimesh.creation import cylinder, revolve

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


OUT = os.environ.get("V23_OUT", HERE)   # 결과 STL 저장 위치
ENG = "manifold"

# ---- 기준 좌표 (build_v22.py 계승) --------------------------------------
HEAD = np.array([150.0, -3.1, 236.3])
SEAM_Z = 238.70
POST_ANG = [50.0, 230.0, 310.0]
FRONT_DEPTH, BACK_DEPTH = 3.6, 5.0
FRONT_DZ, BACK_DZ = -200.70, -238.70   # 월드 -> 프린트 z 이동 (실측 확인)

# ---- v23 신규 파라미터 --------------------------------------------------
PIN_R_LOCAL = 46.0     # v22: 45.5  (+0.5 바깥)
HOLE_D = 4.2           # v22: 3.2
PIN_D = 4.05           # v22: 3.05  (간극 0.15 유지)
PIN_LEN = FRONT_DEPTH + BACK_DEPTH - 0.2   # 8.4
PIN_CH = 0.4


def post_xy(ang, r):
    a = np.radians(ang)
    return HEAD[0] + r * np.cos(a), HEAD[1] + r * np.sin(a)


def zcyl(d, z0, z1, xy, sections=96):
    m = cylinder(radius=d / 2.0, height=z1 - z0, sections=sections)
    m.apply_translation([xy[0], xy[1], (z0 + z1) / 2.0])
    return m


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
    """분리된 미세 셸(더블 삼각형 슬리버 등) 제거 — 본체만 유지.
    부피(.volume)는 비폐곡 메시에서 신뢰 불가하므로 정점 수로 판별
    (실부품 최소 258정점, 슬리버 ≤3정점)."""
    comps = m.split(only_watertight=False)
    if len(comps) <= 1:
        return m
    keep = [c for c in comps if len(c.vertices) >= min_verts]
    dropped = len(comps) - len(keep)
    if dropped:
        print(f"    슬리버 {dropped}개 제거")
    return trimesh.util.concatenate(keep) if len(keep) > 1 else keep[0]


def probe_wall(mesh, zc, tag):
    """보스 중심 프로빙으로 홀/살 경계 확인."""
    print(f"  [{tag}] z={zc:.1f}")
    for a in POST_ANG:
        cx, cy = post_xy(a, PIN_R_LOCAL)
        rs = np.arange(40.0, 51.0, 0.1)
        pr = np.array([[HEAD[0] + r*np.cos(np.radians(a)), HEAD[1] + r*np.sin(np.radians(a)), zc] for r in rs])
        sd = mesh.contains(pr)
        rin = next((rs[i] for i in range(len(rs)) if sd[i]), None)
        rout = next((rs[i] for i in range(len(rs)-1, -1, -1) if sd[i]), None)
        emp = [rs[i] for i in range(len(rs)) if not sd[i] and rin is not None and rs[i] > rin and rout is not None and rs[i] < rout]
        hole = (min(emp), max(emp)) if emp else None
        if hole and rin is not None and rout is not None:
            wi, wo = hole[0] - rin, rout - hole[1]
            print(f"    ang{a:4.0f}: boss r{rin:.1f}..{rout:.1f}  hole r{hole[0]:.1f}..{hole[1]:.1f}  "
                  f"벽(안{wi:.2f}/바{wo:.2f})")
        else:
            print(f"    ang{a:4.0f}: hole=None boss r{rin}..{rout}")


# =========================================================================
print("== load v22 print STL -> world ==")
front = trimesh.load(src("VivaHW_print_v22_front.stl"))
back = trimesh.load(src("VivaHW_print_v22_back.stl"))
front.apply_translation([0, 0, -FRONT_DZ])   # +200.70
back.apply_translation([0, 0, -BACK_DZ])     # +238.70
print("  입력 슬리버 정리:")
front, back = strip_slivers(heal(front)), strip_slivers(heal(back))
print(f"  front wt={front.is_watertight} z={front.bounds[0][2]:.1f}..{front.bounds[1][2]:.1f} vol={front.volume:.1f}")
print(f"  back  wt={back.is_watertight} z={back.bounds[0][2]:.1f}..{back.bounds[1][2]:.1f} vol={back.volume:.1f}")

print("== v22 홀 현황(확대 전) ==")
probe_wall(front, SEAM_Z - FRONT_DEPTH / 2, "front v22")

# ---- 새 핀홀 (r46.0, ⌀4.2) : 기존 홀을 완전히 포함해 클린 확대 -----------
print("== bore v23 holes ==")
centers = [post_xy(a, PIN_R_LOCAL) for a in POST_ANG]
v0f, v0b = front.volume, back.volume
for xy in centers:
    front = front.difference(zcyl(HOLE_D, SEAM_Z - FRONT_DEPTH, SEAM_Z + 2.0, xy), engine=ENG)
    back = back.difference(zcyl(HOLE_D, SEAM_Z - 2.0, SEAM_Z + BACK_DEPTH, xy), engine=ENG)
front, back = strip_slivers(heal(front)), strip_slivers(heal(back))
print(f"  front 제거 {v0f - front.volume:7.2f} / back 제거 {v0b - back.volume:7.2f} mm3")
print(f"  front wt={front.is_watertight}  back wt={back.is_watertight}")

print("== v23 벽 검증 ==")
probe_wall(front, SEAM_Z - FRONT_DEPTH / 2, "front v23")
probe_wall(back, SEAM_Z + BACK_DEPTH / 2, "back v23")

# ---- 핀 3개 (⌀4.05 × 8.4, 양단 0.4 챔퍼) -------------------------------
print("== pins x3 ==")
R = PIN_D / 2.0
prof = np.array([[0, 0], [R - PIN_CH, 0], [R, PIN_CH],
                 [R, PIN_LEN - PIN_CH], [R - PIN_CH, PIN_LEN], [0, PIN_LEN]])
one = revolve(prof, sections=64)
print(f"  1핀 wt={one.is_watertight} vol={one.volume:.2f} (v22 1핀 ~59.8mm3 대비 ~1.77배)")


def pinset_at(centers_xy, z0):
    ps = []
    for (x, y) in centers_xy:
        p = one.copy()
        p.apply_translation([x, y, z0])
        ps.append(p)
    return trimesh.util.concatenate(ps)


# ---- 월드 셸 출력 (블렌더 임포트용) ------------------------------------
print("== export world shells ==")
front.export(os.path.join(OUT, "w_front_v23.stl"))
back.export(os.path.join(OUT, "w_back_v23.stl"))
# 조립 위치 핀(블렌더 Pin_fit 갱신용): 심 아래 FRONT_DEPTH-0.1 부터
pin_z0_world = SEAM_Z - (FRONT_DEPTH - 0.1)   # v22 Pin_fit 과 동일 규칙 (235.2)
for a in POST_ANG:
    x, y = post_xy(a, PIN_R_LOCAL)
    pinset_at([(x, y)], pin_z0_world).export(os.path.join(OUT, f"w_pinfit_{int(a)}_v23.stl"))

# ---- 프린트 STL --------------------------------------------------------
print("== export print STLs ==")
pf = front.copy(); pf.apply_translation([0, 0, FRONT_DZ])
pb = back.copy(); pb.apply_translation([0, 0, BACK_DZ])
pf.export(os.path.join(OUT, "VivaHW_print_v23_front.stl"))
pb.export(os.path.join(OUT, "VivaHW_print_v23_back.stl"))

# 기존 oneplate 레이아웃 그대로 재현: comp 위치 추출 -> 부품만 교체
print("== rebuild oneplate (기존 배치 계승) ==")
op = trimesh.load(src("VivaHW_print_v22_oneplate.stl"))
comps = sorted(op.split(only_watertight=False), key=lambda m: -len(m.vertices))
op_front, op_back, op_tray = comps[0], comps[1], strip_slivers(comps[2])
op_pins = [c for c in comps[3:6]]   # 3 pins
# front/back: 신규(외곽 동일)를 기존 comp 최소코너에 정렬
off_f = op_front.bounds[0] - pf.bounds[0]
off_b = op_back.bounds[0] - pb.bounds[0]
pf_pl = pf.copy(); pf_pl.apply_translation(off_f)
pb_pl = pb.copy(); pb_pl.apply_translation(off_b)
# pins: 기존 핀 각 중심(x,y)에 세워서, 바닥 z=0
plate_pins = []
for c in op_pins:
    cx = (c.bounds[0][0] + c.bounds[1][0]) / 2
    cy = (c.bounds[0][1] + c.bounds[1][1]) / 2
    plate_pins.append(pinset_at([(cx, cy)], 0.0))
oneplate = strip_slivers(trimesh.util.concatenate([pf_pl, pb_pl, op_tray] + plate_pins))
_opath = os.path.join(OUT, "VivaHW_print_v23_oneplate.stl")
oneplate.export(_opath)
# STL 왕복 시 정점병합으로 front 퇴화면이 슬리버로 떨어짐 -> 재로드 후 재정리
strip_slivers(trimesh.load(_opath)).export(_opath)
# 독립 핀 세트(오리진, 10mm 간격 3개, 세워서)
pinset_at([(0.0, 0.0), (10.0, 0.0), (20.0, 0.0)], 0.0).export(
    os.path.join(OUT, "VivaHW_print_v23_pins.stl"))
# tray 는 불변 — v22 파일 그대로 복사본 유지
op_tray.export(os.path.join(OUT, "VivaHW_print_v23_tray.stl"))

print("\n== done ==")
for n in ("VivaHW_print_v23_front", "VivaHW_print_v23_back",
          "VivaHW_print_v23_pins", "VivaHW_print_v23_oneplate", "VivaHW_print_v23_tray"):
    p = os.path.join(OUT, n + ".stl")
    m = trimesh.load(p)
    print(f"  {n}.stl  wt={m.is_watertight}  bounds_z={m.bounds[0][2]:.1f}..{m.bounds[1][2]:.1f}")
