import mimetypes
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from starlette.middleware.sessions import SessionMiddleware

from app.auth import current_user, password_change_pending, session_user
from app.database import get_db
from app.permission_tree import PAGE_ORDER, PAGE_PERMISSIONS
from app.permissions import user_allowed_leaves
from app.config import ALLOWED_CLIENT_IPS, HTTPS_ENABLED, SECRET_KEY
from app.security import (
    ClientAddressAllowlistMiddleware,
    SameOriginWriteMiddleware,
    SecurityHeadersMiddleware,
    parse_allowed_networks,
    require_secret_key,
)
from app.routers import (
    audit,
    auth_router,
    cart,
    distributions,
    documents,
    editor,
    favorites,
    files,
    groups,
    imports,
    mdb,
    mdb_editor,
    mdb_tag_history,
    original_preview,
    projects,
    type_lists,
    users,
    vendors,
)

require_secret_key(SECRET_KEY)

# 화면 파일의 종류(MIME)를 윈도우 설정에 맡기지 않고 여기서 정한다. 윈도우 서버는 설정에 따라
# .js를 "일반 글자"로 알려주는 경우가 있는데, 아래 보안 머리글(nosniff)이 켜져 있으면 브라우저가
# 그런 파일을 실행하지 않아 화면이 통째로 멈춘다(2026-09-17, Azure 설치 대비).
for _ext, _mime in (
    (".js", "text/javascript"), (".mjs", "text/javascript"), (".css", "text/css"),
    (".json", "application/json"), (".wasm", "application/wasm"), (".svg", "image/svg+xml"),
    (".ico", "image/x-icon"),
):
    mimetypes.add_type(_mime, _ext)

# 자동으로 만들어지는 API 설명 화면(/docs 등)은 끈다 — 로그인 없이도 열려 모든 주소 목록이 드러난다.
app = FastAPI(title="G.Hub 도면관리시스템", docs_url=None, redoc_url=None, openapi_url=None)

# 요청은 아래에서 위 순서로 거친다(나중에 붙인 것이 바깥쪽):
# 허용 주소 검사 → 보안 머리글 → 다른 사이트 쓰기 요청 막기 → 로그인 세션 → 각 화면·API
# 세션 쿠키: same_site="strict"라 다른 사이트에서 넘어온 요청에는 따라가지 않고,
# https로 실행할 때는 https에서만 오간다(https_only).
app.add_middleware(
    SessionMiddleware, secret_key=SECRET_KEY, max_age=60 * 60 * 12,
    same_site="strict", https_only=HTTPS_ENABLED,
)
app.add_middleware(SameOriginWriteMiddleware)
app.add_middleware(SecurityHeadersMiddleware, https_enabled=HTTPS_ENABLED)
app.add_middleware(ClientAddressAllowlistMiddleware, allowed_networks=parse_allowed_networks(ALLOWED_CLIENT_IPS))

# 로그인 없이 열리는 라우터
app.include_router(auth_router.router)

# 로그인만 하면 접근 가능한 라우터. 화면·기능별 세부 권한은 permission_tree.py에 있는
# 항목만 각 라우터 안에서 개별적으로 app.permissions.require_permission(...)로 막는다
# (2026-08-12, 권한.xlsx 기준 CM 확정 — 트리에 없는 기능은 로그인만 하면 전부 열려 있어야
# 한다는 CM 방침 그대로). users/groups는 라우터 안에서 전부 require_permission("screen.users.access")로
# 개별 게이트된다(role=ADMIN은 자동 통과).
protected = [Depends(current_user)]
app.include_router(documents.router, dependencies=protected)
app.include_router(files.router, dependencies=protected)
app.include_router(favorites.router, dependencies=protected)
app.include_router(cart.router, dependencies=protected)
app.include_router(mdb.router, dependencies=protected)
app.include_router(original_preview.router, dependencies=protected)
app.include_router(projects.router, dependencies=protected)
app.include_router(type_lists.equipment_types_router, dependencies=protected)
app.include_router(type_lists.doc_types_router, dependencies=protected)
app.include_router(type_lists.tag_change_reasons_router, dependencies=protected)
app.include_router(vendors.router, dependencies=protected)
app.include_router(distributions.router, dependencies=protected)
app.include_router(imports.router, dependencies=protected)
app.include_router(audit.router, dependencies=protected)
app.include_router(editor.router, dependencies=protected)
app.include_router(mdb_editor.router, dependencies=protected)
app.include_router(mdb_tag_history.router, dependencies=protected)
app.include_router(users.router, dependencies=protected)
app.include_router(groups.router, dependencies=protected)


