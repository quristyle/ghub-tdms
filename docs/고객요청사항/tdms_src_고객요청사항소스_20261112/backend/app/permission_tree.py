"""권한 관리 화면의 트리 구조 (2026-08-11 CM 요청, 2026-08-12 CM이 작성한 권한.xlsx로 전면 교체).

CM 요청 그대로: "시스템의 경로와 액션을 상,하위 체계로 구분"해서 마지막(최하위) 노드에만
Y/N 권한을 둔다. 상위 노드를 Y로 켜면 하위 액션 전부가 Y로 적용된다(화면 쪽 cascade 로직,
저장은 항상 leaf 키로 풀어서 함).

개정(2026-08-12): CM이 권한.xlsx로 화면별 세부 항목(1차/2차/3차)과 설명을 정리해서 보내옴.
처음엔 엑셀에 없는 기존 항목(TDB/MDB 조회의 조회·다운로드·엑셀내보내기, 반출이력의 이력조회·
미입고조회, 중복반출 통합승인, 사용자관리의 등록·수정 등, 마이페이지 등)을 실제 화면 기능이라
지우지 않고 남겨뒀었는데, CM이 확인 후 "그것들은 다 빼라 — 엑셀에 없는 건 전부 아무나 쓸 수
있는 기능이라 권한으로 막을 필요가 없다"고 확정함. 그래서 **이 트리는 이제 권한.xlsx에 적힌
항목만 그대로 담는다** — 엑셀에 없는 화면·기능은 전 사용자 공통이라 권한 트리에 아예 없다.
(마이페이지 비밀번호 변경도 같은 이유로 트리에서 뺐다 — 로그인한 사람은 누구나 쓰는 기능.)

각 리프에 CM이 적어준 설명(desc)이 있으면 화면에 같이 보여준다.

트리 구조 자체는 코드에 고정한다 — CM이 화면에서 노드를 추가·삭제하게 하면 실제 없는
기능에 대한 권한이 생기거나, 새로 생긴 기능에 권한 항목이 안 생기는 어긋남이 생긴다.
"""

