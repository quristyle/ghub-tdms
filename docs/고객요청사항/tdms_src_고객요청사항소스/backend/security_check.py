"""보안 자동 검사 (2026-10-01 CM 지시, D-111).

쓰는 방법은 두 가지다.

1) 사람이 직접 — 프로젝트 전체를 검사한다. 유지보수 업체가 코드를 고친 뒤에도 이것을 돌린다.
       backend> venv\\Scripts\\python.exe security_check.py
   문제가 없으면 "문제 없음"으로 끝나고(종료 코드 0), 있으면 목록을 보여 주고 종료 코드 1이다.
   처음 쓰는 PC라면 검사 도구부터 설치한다:
       backend> venv\\Scripts\\python.exe -m pip install -r requirements-dev.txt

2) Claude Code가 자동으로 — 파일을 고칠 때마다 .claude/settings.json의 훅이 `--hook`으로 부른다.
   고친 파일 하나만 본다. 꼭 고쳐야 하는 문제는 Claude에게 되돌려 보내 고치게 하고([막음]),
   사람이 판단할 일은 참고로만 알린다([안내]). 운영 서버에는 아무 영향이 없다.

무엇을 보는가 — CLAUDE.md "3-1. 보안 규칙"과 짝이다. 규칙을 바꾸면 둘을 같이 고친다.
  [막음] 비밀값    : .env의 DB 비밀번호·서명키가 파일에 그대로 적혀 있다 (규칙은 app/secret_values.py)
  [막음] 서버 코드 : bandit이 찾은 새 보안 경고 (기준표 bandit_baseline.json에 없는 것)
  [막음] 로그인    : main.py에 로그인 검사 없이 붙은 라우터·주소, 빠진 공통 보안 장치
  [막음] 엑셀      : 엑셀을 만드는 서버 파일에 수식 막기(neutralize_formulas)가 없다
  [막음] 화면 코드 : eval·new Function·document.write, 인라인 onclick 등, javascript: 주소, 인라인 <script>
  [안내] 화면 코드 : 새로 쓴 HTML 조각에 escapeHtml 없이 들어간 값
  [안내] 서버 코드 : 새 저장·수정 API에 권한 검사(require_permission)가 안 보임

검사 결과에 비밀값 자체는 절대 적지 않는다 — 어느 파일에 들어 있는지만 적는다.

경고가 "문제 아님"으로 판단되면(오탐):
  - 파이썬은 그 줄 끝에 `# nosec B000 — 이유`를 적는다(bandit 표준 방식, 이유를 반드시 함께).
  - 처음 도입할 때 있던 기존 경고는 bandit_baseline.json(기준표)에 모아 두었고, 그 이유는
    CLAUDE.md 3-1절에 적혀 있다. 기준표를 새로 만드는 `--update-baseline`은 그 순간 남아 있는
    경고를 전부 "문제 아님"으로 확정하는 일이라, 이유를 3-1절에 적은 뒤에만 쓴다.
"""

import argparse
import ast
import json
import os
import re
import subprocess  # nosec B404 — bandit을 따로 실행해 결과(JSON)만 받는다
import sys
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BACKEND_DIR.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"
MAIN_PY = BACKEND_DIR / "app" / "main.py"
BANDIT_CONFIG = "bandit.yaml"
BANDIT_BASELINE = "bandit_baseline.json"

# 전체 검사에서 bandit이 보는 곳 (backend 폴더 기준)
BANDIT_TARGETS = ("app", "scripts", "alembic", "run_server.py", "security_check.py")

# 비밀값을 찾아보는 곳 — 백업의 코드·화면 묶음(app/backup.py의 CODE_DIRS·CODE_FILES)과 같게 둔다.
# 묶음에 실려 나가는 파일이 곧 비밀이 새어 나갈 수 있는 파일이기 때문이다.
SECRET_SCAN_DIRS = ("backend", "frontend", "docs", "참고자료", ".claude")
SECRET_SCAN_FILES = ("CLAUDE.md", ".env.example")
SKIP_DIRS = {"venv", "__pycache__", ".git", "node_modules"}
SKIP_SUFFIXES = (".pyc", ".log")