@app.get("/health")
def health():
    return {"status": "ok"}


class NoCacheStaticFiles(StaticFiles):
    """화면 파일(html/css/js)을 고쳤을 때 브라우저가 옛 파일을 계속 쓰지 않도록,
    매번 서버에 확인하게 한다. (변경 없으면 304로 응답하니 느려지지 않는다)"""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


# ── 화면 접속 권한 "페이지 접속" (2026-09-28 CM 지시) ────────────────────────────
# 예전에는 "사용자 관리" 화면만 권한이 있어야 들어갈 수 있었고, 그 검사도 화면 코드
# (auth-guard.js)와 그 화면 API에만 있었다. CM 지시로 모든 화면에 같은 항목을 만들면서,
# 화면 파일 자체를 내려줄 때 서버가 먼저 권한을 본다 — 화면 코드만으로 막으면 주소를
# 직접 친 사람에게는 화면이 그대로 내려가기 때문이다.
#
# 어느 화면에 어느 권한이 필요한지는 permission_tree.py의 PAGE_PERMISSIONS 한 곳에만 적고,
# /auth/me가 그 표를 화면에도 그대로 내려준다(상단 메뉴에서 링크를 빼는 데 쓴다).
#
# 주의: 이것은 "그 화면에 들어갈 수 있느냐"만 정한다. 화면 안의 기능은 예전처럼 각자의
# 권한(승인·반려, 폴더편집 등)이 따로 막고, 권한 트리에 없는 기능은 로그인만 하면 누구나
# 쓴다는 방침(2026-08-12 CM 확정)도 그대로다.

NO_ACCESS_PAGE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8" /><title>TDMS 기술자료 관리 시스템</title>
<link rel="icon" href="/assets/favicon.ico?v=1" />
<style>body{font-family:"맑은 고딕",sans-serif;background:#f5f5f4;color:#3a3a38;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#fff;border:1px solid #e0e0dd;border-radius:8px;padding:32px 40px;text-align:center}
h1{font-size:17px;margin:0 0 10px}p{font-size:13px;color:#6b6b66;margin:0 0 18px}
a{display:inline-block;font-size:13px;color:#3a3a38}</style></head>
<body><div class="box"><h1>접속할 수 있는 화면이 없습니다</h1>
<p>관리자에게 화면 접속 권한을 요청해 주세요.</p>
<a href="/login.html">로그인 화면으로</a></div></body></html>"""


def _serve_page(page: str, request: Request, db: Session):
    """화면 파일 하나를 내려준다 — 들어갈 권한이 있을 때만."""
    user = session_user(request, db)
    if user is None:
        if getattr(request.state, "login_expired", False):
            return RedirectResponse("/login.html?expired=1", status_code=302)
        return RedirectResponse("/login.html", status_code=302)
    if password_change_pending(request, user):
        return RedirectResponse("/login.html?change=1", status_code=302)

    allowed = user_allowed_leaves(db, user)  # role=ADMIN은 항상 전체
    if PAGE_PERMISSIONS[page] not in allowed:
        # 들어갈 수 있는 첫 화면으로 보낸다(상단 메뉴 차례 그대로). 하나도 없으면 안내 화면.
        target = next((p for p in PAGE_ORDER if PAGE_PERMISSIONS[p] in allowed), None)
        if target and target != page:
            return RedirectResponse(f"/{target}", status_code=302)
        return HTMLResponse(NO_ACCESS_PAGE, status_code=403)

    # 사람마다 결과가 다른 응답이라 중간에 저장해 두지 않게 한다
    return FileResponse(FRONTEND_DIR / page, headers={"Cache-Control": "no-store"})


def _register_page_route(path: str, page: str) -> None:
    async def handler(request: Request, db: Session = Depends(get_db), _page: str = page):
        return _serve_page(_page, request, db)

    app.add_api_route(path, handler, methods=["GET", "HEAD"], include_in_schema=False)


for _page_name in PAGE_PERMISSIONS:
    _register_page_route(f"/{_page_name}", _page_name)
_register_page_route("/", "index.html")  # 주소 없이 들어오면 TDB 조회 화면


app.mount("/", NoCacheStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