PERMISSION_TREE = [
    {
        "key": "screen.tdb_list",
        "label": "TDB 조회",
        "children": [
            {
                "key": "screen.tdb_list.access",
                "label": "페이지 접속",
                "desc": "N 선택시 TDB 조회 화면 접속이 안됨",
            },
            {
                "key": "screen.tdb_list.distribute",
                "label": "반출 실행",
                "children": [
                    {"key": "screen.tdb_list.distribute.modify", "label": "수정용"},
                ],
            },
        ],
    },
    {
        "key": "screen.tdb_import",
        "label": "TDB 반입·검수",
        "children": [
            {
                "key": "screen.tdb_import.access",
                "label": "페이지 접속",
                "desc": "N 선택시 TDB 반입·검수 화면 접속이 안됨",
            },
            {
                "key": "screen.tdb_import.register",
                "label": "반입등록",
                "desc": "ALL은 조회, 클릭 등을 포함한 모든 기능",
            },
            {
                "key": "screen.tdb_import.review",
                "label": "검수 대기",
                "children": [
                    {"key": "screen.tdb_import.review.approve", "label": "승인"},
                    {"key": "screen.tdb_import.review.reject", "label": "반려"},
                ],
            },
            {
                "key": "screen.tdb_import.issue",
                "label": "확인 필요",
                "children": [
                    {"key": "screen.tdb_import.issue.reattach", "label": "자료 재첨부"},
                    {"key": "screen.tdb_import.issue.repath", "label": "경로 재선택"},
                    {"key": "screen.tdb_import.issue.recheck", "label": "재검수"},
                    {"key": "screen.tdb_import.issue.reject", "label": "반려"},
                ],
            },
        ],
    },
    {
        "key": "screen.tdb_editor",
        "label": "TDB 관리",
        "children": [
            {
                "key": "screen.tdb_editor.access",
                "label": "페이지 접속",
                "desc": "N 선택시 TDB 관리 화면 접속이 안됨",
            },
            {"key": "screen.tdb_editor.folder", "label": "폴더편집"},
            {"key": "screen.tdb_editor.document", "label": "자료편집"},
            {"key": "screen.tdb_editor.zip_register", "label": "Zip 폴더 업로드"},
            # 폐기 보관함(복구·비고 작성)은 이 권한 하나로 관장한다 — 목록을 보는 것은 권한
            # 없이도 되고(조회 화면에서도 이력을 봐야 하므로), 고치는 것만 막는다(2026-08-30).
            {"key": "screen.tdb_editor.retire", "label": "폐기 보관함"},
            {"key": "screen.tdb_editor.restore", "label": "삭제 보관함"},
        ],
    },
    {
        "key": "screen.tdb_distributions",
        "label": "TDB 반출이력",
        "children": [
            {
                "key": "screen.tdb_distributions.access",
                "label": "페이지 접속",
                "desc": "N 선택시 TDB 반출이력 화면 접속이 안됨",
            },
            {
                "key": "screen.tdb_distributions.viewer",
                "label": "반출자 조회",
                "children": [
                    {
                        "key": "screen.tdb_distributions.viewer.other_user",
                        "label": "다른 사용자 선택",
                        "desc": "N 선택시 이름만 조회 가능",
                    },
                ],
            },
            {
                "key": "screen.tdb_distributions.confirm",
                "label": "확인",
                "children": [
                    {
                        "key": "screen.tdb_distributions.confirm.manual_return",
                        "label": "수정없이 반납처리",
                    },
                ],
            },
        ],
    },
    {
        "key": "screen.mdb_list",
        "label": "MDB 조회",
        "children": [
            {
                "key": "screen.mdb_list.access",
                "label": "페이지 접속",
                "desc": "N 선택시 MDB 조회 화면 접속이 안됨",
            },
        ],
    },
    {
        "key": "screen.mdb_editor",
        "label": "MDB 관리",
        "children": [
            {
                "key": "screen.mdb_editor.access",
                "label": "페이지 접속",
                "desc": "N 선택시 MDB 관리 화면 접속이 안됨",
            },
            {"key": "screen.mdb_editor.tag", "label": "폴더 편집"},
            {"key": "screen.mdb_editor.document", "label": "자료 편집"},
            {"key": "screen.mdb_editor.zip_register", "label": "Zip 폴더 업로드"},
            {"key": "screen.mdb_editor.retire", "label": "폐기 보관함"},
            {"key": "screen.mdb_editor.restore", "label": "삭제 보관함"},
        ],
    },
    {
        "key": "screen.audit",
        "label": "시스템 로그",
        "children": [
            {
                "key": "screen.audit.access",
                "label": "페이지 접속",
                "desc": "N 선택시 시스템 로그 화면 접속이 안됨",
            },
            {
                "key": "screen.audit.viewer",
                "label": "사용자 조회",
                "children": [
                    {
                        "key": "screen.audit.viewer.other_user",
                        "label": "다른 사용자 선택",
                        "desc": "N 선택시 이름만 조회 가능",
                    },
                ],
            },
        ],
    },
    {
        "key": "screen.users",
        "label": "사용자 관리",
        "children": [
            {
                "key": "screen.users.access",
                "label": "페이지 접속",
                "desc": "N 선택시 사용자 관리 화면 접속이 안됨",
            },
        ],
    },
    {
        "key": "common",
        "label": "공통",
        "children": [
            {
                "key": "common.note_edit",
                "label": "비고 작성",
                "children": [
                    {"key": "common.note_edit.revision", "label": "Revision 이력 비고 작성"},
                    {"key": "common.note_edit.distribution", "label": "반출 이력 비고 작성"},
                    {"key": "common.note_edit.tdb_trash", "label": "TDB 삭제 보관함 비고 작성"},
                    {"key": "common.note_edit.mdb_trash", "label": "MDB 삭제 보관함 비고 작성"},
                ],
            },
        ],
    },
]


# 화면 파일 → 그 화면에 들어가는 데 필요한 권한 ("페이지 접속" 리프).
# 2026-09-28 CM 지시로 사용자 관리에만 있던 "페이지 접속"을 모든 화면에 똑같이 만들었다.
# 여기 한 곳만 보고 두 군데가 함께 움직인다:
#   · 서버(main.py) — 이 화면 파일을 요청하면 권한을 보고 내려줄지 정한다(진짜 경계).
#   · 화면(auth-guard.js) — /auth/me가 이 표를 그대로 받아 상단 메뉴에서 그 화면 링크를 빼고,
#     주소를 직접 쳐서 들어온 경우 들어갈 수 있는 화면으로 돌려보낸다.
# 자료 상세보기(detail.html·mdb-detail.html)는 여러 화면에서 함께 쓰는 곳이라 넣지 않는다.
PAGE_PERMISSIONS: dict[str, str] = {
    "index.html": "screen.tdb_list.access",
    "import.html": "screen.tdb_import.access",
    "editor.html": "screen.tdb_editor.access",
    "distributions.html": "screen.tdb_distributions.access",
    "mdb.html": "screen.mdb_list.access",
    "mdb-editor.html": "screen.mdb_editor.access",
    "audit.html": "screen.audit.access",
    "users.html": "screen.users.access",
    "groups.html": "screen.users.access",
}

# 로그인한 사람을 어느 화면으로 보낼지 정할 때 쓰는 차례(상단 메뉴 차례 그대로).
PAGE_ORDER: list[str] = [
    "index.html", "import.html", "editor.html", "distributions.html",
    "mdb.html", "mdb-editor.html", "audit.html", "users.html"
]


def _leaf_keys(nodes) -> set[str]:
    keys: set[str] = set()
    for node in nodes:
        children = node.get("children")
        if children:
            keys |= _leaf_keys(children)
        else:
            keys.add(node["key"])
    return keys


LEAF_KEYS: set[str] = _leaf_keys(PERMISSION_TREE)
