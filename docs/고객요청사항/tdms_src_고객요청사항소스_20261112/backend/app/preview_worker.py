"""원본 한 개를 미리보기용 PDF로 바꾸는 작업기 (D-102).

서버 프로그램 안에서 바로 바꾸지 않고 이 파일을 **따로 실행**한다(original_preview.py가 부른다).
변환 도구가 가끔 멈추는데, 따로 실행해 두면 정해진 시간이 지났을 때 통째로 끝낼 수 있어서
서버 전체가 붙잡히지 않는다.

    python -m app.preview_worker <dwg|office> <원본 경로> <만들 PDF 경로> <엔진> <도구 경로> <제한 초>

성공하면 0으로 끝나고, 실패하면 사용자에게 보여줄 한 줄 설명을 stderr 마지막 줄에 남기고 2로 끝난다.
DB·설정 파일은 읽지 않는다 — 필요한 값은 전부 위 인자로 받는다.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


class ConvertError(Exception):
    """사용자에게 그대로 보여줄 설명을 담는다."""


# ---------------------------------------------------------------------------
# DWG → PDF : ODA File Converter(DWG→DXF) + ezdxf(그리기) + PyMuPDF(PDF 만들기)
# ---------------------------------------------------------------------------
# CAD 한글 글꼴(whgtxt.shx·ghs.shx 등)과 Arial에 든 한글은 ezdxf가 그리지 못해 네모(□)가 된다.
# AutoCAD는 이런 글자를 알아서 한글 글꼴로 바꿔 그리므로, 한글이 든 글자만 맑은 고딕으로 그린다.
HANGUL = re.compile(r"[ㄱ-ㆎ가-힣]")
KOREAN_STYLE = "DMS_KO"
KOREAN_FONT = "malgun.ttf"
PAGE_LONG_SIDE_MM = 841  # A1 긴 변 — 뷰어에서 확대해 보기에 충분한 크기


def use_korean_font_for_hangul(doc) -> None:
    if KOREAN_STYLE not in doc.styles:
        doc.styles.new(KOREAN_STYLE, dxfattribs={"font": KOREAN_FONT})
    for block in doc.blocks:
        for entity in block:
            targets = [entity]
            if entity.dxftype() == "INSERT":
                targets += list(entity.attribs)
            for t in targets:
                kind = t.dxftype()
                if kind in ("TEXT", "ATTRIB", "ATTDEF"):
                    text = t.dxf.text
                elif kind == "MTEXT":
                    text = t.text
                else:
                    continue
                if text and HANGUL.search(text):
                    t.dxf.style = KOREAN_STYLE


def convert_dwg(src: Path, out: Path, oda_path: str) -> None:
    import ezdxf
    import ezdxf.bbox
    from ezdxf.addons import odafc
    from ezdxf.addons.drawing import Frontend, RenderContext, layout
    from ezdxf.addons.drawing.config import BackgroundPolicy, ColorPolicy, Configuration
    from ezdxf.addons.drawing.pymupdf import PyMuPdfBackend

    if not oda_path or not Path(oda_path).is_file():
        raise ConvertError("DWG 변환 도구(ODA File Converter)가 설치되어 있지 않습니다.")
    ezdxf.options.set("odafc-addon", "win_exec_path", oda_path)

    try:
        doc = odafc.readfile(str(src))
    except Exception as exc:  # 변환기가 못 읽는 DWG(손상·너무 새 버전 등)
        raise ConvertError("DWG 파일을 읽을 수 없습니다.") from exc

    use_korean_font_for_hangul(doc)
    msp = doc.modelspace()
    ext = ezdxf.bbox.extents(msp, fast=True)
    if not ext.has_data:
        raise ConvertError("DWG의 모형(Model) 공간에 그려진 것이 없습니다.")
    w, h = ext.size.x or 1, ext.size.y or 1
    if w >= h:
        pw, ph = PAGE_LONG_SIDE_MM, PAGE_LONG_SIDE_MM * h / w
    else:
        pw, ph = PAGE_LONG_SIDE_MM * w / h, PAGE_LONG_SIDE_MM

    backend = PyMuPdfBackend()
    config = Configuration(background_policy=BackgroundPolicy.BLACK, color_policy=ColorPolicy.COLOR)
    Frontend(RenderContext(doc), backend, config=config).draw_layout(msp, finalize=True)
    page = layout.Page(pw, ph, layout.Units.mm, margins=layout.Margins.all(5))
    out.write_bytes(backend.get_pdf_bytes(page, settings=layout.Settings(fit_page=True)))


# ---------------------------------------------------------------------------
# 오피스 → PDF
# ---------------------------------------------------------------------------
# 윈도우에 기본으로 들어 있는 프로그램 — 이름만 주지 않고 전체 경로로 부른다(2026-10-01 CM 승인, D-111).
# 이름만 주면 윈도우는 System32보다 먼저 "파이썬이 있는 폴더"와 "지금 작업 폴더"를 찾아보므로,
# 그 자리에 같은 이름의 가짜 프로그램이 놓이면 그것이 대신 실행된다. 전체 경로면 그럴 일이 없다.
SYSTEM_TOOLS = {
    "taskkill": r"System32\taskkill.exe",
    "powershell": r"System32\WindowsPowerShell\v1.0\powershell.exe",
}


def system_exe(name: str) -> str:
    """윈도우 기본 프로그램의 전체 경로(예: C:\\Windows\\System32\\taskkill.exe)."""
    windows_dir = os.environ.get("SystemRoot") or r"C:\Windows"
    return str(Path(windows_dir) / SYSTEM_TOOLS[name])


def kill_tree(proc: subprocess.Popen) -> None:
    """그 프로그램과 그것이 띄운 자식 프로그램까지 통째로 끝낸다."""
    subprocess.run([system_exe("taskkill"), "/T", "/F", "/PID", str(proc.pid)], capture_output=True)


def convert_with_libreoffice(src: Path, out: Path, soffice: str, timeout: int) -> None:
    if not soffice or not Path(soffice).is_file():
        raise ConvertError("오피스 변환 도구(LibreOffice)가 설치되어 있지 않습니다.")
    # 주의: -env:UserInstallation으로 설정 폴더를 따로 주면 LibreOffice가 설정 폴더도 만들지
    # 못한 채 멈춘다(2026-09-19 로컬·서버에서 확인). 그래서 기본 설정 폴더를 그대로 쓴다.
    outdir = src.parent
    proc = subprocess.Popen(
        [soffice, "--headless", "--nologo", "--nodefault", "--nolockcheck", "--norestore",
         "--convert-to", "pdf", "--outdir", str(outdir), str(src)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        raise ConvertError("변환 시간이 너무 오래 걸려 멈췄습니다.")
    made = outdir / (src.stem + ".pdf")
    if not made.is_file():
        raise ConvertError("오피스 파일을 PDF로 바꾸지 못했습니다.")
    shutil.move(str(made), str(out))


EXCEL_EXTS = {"xls", "xlsx", "xlsm", "xlsb"}

# 로컬 시험용 — 설치된 MS 엑셀을 뒤에서 실행해 PDF로 내보낸다. 엑셀은 COM(자동 실행)으로 켜져
# 이 작업기의 자식 프로세스가 아니므로, 시간이 넘으면 자동 실행으로 켜진 엑셀만 골라 끈다
# (사람이 열어 둔 엑셀은 명령줄에 -Embedding이 없어 건드리지 않는다).
EXCEL_SCRIPT = """
$ErrorActionPreference = 'Stop'
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.AskToUpdateLinks = $false
try {{
  $wb = $xl.Workbooks.Open({src}, 0, $true)
  $wb.ExportAsFixedFormat(0, {out})
  $wb.Close($false)
}} finally {{
  $xl.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}}