# main.py에서 로그인 없이 열려도 되는 주소 (이유를 함께 적는다)
PUBLIC_MAIN_ROUTES = {
    "/health": "서버가 살아 있는지만 알려 준다(자료 없음)",
}
# main.py에 반드시 붙어 있어야 하는 공통 보안 장치
REQUIRED_MIDDLEWARES = {
    "SessionMiddleware": "로그인 세션",
    "SameOriginWriteMiddleware": "다른 사이트에서 보낸 쓰기 요청 막기",
    "SecurityHeadersMiddleware": "보안 머리글(CSP 등)",
    "ClientAddressAllowlistMiddleware": "허용 주소 검사",
}
# 로그인 없이 붙여도 되는 라우터 — 로그인 화면 자체
PUBLIC_ROUTERS = {"auth_router.router"}

BLOCK = "막음"
ADVICE = "안내"

JS_BLOCK_PATTERNS = [
    (re.compile(r"\beval\s*\("), "eval(...) — 글자를 코드로 실행합니다. 쓰지 마세요"),
    (re.compile(r"\bnew\s+Function\s*\("), "new Function(...) — 글자를 코드로 실행합니다. 쓰지 마세요"),
    (re.compile(r"\bdocument\.write(?:ln)?\s*\("), "document.write — 쓰지 마세요"),
    (re.compile(r"\bset(?:Timeout|Interval)\s*\(\s*[\"'`]"),
     "setTimeout/setInterval에 글자로 된 코드를 넘겼습니다 — 함수를 넘기세요"),
    (re.compile(r"<[a-zA-Z][^<>]*?\son[a-z]+\s*=", re.I),
     "인라인 이벤트(onclick= 등) — 보안 머리글(CSP)이 막아 동작도 안 합니다. addEventListener를 쓰세요"),
    # 속성(href="javascript:…")과 코드(a.href = 'javascript:…') 둘 다 이 한 줄로 잡힌다
    (re.compile(r"(?:href|src|action)\s*=\s*[\"'`]?\s*javascript:", re.I), "javascript: 주소 — 쓰지 마세요"),
]
INLINE_SCRIPT_RE = re.compile(r"<script(?![^>]*\bsrc\s*=)[^>]*>", re.I)

# 새로 쓴 HTML 조각에서 escapeHtml 없이 들어간 "값"을 찾는다(안내용 — 숫자·고정값일 수도 있다)
TEMPLATE_RE = re.compile(r"`(?:\\.|[^`\\])*`", re.S)
INTERP_RE = re.compile(r"\$\{([^{}]*)\}")
BARE_VALUE_RE = re.compile(r"^\s*[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])*\s*$")
NUMBERISH_RE = re.compile(
    r"(?:^|\.)(?:i|j|k|n|idx|index|count|total|length|size|page|width|height|id|no|seq|"
    r"colspan|rowspan|pct|percent)$|(?:Count|Id|Px|Width|Height|Index|Num|Total|Size)$"
)

WRITE_ROUTE_RE = re.compile(r"@router\.(?:post|put|patch|delete)\s*\(")


class Finding:
    def __init__(self, level: str, path: str, line: int | None, message: str):
        self.level = level
        self.path = path
        self.line = line
        self.message = message

    def text(self) -> str:
        where = f"{self.path}:{self.line}" if self.line else self.path
        return f"[{self.level}] {where} — {self.message}"


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(PROJECT_DIR).as_posix()
    except ValueError:
        return str(path)


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


# ── 1. 비밀값 ────────────────────────────────────────────────────────────────
def load_secrets() -> tuple[list[str], str | None]:
    """app/secret_values.py의 규칙을 그대로 가져온다(백업 기능과 같은 규칙)."""
    sys.path.insert(0, str(BACKEND_DIR))
    try:
        from app.secret_values import secret_values
        return secret_values(), None
    except Exception as exc:  # .env가 없는 PC 등 — 예외 내용엔 값이 섞일 수 있어 종류만 적는다
        return [], f"비밀값 검사를 건너뛰었습니다(.env를 읽지 못함: {type(exc).__name__})"


