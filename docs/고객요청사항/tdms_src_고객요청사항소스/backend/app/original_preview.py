"""원본(DWG·엑셀·워드·PPT) 미리보기 — 원본을 PDF로 바꿔 두고 지금 뷰어로 보여준다 (D-102).

바꾸는 일은 preview_worker.py를 따로 실행해서 한다. 여기서는
  · 어떤 파일을 바꿀 수 있는지 판단하고
  · 바꾼 결과를 storage/미리보기변환/ 에 원본 내용(sha256) 이름으로 저장해 두었다가
    다음부터는 바로 돌려주고
  · 한 번에 하나씩만 바꾸게 줄을 세운다(서버가 CPU 2개짜리라 동시에 여럿을 바꾸면 전체가 느려진다).
"""

import glob
import hashlib
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from app.config import (
    PREVIEW_ODA_PATH,
    PREVIEW_OFFICE_ENGINE,
    PREVIEW_SOFFICE_PATH,
    PREVIEW_TIMEOUT_SECONDS,
)
from app.preview_worker import kill_tree
from app.storage import preview_cache_dir

# 확장자 → 변환 방식. 한글(HWP)은 대상이 아니다(CM 확정).
CONVERTIBLE = {
    "dwg": "dwg",
    "xls": "office", "xlsx": "office", "xlsm": "office", "xlsb": "office",
    "doc": "office", "docx": "office",
    "ppt": "office", "pptx": "office",
}

# 변환 방식을 고치면(글꼴·배경 등) 이 숫자를 올린다 — 예전에 만들어 둔 결과를 쓰지 않고 새로 만든다.
CONVERTER_VERSION = 1

# 실패한 파일은 이 시간 동안 다시 시도하지 않는다 — 몇 분씩 걸려 실패하는 파일을 누가 열 때마다
# 다시 돌리면 그동안 다른 사람의 미리보기까지 줄 서서 기다리게 된다.
FAILURE_RETRY_SECONDS = 24 * 60 * 60

_convert_lock = threading.Lock()


class PreviewError(Exception):
    """사용자에게 그대로 보여줄 설명을 담는다."""


def preview_kind(ext: Optional[str]) -> Optional[str]:
    return CONVERTIBLE.get((ext or "").lower())


def oda_converter_path() -> str:
    if PREVIEW_ODA_PATH:
        return PREVIEW_ODA_PATH
    found = sorted(glob.glob(r"C:\Program Files\ODA\ODAFileConverter*\ODAFileConverter.exe"))
    return found[-1] if found else ""


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def cache_paths(sha256: str) -> tuple[Path, Path]:
    base = preview_cache_dir() / f"{sha256}_v{CONVERTER_VERSION}"
    return base.with_suffix(".pdf"), base.with_suffix(".fail.txt")


def unsupported_here_reason(ext: str) -> Optional[str]:
    """이 컴퓨터의 설정으로는 아예 못 바꾸는 경우 — 시도해 보지도 않고 바로 안내한다."""
    kind = preview_kind(ext)
    if kind is None:
        return "이 형식은 미리보기를 지원하지 않습니다."
    if kind == "office" and PREVIEW_OFFICE_ENGINE == "msoffice" and ext.lower() not in ("xls", "xlsx", "xlsm", "xlsb"):
        return "이 컴퓨터에서는 워드·PPT 원본 미리보기를 만들 수 없습니다."
    return None


def ensure_preview(src: Path, ext: str, sha256: Optional[str]) -> Path:
    """원본의 미리보기 PDF 경로를 돌려준다. 없으면 만든다. 못 만들면 PreviewError."""
    reason = unsupported_here_reason(ext)
    if reason:
        raise PreviewError(reason)
    if not src.is_file():
        raise PreviewError("원본 파일이 저장소에 없습니다.")

    pdf, fail = cache_paths(sha256 or file_sha256(src))
    if pdf.is_file():
        return pdf
    recent_failure(fail)

    with _convert_lock:
        # 줄 서 있는 동안 다른 요청이 같은 파일을 이미 바꿨을 수 있다.
        if pdf.is_file():
            return pdf
        recent_failure(fail)
        run_worker(src, ext, pdf, fail)
    return pdf


def recent_failure(fail: Path) -> None:
    if fail.is_file() and time.time() - fail.stat().st_mtime < FAILURE_RETRY_SECONDS:
        raise PreviewError(fail.read_text(encoding="utf-8").strip() or "미리보기를 만들 수 없습니다.")


def run_worker(src: Path, ext: str, pdf: Path, fail: Path) -> None:
    kind = preview_kind(ext)
    tool = oda_converter_path() if kind == "dwg" else PREVIEW_SOFFICE_PATH
    tmp = pdf.with_suffix(".tmp.pdf")
    backend_dir = Path(__file__).resolve().parents[1]
    cmd = [sys.executable, "-m", "app.preview_worker", kind, str(src), str(tmp),
           PREVIEW_OFFICE_ENGINE, tool, str(PREVIEW_TIMEOUT_SECONDS)]
    # 작업기가 남기는 한글 안내문이 윈도우 기본 인코딩(cp949)으로 나와 깨지지 않게 UTF-8로 받는다.
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    proc = subprocess.Popen(cmd, cwd=backend_dir, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        # 작업기 안에서도 같은 제한으로 끊지만, 작업기 자체가 멈추는 경우를 대비해 조금 더 기다린다.
        _, err = proc.communicate(timeout=PREVIEW_TIMEOUT_SECONDS + 30)
    except subprocess.TimeoutExpired:
        kill_tree(proc)  # 작업기와 그것이 띄운 변환 도구까지 통째로 끝낸다
        record_failure(fail, "변환 시간이 너무 오래 걸려 멈췄습니다.")
        tmp.unlink(missing_ok=True)
        raise PreviewError("변환 시간이 너무 오래 걸려 멈췄습니다.")

    if proc.returncode == 0 and tmp.is_file():
        tmp.replace(pdf)
        return

    tmp.unlink(missing_ok=True)
    lines = [ln.strip() for ln in err.decode("utf-8", "replace").splitlines() if ln.strip()]
    message = lines[-1] if proc.returncode == 2 and lines else "미리보기를 만들 수 없습니다."
    record_failure(fail, message)
    raise PreviewError(message)


def record_failure(fail: Path, message: str) -> None:
    fail.parent.mkdir(parents=True, exist_ok=True)
    fail.write_text(message, encoding="utf-8")
