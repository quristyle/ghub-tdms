# -*- coding: utf-8 -*-
"""기존 그룹에 새로 생긴 "페이지 접속" 권한을 Y로 넣어 두는 1회성 스크립트 (2026-09-28 CM 지시).

배경
  CM 지시로 모든 화면에 "페이지 접속" 권한 항목을 새로 만들었다(permission_tree.py).
  그런데 권한 트리의 기본값은 N(안전 기본값)이라, 그냥 두면 지금까지 잘 쓰던 동료들이
  다음 접속부터 모든 화면에 못 들어간다. 그래서 **지금과 똑같이 동작하도록** 이미 있는
  그룹에는 새 항목을 Y로 넣어 둔다. 어느 화면을 막을지는 CM이 권한 관리 화면에서 정하면 된다.

하는 일 (딱 이것뿐)
  · 이미 있는 그룹마다, 새로 생긴 "페이지 접속" 리프에 값이 없으면 Y로 넣는다.

손대지 않는 것 (지시 범위 밖)
  · 이미 값이 정해져 있는 항목은 Y든 N이든 그대로 둔다.
  · 예전부터 있던 "사용자 관리 페이지 접속"은 아예 손대지 않는다 — 값이 없다는 것이 곧
    "못 들어감"이라, 여기서 Y를 넣으면 못 들어가던 사람이 들어가게 된다.
  · 그 밖의 권한 항목·그룹·사용자 배정은 건드리지 않는다.
  · 앞으로 새로 만드는 그룹은 예전처럼 전부 N에서 시작한다(CM이 켜 준다).

실행
  python scripts/grant_page_access_20260928.py            무엇이 바뀌는지 보기만 (dry-run)
  python scripts/grant_page_access_20260928.py --apply    실제 반영 (먼저 백업 파일을 남긴다)

되돌리기
  백업 파일(backup/group_permissions_백업_*.json)에 이 스크립트가 넣기 전의 그룹별 권한이
  통째로 들어 있다.
"""

import argparse
import io
import json
import os
import sys
from datetime import datetime

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal  # noqa: E402
from app.models import AuditLog, Group, GroupPermission  # noqa: E402
from app.permission_tree import PAGE_PERMISSIONS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BACKUP_DIR = os.path.join(ROOT, "backup")
SYSTEM_USER_ID = 1  # 일괄등록 계정


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="실제로 반영한다(없으면 dry-run)")
    args = parser.parse_args()
    dry_run = not args.apply

    # 오늘 새로 만든 항목만 넣는다. "사용자 관리 페이지 접속"은 예전부터 있던 항목이라
    # 값이 없다는 건 "N(못 들어감)"이라는 뜻이므로 절대 건드리면 안 된다.
    OLD_KEY = "screen.users.access"
    access_keys = sorted(set(PAGE_PERMISSIONS.values()) - {OLD_KEY})
    db = SessionLocal()
    groups = db.query(Group).order_by(Group.id).all()

    planned = []  # (group, key)
    for g in groups:
        have = {
            r.node_key for r in db.query(GroupPermission).filter_by(group_id=g.id).all()
        }
        for key in access_keys:
            if key not in have:
                planned.append((g, key))

    print("그룹 %d개 · 화면 접속 권한 %d종" % (len(groups), len(access_keys)))
    for g in groups:
        keys = [k for (gg, k) in planned if gg.id == g.id]
        print("  [%d] %s — 새로 Y로 넣을 항목 %d개" % (g.id, g.name, len(keys)))
        for k in keys:
            print("        %s" % k)

    if not planned:
        print("\n넣을 것이 없습니다.")
        return

    if dry_run:
        print("\ndry-run이므로 아무것도 바꾸지 않았습니다. 실제 반영은 --apply 를 붙여 실행하세요.")
        return

    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, "group_permissions_백업_%s.json" % stamp)
    with open(backup_path, "w", encoding="utf-8") as handle:
        json.dump(
            [{"group_id": r.group_id, "node_key": r.node_key, "allowed": bool(r.allowed)}
             for r in db.query(GroupPermission).order_by(GroupPermission.group_id, GroupPermission.node_key).all()],
            handle, ensure_ascii=False, indent=2,
        )
    print("\n백업 저장: %s" % backup_path)

    for g, key in planned:
        db.add(GroupPermission(group_id=g.id, node_key=key, allowed=True))

    db.add(AuditLog(
        user_id=SYSTEM_USER_ID, action="GROUP_PERMISSION_UPDATE", screen="권한 관리",
        detail={"script": "grant_page_access_20260928",
                "reason": "새로 만든 화면 접속 권한을 기존 그룹에 Y로 채움(지금과 같은 동작 유지)",
                "added": [{"group_id": g.id, "group": g.name, "node_key": k} for g, k in planned],
                "backup": os.path.basename(backup_path)},
    ))
    db.commit()
    print("권한 %d개를 Y로 넣었습니다." % len(planned))


if __name__ == "__main__":
    main()