def check_secret_file(path: Path, secrets: list[str]) -> list[Finding]:
    if not secrets or path.name == ".env" or path.suffix in SKIP_SUFFIXES:
        return []
    try:
        data = path.read_bytes()
    except OSError:
        return []
    if any(v.encode("utf-8") in data for v in secrets):
        return [Finding(BLOCK, rel(path), None,
                        ".env의 비밀값(DB 비밀번호 또는 로그인 서명키)이 이 파일에 그대로 적혀 있습니다. "
                        "값을 지우고 .env에서 읽도록 고치세요(이 파일은 백업 코드 묶음에서도 빠집니다)")]
    return []


def secret_scan_paths() -> list[Path]:
    paths = []
    for name in SECRET_SCAN_DIRS:
        base = PROJECT_DIR / name
        if not base.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            paths += [Path(dirpath) / f for f in filenames]
    paths += [PROJECT_DIR / f for f in SECRET_SCAN_FILES if (PROJECT_DIR / f).exists()]
    return paths


# ── 2. 서버 코드 (bandit) ─────────────────────────────────────────────────────
def run_bandit(targets: list[str], recursive: bool, use_baseline: bool = True) -> tuple[list[dict], str | None]:
    cmd = [sys.executable, "-m", "bandit", "-c", BANDIT_CONFIG, "-f", "json", "-q"]
    if use_baseline and (BACKEND_DIR / BANDIT_BASELINE).exists():
        cmd += ["-b", BANDIT_BASELINE]
    if recursive:
        cmd.append("-r")
    cmd += targets
    proc = subprocess.run(  # nosec B603 — 고정된 명령 목록, 사용자 입력 없음
        cmd, cwd=BACKEND_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if "No module named bandit" in proc.stderr:
        return [], ("검사 도구(bandit)가 설치돼 있지 않아 서버 코드 검사를 건너뛰었습니다. 설치: "
                    "backend> venv\\Scripts\\python.exe -m pip install -r requirements-dev.txt")
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        last = (proc.stderr.strip().splitlines() or ["(출력 없음)"])[-1]
        return [], f"bandit 실행 오류: {last}"
    errors = [f"{e.get('filename')}: {e.get('reason')}" for e in data.get("errors", [])]
    if errors:
        return data.get("results", []), "bandit이 읽지 못한 파일: " + "; ".join(errors)
    return data.get("results", []), None


def bandit_findings(results: list[dict]) -> list[Finding]:
    out = []
    for r in results:
        path = (BACKEND_DIR / r["filename"]).resolve()
        out.append(Finding(
            BLOCK, rel(path), r.get("line_number"),
            f"bandit {r['test_id']}({r['issue_severity']}) {r['issue_text']} — 고치거나, 문제가 아니면 "
            f"그 줄 끝에 `# nosec {r['test_id']} — 이유`를 적으세요",
        ))
    return out


def baseline_count() -> int:
    try:
        data = json.loads((BACKEND_DIR / BANDIT_BASELINE).read_text(encoding="utf-8"))
        return len(data.get("results", []))
    except (OSError, ValueError):
        return 0


# ── 3. 로그인·공통 보안 장치 (main.py) ─────────────────────────────────────────
def dotted(node) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{dotted(node.value)}.{node.attr}"
    return ""


def check_main_py() -> list[Finding]:
    path = rel(MAIN_PY)
    try:
        tree = ast.parse(read_text(MAIN_PY))
    except (OSError, SyntaxError) as exc:
        return [Finding(BLOCK, path, None, f"main.py를 읽지 못했습니다: {type(exc).__name__}")]

    found = []
    middlewares = set()
    secret_key_checked = False
    protected_ok = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(dotted(t) == "protected" for t in node.targets):
            protected_ok = "Depends(current_user)" in ast.unparse(node.value)
        if isinstance(node, ast.Call):
            name = dotted(node.func)
            if name == "app.add_middleware" and node.args:
                middlewares.add(dotted(node.args[0]))
            elif name == "require_secret_key":
                secret_key_checked = True
            elif name == "FastAPI":
                kw = {k.arg: k.value for k in node.keywords}
                for key in ("docs_url", "redoc_url", "openapi_url"):
                    value = kw.get(key)
                    if not (isinstance(value, ast.Constant) and value.value is None):
                        found.append(Finding(BLOCK, path, node.lineno,
                                             f"FastAPI({key}=None)이 빠졌습니다 — 로그인 없이 API 목록이 드러납니다"))
            elif name == "app.include_router" and node.args:
                router = dotted(node.args[0])
                deps = {k.arg: k.value for k in node.keywords}.get("dependencies")
                if router not in PUBLIC_ROUTERS and dotted(deps) != "protected":
                    found.append(Finding(BLOCK, path, node.lineno,
                                         f"{router}가 로그인 검사 없이 붙었습니다 — dependencies=protected를 붙이세요"))
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for deco in node.decorator_list:
                if isinstance(deco, ast.Call) and dotted(deco.func).startswith("app.") and deco.args:
                    route = deco.args[0].value if isinstance(deco.args[0], ast.Constant) else "?"
                    if route not in PUBLIC_MAIN_ROUTES:
                        found.append(Finding(
                            BLOCK, path, deco.lineno,
                            f"main.py에 로그인 검사 없는 주소 {route}를 만들었습니다 — 라우터 파일에 넣고 "
                            "dependencies=protected로 붙이세요(일부러 공개라면 security_check.py의 "
                            "PUBLIC_MAIN_ROUTES에 이유와 함께 적으세요)"))
    for name, label in REQUIRED_MIDDLEWARES.items():
        if name not in middlewares:
            found.append(Finding(BLOCK, path, None, f"공통 보안 장치 {name}({label})가 빠졌습니다"))
    if not secret_key_checked:
        found.append(Finding(BLOCK, path, None, "require_secret_key(서명키 검사)가 빠졌습니다"))
    if not protected_ok:
        found.append(Finding(BLOCK, path, None, "protected = [Depends(current_user)] 가 바뀌었습니다"))
    return found


# ── 4. 엑셀 수식 막기 ─────────────────────────────────────────────────────────
def is_app_python(path: Path) -> bool:
    try:
        parts = path.resolve().relative_to(BACKEND_DIR / "app").parts
    except ValueError:
        return False
    return path.suffix == ".py" and "__pycache__" not in parts


def check_excel(path: Path, text: str) -> list[Finding]:
    if "Workbook(" in text and "neutralize_formulas(" not in text:
        return [Finding(BLOCK, rel(path), line_of(text, text.index("Workbook(")),
                        "엑셀을 만드는데 저장 전에 neutralize_formulas(workbook)를 부르지 않습니다 — "
                        "'='로 시작하는 글자가 수식으로 실행될 수 있습니다(app/utils.py)")]
    return []


# ── 5. 화면 코드 ──────────────────────────────────────────────────────────────
def is_our_frontend(path: Path) -> bool:
    """우리가 만든 화면 파일만 본다 — PDF.js(남이 만든 것) 중에선 우리가 만든 dms-*.js만."""
    try:
        parts = path.resolve().relative_to(FRONTEND_DIR).parts
    except ValueError:
        return False
    if parts[0] == "assets":
        return (len(parts) == 4 and parts[1:3] == ("pdfjs", "web")
                and parts[3].startswith("dms-") and parts[3].endswith(".js"))
    return path.suffix in (".js", ".html")


def check_frontend_code(path: Path, text: str) -> list[Finding]:
    found = []
    for pattern, message in JS_BLOCK_PATTERNS:
        for m in pattern.finditer(text):
            found.append(Finding(BLOCK, rel(path), line_of(text, m.start()), message))
    return found


def check_inline_script(path: Path, text: str) -> list[Finding]:
    if path.suffix != ".html":
        return []
    return [Finding(BLOCK, rel(path), line_of(text, m.start()),
                    "인라인 <script> — 보안 머리글(CSP)이 막아 동작하지 않습니다. 별도 .js 파일로 빼세요")
            for m in INLINE_SCRIPT_RE.finditer(text)]


def unescaped_values(text: str) -> list[str]:
    values = []
    for tpl in TEMPLATE_RE.findall(text):
        if not re.search(r"<[a-zA-Z/]", tpl):
            continue  # HTML 조각이 아니다
        for expr in INTERP_RE.findall(tpl):
            expr = expr.strip()
            if BARE_VALUE_RE.match(expr) and not NUMBERISH_RE.search(expr.replace(" ", "")):
                values.append(expr)
    return list(dict.fromkeys(values))


# ── 실행 ─────────────────────────────────────────────────────────────────────
def new_text_of(tool_input: dict) -> str:
    if "content" in tool_input:  # Write
        return tool_input.get("content") or ""
    if "edits" in tool_input:  # MultiEdit
        return "\n".join(e.get("new_string") or "" for e in tool_input.get("edits") or [])
    return tool_input.get("new_string") or ""  # Edit


def check_one_file(path: Path, new_text: str) -> tuple[list[Finding], list[str]]:
    """훅 — 방금 고친 파일 하나만 본다."""
    findings: list[Finding] = []
    notes: list[str] = []

    secrets, note = load_secrets()
    if note:
        notes.append(note)
    findings += check_secret_file(path, secrets)

    if path.suffix == ".py" and BACKEND_DIR in path.resolve().parents and not (SKIP_DIRS & set(path.parts)):
        results, note = run_bandit([os.path.relpath(path.resolve(), BACKEND_DIR)], recursive=False)
        if note:
            notes.append(note)
        findings += bandit_findings(results)
        if path.resolve() == MAIN_PY:
            findings += check_main_py()
        if is_app_python(path):
            findings += check_excel(path, read_text(path))
            if "routers" in path.resolve().parts and WRITE_ROUTE_RE.search(new_text) \
                    and "require_permission" not in new_text and "require_admin" not in new_text:
                findings.append(Finding(ADVICE, rel(path), None,
                                        "새 저장·수정 API입니다. 권한 관리 화면의 트리(permission_tree.py)에 있는 기능이면 "
                                        "require_permission(...)을 붙였는지 확인하세요(로그인 검사는 main.py가 이미 합니다)"))

    if is_our_frontend(path):
        findings += check_frontend_code(path, new_text)  # 새로 쓴 부분만 — 기존 코드는 전체 검사가 본다
        findings += check_inline_script(path, read_text(path))  # <script> 태그는 짧아 파일 전체로 본다
        values = unescaped_values(new_text)
        if values:
            findings.append(Finding(ADVICE, rel(path), None,
                                    "새로 쓴 HTML 조각에 escapeHtml 없이 들어간 값: " + ", ".join(values[:12]) +
                                    " — 사람이 적은 글자·DB 값이면 escapeHtml(...)로 감싸고, 숫자·고정값이면 그대로 둬도 됩니다"))
    return findings, notes


def hook_main() -> int:
    """Claude Code 훅. 결과는 JSON 한 덩어리(글자는 전부 \\u로 적어 인코딩이 깨질 일이 없다)."""
    try:
        # utf-8-sig: PowerShell로 넘기면 맨 앞에 붙는 BOM 표식을 떼고 읽는다
        data = json.loads(sys.stdin.buffer.read().decode("utf-8-sig", errors="replace") or "{}")
        tool_input = data.get("tool_input") or {}
        file_path = tool_input.get("file_path")
        if not file_path:
            return 0
        path = Path(file_path)
        if PROJECT_DIR not in path.resolve().parents or not path.exists():
            return 0  # 이 프로젝트 밖(메모 등)이거나 지워진 파일
        findings, notes = check_one_file(path, new_text_of(tool_input))
    except Exception as exc:  # 검사 프로그램 자체의 고장이 작업을 막으면 안 된다 — 알리기만 한다
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": f"보안 검사 프로그램 오류(검사 안 됨): {type(exc).__name__}: {exc}",
        }}))
        return 0

    blocks = [f for f in findings if f.level == BLOCK]
    advice = [f.text() for f in findings if f.level == ADVICE] + notes
    if blocks:
        reason = ("보안 검사에서 고쳐야 할 곳이 나왔습니다. 고친 뒤 다시 저장하세요 "
                  "(CLAUDE.md 3-1절 보안 규칙):\n" + "\n".join(f.text() for f in blocks))
        if advice:
            reason += "\n\n참고:\n" + "\n".join(advice)
        print(json.dumps({"decision": "block", "reason": reason,
                          "systemMessage": f"보안 검사: 고칠 곳 {len(blocks)}건 — Claude가 고치도록 돌려보냈습니다"}))
    elif advice:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": "보안 검사 안내(막지는 않음):\n" + "\n".join(advice),
        }}))
    return 0