"""

KILL_AUTOMATION_EXCEL = """
Get-CimInstance Win32_Process -Filter "Name='EXCEL.EXE'" |
  Where-Object {{ $_.CommandLine -like '*-Embedding*' -and $_.CreationDate -ge [datetime]{started} }} |
  ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}
"""


def ps_quote(value: str) -> str:
    """PowerShell 작은따옴표 문자열 — 안의 작은따옴표는 두 번 적는다."""
    return "'" + value.replace("'", "''") + "'"


def convert_with_msoffice(src: Path, out: Path, ext: str, timeout: int) -> None:
    if ext not in EXCEL_EXTS:
        raise ConvertError("이 컴퓨터에서는 워드·PPT 원본 미리보기를 만들 수 없습니다.")
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    script = EXCEL_SCRIPT.format(src=ps_quote(str(src)), out=ps_quote(str(out)))
    proc = subprocess.Popen(
        [system_exe("powershell"), "-NoProfile", "-NonInteractive", "-Command", script],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        kill = KILL_AUTOMATION_EXCEL.format(started=ps_quote(started))
        subprocess.run([system_exe("powershell"), "-NoProfile", "-Command", kill], capture_output=True)
        raise ConvertError("변환 시간이 너무 오래 걸려 멈췄습니다.")
    if not out.is_file():
        raise ConvertError("엑셀 파일을 PDF로 바꾸지 못했습니다.")


def is_real_pdf(path: Path) -> bool:
    """만들어진 파일이 정말 PDF인지. 회사 PC의 문서보안 프로그램은 엑셀이 만든 PDF를 몰래 암호화해
    버리는 경우가 있다(앞부분이 %PDF가 아니라 SCDSA002 — 2026-09-19 로컬에서 확인). 그런 파일을
    저장해 두면 뷰어가 "손상된 PDF"만 보여주므로, 저장하기 전에 걸러낸다."""
    try:
        with path.open("rb") as f:
            return f.read(5) == b"%PDF-"
    except OSError:
        return False


def convert(kind: str, src: Path, out: Path, engine: str, tool: str, timeout: int) -> None:
    ext = src.suffix.lstrip(".").lower()
    out.parent.mkdir(parents=True, exist_ok=True)
    if kind == "office" and engine == "msoffice":
        # MS 엑셀은 원본에서 결과 자리로 바로 내보낸다. 임시 폴더를 거치면 회사 문서보안
        # 프로그램이 결과 PDF를 암호화했다(2026-09-19 로컬 — 이 방식은 서버에서 쓰지 않는다).
        convert_with_msoffice(src, out, ext, timeout)
    else:
        # 원본을 임시 폴더에 영문 이름으로 복사해서 바꾼다 — 변환 도구가 한글·공백·특수문자가 든
        # 긴 경로에서 가끔 실패하고, 저장소의 원본 파일을 잠가 버리는 일도 막기 위함이다.
        with tempfile.TemporaryDirectory(prefix="dms_preview_") as tmp:
            work_src = Path(tmp) / f"source.{ext}"
            shutil.copyfile(src, work_src)
            work_out = Path(tmp) / "result.pdf"
            if kind == "dwg":
                convert_dwg(work_src, work_out, tool)
            else:
                convert_with_libreoffice(work_src, work_out, tool, timeout)
            shutil.move(str(work_out), str(out))
    if not is_real_pdf(out):
        out.unlink(missing_ok=True)
        raise ConvertError("만들어진 미리보기 파일이 올바른 PDF가 아닙니다(문서보안 프로그램이 암호화했을 수 있습니다).")


def main(argv: list[str]) -> int:
    kind, src, out, engine, tool, timeout = argv[1], Path(argv[2]), Path(argv[3]), argv[4], argv[5], int(argv[6])
    try:
        convert(kind, src, out, engine, tool, timeout)
    except ConvertError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:  # 예상 못 한 오류도 화면에는 한 줄 설명으로만
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        print("미리보기를 만드는 중 오류가 났습니다.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
