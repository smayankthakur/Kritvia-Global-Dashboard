"""Text extraction for ingestion: plain text, HTML, PDF, DOCX, CSV and images.

PDFs with a text layer are read directly (pypdf). Scanned PDFs and images go to
OCR. OCR runs locally on the VM — never a hosted API — because loan documents
and IDs pass through here. Engines, in order of preference:

  PaddleOCR   better on Indian IDs and financial documents (install in the
              worker image with the `ocr` extra; ARM wheels permitting)
  Tesseract   apt `tesseract-ocr tesseract-ocr-hin` + pytesseract
"""
from __future__ import annotations

import csv
import html
import io
import re
import zipfile
from dataclasses import dataclass

_TAGS = re.compile(r"<(script|style)[^>]*>.*?</\1>|<[^>]+>", re.S | re.I)
_WS = re.compile(r"[ \t\r\f\v]+")


class ExtractionError(Exception):
    pass


@dataclass
class Extracted:
    text: str
    method: str          # text | html | pdf | pdf+ocr | docx | csv | ocr
    pages: int = 1


def html_to_text(raw: str) -> str:
    raw = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</tr>", "\n", raw, flags=re.I)
    text = html.unescape(_TAGS.sub(" ", raw))
    return "\n".join(_WS.sub(" ", line).strip() for line in text.splitlines() if line.strip())


def ocr_image(data: bytes) -> str:
    try:
        from paddleocr import PaddleOCR  # type: ignore

        import numpy as np  # type: ignore
        from PIL import Image  # type: ignore

        engine = _paddle_engine(PaddleOCR)
        img = np.array(Image.open(io.BytesIO(data)).convert("RGB"))
        result = engine.ocr(img)
        lines = [line[1][0] for block in result or [] for line in block or []]
        return "\n".join(lines)
    except ImportError:
        pass
    try:
        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore
    except ImportError as exc:
        raise ExtractionError("no OCR engine installed (PaddleOCR or Tesseract)") from exc
    return pytesseract.image_to_string(Image.open(io.BytesIO(data)), lang="eng+hin")


_paddle = None


def _paddle_engine(cls):
    global _paddle
    if _paddle is None:
        _paddle = cls(use_angle_cls=True, lang="en", show_log=False)
    return _paddle


MAX_PDF_PAGES = 300          # a business document; more is almost certainly an attack or a mistake
MAX_OCR_PAGES = 60
MAX_DOCX_XML = 50 * 1024 * 1024
MAX_DOCX_RATIO = 200         # a real document.xml compresses ~5-20x; zip bombs reach thousands


def _pdf(data: bytes) -> Extracted:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover
        raise ExtractionError("pypdf not installed") from exc
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            reader.decrypt("")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise ExtractionError(f"PDF has more than {MAX_PDF_PAGES} pages")
        pages = [(p.extract_text() or "") for p in reader.pages]
    except ExtractionError:
        raise
    except Exception as exc:
        raise ExtractionError(f"unreadable PDF: {type(exc).__name__}") from exc
    text = "\n\n".join(pages).strip()
    if len(text) >= 40 * max(1, len(pages)) // 4:
        return Extracted(text, "pdf", len(pages))
    # Scanned: rasterise and OCR (needs pypdfium2 in the worker image)
    try:
        import pypdfium2 as pdfium  # type: ignore
    except ImportError as exc:
        if text:
            return Extracted(text, "pdf", len(pages))
        raise ExtractionError("scanned PDF and no rasteriser (pypdfium2) installed for OCR") from exc
    doc = pdfium.PdfDocument(data)
    out = []
    for i in range(min(len(doc), MAX_OCR_PAGES)):
        buf = io.BytesIO()
        doc[i].render(scale=2).to_pil().save(buf, format="PNG")
        out.append(ocr_image(buf.getvalue()))
    return Extracted("\n\n".join(out).strip(), "pdf+ocr", len(doc))


def _docx(data: bytes) -> Extracted:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            info = z.getinfo("word/document.xml")
            if info.file_size > MAX_DOCX_XML or info.file_size > MAX_DOCX_RATIO * max(info.compress_size, 1):
                raise ExtractionError("DOCX is too large once unpacked")
            xml = z.read(info).decode("utf-8", "replace")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ExtractionError("unreadable DOCX") from exc
    xml = re.sub(r"</w:p>", "\n", xml)
    return Extracted(html.unescape(re.sub(r"<[^>]+>", "", xml)).strip(), "docx")


def _csv(data: bytes) -> Extracted:
    text = data.decode("utf-8-sig", "replace")
    rows = list(csv.reader(io.StringIO(text)))
    return Extracted("\n".join(" | ".join(r) for r in rows), "csv")


def extract_text(data: bytes, filename: str, mime: str | None = None) -> Extracted:
    name = filename.lower()
    mime = (mime or "").lower()
    if name.endswith(".pdf") or mime == "application/pdf":
        return _pdf(data)
    if name.endswith(".docx") or "wordprocessingml" in mime:
        return _docx(data)
    if name.endswith((".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff")) or mime.startswith("image/"):
        return Extracted(ocr_image(data).strip(), "ocr")
    if name.endswith((".html", ".htm")) or mime == "text/html":
        return Extracted(html_to_text(data.decode("utf-8", "replace")), "html")
    if name.endswith(".csv") or mime == "text/csv":
        return _csv(data)
    if name.endswith((".txt", ".md", ".json", ".eml", ".vtt", ".srt")) or mime.startswith("text/"):
        return Extracted(data.decode("utf-8", "replace").strip(), "text")
    raise ExtractionError(f"unsupported file type: {filename}")