def full_main() -> int:
    """사람이 직접 돌리는 전체 검사."""
    sys.stdout.reconfigure(errors="replace")
    print(f"TDMS 보안 검사 — {datetime.now():%Y-%m-%d %H:%M}")
    print("=" * 70)
    problems: list[Finding] = []
    notes: list[str] = []

    secrets, note = load_secrets()
    paths = secret_scan_paths()
    found = [f for p in paths for f in check_secret_file(p, secrets)]
    problems += found
    print(f"[1] 비밀값            {len(found)}건  (검사한 파일 {len(paths):,}개)" + (f"  ※ {note}" if note else ""))

    results, note = run_bandit(list(BANDIT_TARGETS), recursive=True)
    found = bandit_findings(results)
    problems += found
    print(f"[2] 서버 코드(bandit)  새 경고 {len(found)}건  (기준표에 정리해 둔 기존 경고 {baseline_count()}건은 제외)"
          + (f"  ※ {note}" if note else ""))
    if note:
        notes.append(note)

    found = check_main_py()
    problems += found
    print(f"[3] 로그인·보안 장치   {len(found)}건  (app/main.py)")

    app_files = [p for p in (BACKEND_DIR / "app").rglob("*.py") if is_app_python(p)]
    excel_files = [p for p in app_files if "Workbook(" in read_text(p)]
    found = [f for p in excel_files for f in check_excel(p, read_text(p))]
    problems += found
    print(f"[4] 엑셀 수식 막기     {len(found)}건  (엑셀을 만드는 파일 {len(excel_files)}개)")

    fe_files = [p for p in FRONTEND_DIR.rglob("*") if p.is_file() and is_our_frontend(p)]
    found = [f for p in fe_files for t in [read_text(p)]
             for f in check_frontend_code(p, t) + check_inline_script(p, t)]
    problems += found
    print(f"[5] 화면 코드          {len(found)}건  (우리가 만든 화면 파일 {len(fe_files)}개)")

    print("=" * 70)
    if problems:
        print(f"결과: 고칠 곳 {len(problems)}건")
        for f in problems:
            print("  " + f.text())
        return 1
    if notes:
        print("결과: 문제는 없지만 검사하지 못한 부분이 있습니다 — 위 ※ 표시를 확인하세요")
        return 1
    print("결과: 문제 없음")
    return 0


