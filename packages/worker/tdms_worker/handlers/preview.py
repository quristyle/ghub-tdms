"""원본(DWG·DXF) 미리보기 — 도면을 PDF 로 바꿔 두면 화면이 지금의 PDF 뷰어로 연다.

고객 시스템(docs/고객요청사항 … backend/app/preview_worker.py, D-102)과 같은 방식이다.
  DWG → DXF : LibreDWG dwg2dxf (이미지에 구워 둔다).
              PREVIEW_ODA_PATH 가 있으면 ODA File Converter 를 대신 쓴다 — 재배포가 막혀
              이미지에는 넣지 못하므로 호스트에서 붙였을 때만.
  DXF → PDF : ezdxf(그리기) + PyMuPDF(PDF 만들기)

결과 PDF 는 blob 으로 넣고 preview_renditions 에 (원본 sha256, 변환기 버전) → PDF sha256 을
적는다. 같은 내용의 원본은 다시 바꾸지 않는다.

payload: {"sourceSha": "<hex>", "ext": "dwg"|"dxf"}
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import psycopg

from .. import blob
from ..config import Config

# 변환 방식을 고치면(글꼴·배경 등) 올린다 — API 쪽 RENDITION_VERSION 과 같아야 한다.
CONVERTER_VERSION = 1

# CAD 한글 글꼴(whgtxt.shx·ghs.shx 등)과 Arial 에 든 한글은 ezdxf 가 그리지 못해 네모(□)가 된다.
# AutoCAD 는 이런 글자를 알아서 한글 글꼴로 바꿔 그리므로, 한글이 든 글자만 나눔고딕으로 그린다
# (고객 시스템은 윈도우라 맑은 고딕 — 여기는 리눅스라 fonts-nanum).
HANGUL = re.compile(r"[ㄱ-ㆎ가-힣]")
KOREAN_STYLE = "TDMS_KO"
KOREAN_FONT = "NanumGothic.ttf"
PAGE_LONG_SIDE_MM = 841  # A1 긴 변 — 뷰어에서 확대해 보기에 충분한 크기


class ConvertError(Exception):
    """사용자에게 그대로 보여줄 설명을 담는다. 다시 해도 같으므로 재시도하지 않는다."""


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


def dwg_to_dxf(src: Path, work: Path, cfg: Config):
    """DWG 를 ezdxf 문서로 읽는다."""
    import ezdxf
    from ezdxf import recover

    if cfg.oda and Path(cfg.oda).is_file():
        from ezdxf.addons import odafc

        ezdxf.options.set("odafc-addon", "unix_exec_path", cfg.oda)
        try:
            return odafc.readfile(str(src))
        except Exception as exc:  # 변환기가 못 읽는 DWG(손상·너무 새 버전 등)
            raise ConvertError("DWG 파일을 읽을 수 없습니다.") from exc

    dwg2dxf = shutil.which(cfg.dwg2dxf) or cfg.dwg2dxf
    if not Path(dwg2dxf).is_file():
        raise ConvertError("DWG 변환 도구(LibreDWG)가 설치되어 있지 않습니다.")
    out = work / "source.dxf"
    try:
        # -y: 덮어쓰기. 판(--as)은 원본 그대로 둔다 — --as r2000 으로 낮추면 모형 공간이 비어 나왔다
        # (2026-11-05 자료 2002 의 DWG 로 확인).
        subprocess.run(
            [dwg2dxf, "-y", "-o", str(out), str(src)],
            check=False, capture_output=True, timeout=cfg.convert_timeout, cwd=work,
        )
    except subprocess.TimeoutExpired as exc:
        raise ConvertError("변환 시간이 너무 오래 걸려 멈췄습니다.") from exc
    # dwg2dxf 는 경고만 있어도 0 이 아닌 값으로 끝나는 일이 있다 — 결과 파일로 판단한다
    if not out.is_file() or out.stat().st_size == 0:
        raise ConvertError("DWG 파일을 읽을 수 없습니다(손상되었거나 지원하지 않는 판).")
    drop_objects(out, LIBREDWG_BROKEN_OBJECTS)
    try:
        doc, _auditor = recover.readfile(str(out))
    except Exception as exc:
        raise ConvertError("DWG 에서 바꾼 도면을 읽을 수 없습니다.") from exc
    fix_layer_states(doc, dwg_layer_states(Path(dwg2dxf).with_name("dwglayers"), src, cfg))
    return doc


def dwg_layer_states(dwglayers: Path, src: Path, cfg: Config) -> dict[str, tuple[bool, bool]]:
    """원본 DWG 가 적어 둔 층(layer)별 (켜짐, 얼림). 못 읽으면 빈 dict.

    LibreDWG 0.13 은 DXF 를 쓸 때 층 색을 음수(= 꺼짐)로 잘못 적는다 — 자료 2002 의 DWG 는
    dwglayers 로는 전부 켜짐인데 DXF 에서는 Defpoints 말고 전부 꺼짐이라 도면이 거의 비어
    그려졌다(2026-11-05 확인). 그래서 켜짐·얼림은 DWG 를 직접 읽는 dwglayers 에서 받는다.
    출력 한 줄: "<f| ><+|-><l| >\t<층 이름>"
    """
    if not dwglayers.is_file():
        return {}
    try:
        proc = subprocess.run([str(dwglayers), "-f", str(src)], check=False,
                              capture_output=True, timeout=cfg.convert_timeout)
    except subprocess.TimeoutExpired:
        return {}
    states: dict[str, tuple[bool, bool]] = {}
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        flags, sep, name = line.partition("\t")
        if sep and len(flags) == 3:
            states[name.strip().lower()] = (flags[1] == "+", flags[0] == "f")
    return states


def fix_layer_states(doc, states: dict[str, tuple[bool, bool]]) -> None:
    for layer in doc.layers:
        state = states.get(layer.dxf.name.lower())
        if state is None:
            continue
        on, frozen = state
        if on:
            layer.on()
        else:
            layer.off()
        if frozen:
            layer.freeze()
        else:
            layer.thaw()


# LibreDWG 0.13 이 DXF 로 쓸 때 짜임을 틀리게 내는 개체 — ezdxf 가 읽다가 멈춘다
# (SORTENTSTABLE: "Invalid sort handle code 331", 2026-11-05 자료 2002 로 확인).
# 그리기 순서만 정하는 표라 빼도 도면 내용은 그대로다.
LIBREDWG_BROKEN_OBJECTS = frozenset({b"SORTENTSTABLE"})


def drop_objects(path: Path, kinds: frozenset[bytes]) -> None:
    """DXF 에서 그 종류의 개체를 통째로 뺀다. DXF 는 (그룹 코드 줄, 값 줄) 의 반복이고
    개체는 코드 0 에서 시작해 다음 코드 0 앞에서 끝난다. 글자 인코딩은 건드리지 않게 바이트로 다룬다."""
    lines = path.read_bytes().splitlines(keepends=True)
    out: list[bytes] = []
    skipping = False
    for i in range(0, len(lines) - 1, 2):
        code, value = lines[i], lines[i + 1]
        if code.strip() == b"0":
            skipping = value.strip() in kinds
        if not skipping:
            out += (code, value)
    if len(lines) % 2:
        out.append(lines[-1])
    path.write_bytes(b"".join(out))


def render_pdf(doc, out: Path) -> None:
    import ezdxf.bbox
    from ezdxf.addons.drawing import Frontend, RenderContext, layout
    from ezdxf.addons.drawing.config import BackgroundPolicy, ColorPolicy, Configuration
    from ezdxf.addons.drawing.pymupdf import PyMuPdfBackend

    use_korean_font_for_hangul(doc)
    msp = doc.modelspace()
    ext = ezdxf.bbox.extents(msp, fast=True)
    if not ext.has_data:
        raise ConvertError("도면의 모형(Model) 공간에 그려진 것이 없습니다.")
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


def convert(src: Path, ext: str, out: Path, cfg: Config) -> None:
    from ezdxf import recover

    # 원본을 임시 폴더에 영문 이름으로 복사해서 바꾼다 — 변환 도구가 원본을 잠그거나
    # 옆에 찌꺼기를 남기지 않게.
    cfg.tmp.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="preview-", dir=cfg.tmp) as tmp:
        work = Path(tmp)
        work_src = work / f"source.{ext}"
        shutil.copyfile(src, work_src)
        if ext == "dwg":
            doc = dwg_to_dxf(work_src, work, cfg)
        else:
            try:
                doc, _auditor = recover.readfile(str(work_src))
            except Exception as exc:
                raise ConvertError("DXF 파일을 읽을 수 없습니다.") from exc
        render_pdf(doc, out)


def _record(conn: psycopg.Connection, source: str, state: str, *,
            pdf: tuple[str, int] | None = None, error: str | None = None) -> None:
    with conn.cursor() as cur:
        if pdf:
            cur.execute(
                "INSERT INTO blobs (sha256, byte_size) VALUES (decode(%s,'hex'), %s)"
                " ON CONFLICT (sha256) DO NOTHING",
                pdf,
            )
        cur.execute(
            """INSERT INTO preview_renditions (source_sha256, converter_version, state, pdf_sha256, error)
               VALUES (decode(%s,'hex'), %s, %s, decode(%s,'hex'), %s)
               ON CONFLICT (source_sha256, converter_version) DO UPDATE
                  SET state = EXCLUDED.state, pdf_sha256 = EXCLUDED.pdf_sha256,
                      error = EXCLUDED.error, updated_at = now()""",
            (source, CONVERTER_VERSION, state, pdf[0] if pdf else None, error),
        )
        if pdf:
            # 미리보기가 쥐고 있는 동안 야간 GC 가 PDF 를 거두지 않게
            cur.execute(
                "UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = decode(%s,'hex')",
                (pdf[0],),
            )
    conn.commit()


def run(conn: psycopg.Connection, cfg: Config, payload: dict[str, Any],
        progress: Callable[..., None]) -> dict[str, Any]:
    source = str(payload["sourceSha"]).lower()
    ext = str(payload.get("ext") or "dwg").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", source) or ext not in ("dwg", "dxf"):
        raise ValueError(f"잘못된 미리보기 요청: {payload}")

    src = blob.blob_path(cfg.blobs, source)
    progress(5, "도면을 읽는 중")
    cfg.tmp.mkdir(parents=True, exist_ok=True)
    out = cfg.tmp / f"preview-{source}-{os.getpid()}.pdf"
    try:
        if not src.is_file():
            raise ConvertError("원본 파일이 저장소에 없습니다.")
        convert(src, ext, out, cfg)
        progress(90, "저장소에 넣는 중")
        pdf = blob.store_file(cfg.blobs, out)
    except ConvertError as exc:
        out.unlink(missing_ok=True)
        _record(conn, source, "failed", error=str(exc))
        # 작업 자체는 끝난 것으로 둔다 — 같은 파일은 다시 해도 같은 결과다
        return {"state": "failed", "error": str(exc)}
    except Exception:
        out.unlink(missing_ok=True)
        # 예상 못 한 실패 — 화면이 '변환 중' 에서 멈춰 있지 않게 실패로 적어 두고 재시도에 맡긴다
        conn.rollback()
        _record(conn, source, "failed", error="미리보기를 만드는 중 오류가 났습니다.")
        raise

    _record(conn, source, "done", pdf=pdf)
    progress(100, "미리보기 완료")
    return {"state": "done", "pdfSha256": pdf[0], "byteSize": pdf[1]}