def update_baseline() -> int:
    """기준표를 지금 상태로 다시 만든다 — 남은 경고를 전부 "문제 아님"으로 확정하는 일이다."""
    results, note = run_bandit(list(BANDIT_TARGETS), recursive=True, use_baseline=False)
    if note:
        print(note)
        return 1
    cmd = [sys.executable, "-m", "bandit", "-c", BANDIT_CONFIG, "-f", "json", "-q",
           "-o", BANDIT_BASELINE, "-r", *BANDIT_TARGETS]
    subprocess.run(cmd, cwd=BACKEND_DIR, capture_output=True)  # nosec B603 — 고정된 명령 목록
    print(f"기준표를 새로 만들었습니다: 경고 {len(results)}건을 '문제 아님'으로 확정 ({BANDIT_BASELINE})")
    print("그 이유를 CLAUDE.md 3-1절 '예외로 둔 기존 경고'에 적어 두세요.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="TDMS 보안 자동 검사")
    parser.add_argument("--hook", action="store_true", help="Claude Code 훅으로 실행(표준입력으로 고친 파일을 받는다)")
    parser.add_argument("--update-baseline", action="store_true", help="bandit 기준표를 지금 상태로 다시 만든다")
    args = parser.parse_args()
    if args.hook:
        return hook_main()
    if args.update_baseline:
        return update_baseline()
    return full_main()


if __name__ == "__main__":
    sys.exit(main())
