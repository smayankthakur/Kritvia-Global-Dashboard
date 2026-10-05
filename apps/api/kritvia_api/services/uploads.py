"""Upload allowlists: a file is accepted only if its extension is on the list for that kind of
upload AND its first bytes match that type (magic numbers), so a renamed executable or HTML page
can't get in as a "PDF". The MIME type we store is decided here from the checked type; the
browser's Content-Type is never trusted.

Kinds: document (knowledge, loan papers), image_or_pdf (public loan upload link), audio
(meetings, voice notes, dictation), csv (kitchen imports), xml (Tally exports).
"""
from __future__ import annotations

from fastapi import HTTPException, UploadFile

from kritvia_api.config import get_settings

TEXT_EXTS = {".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
             ".eml": "message/rfc822", ".vtt": "text/vtt", ".srt": "application/x-subrip",
             ".html": "text/html", ".htm": "text/html", ".xml": "application/xml"}
IMAGE_EXTS = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
              ".tif": "image/tiff", ".tiff": "image/tiff"}
AUDIO_EXTS = {".webm": "audio/webm", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
              ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".wav": "audio/wav",
              ".flac": "audio/flac", ".aac": "audio/aac"}
OTHER_EXTS = {".pdf": "application/pdf",
              ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}

KINDS: dict[str, set[str]] = {
    "document": {".pdf", ".docx", *IMAGE_EXTS, ".txt", ".md", ".csv", ".json", ".eml", ".vtt", ".srt", ".html", ".htm"},
    "image_or_pdf": {".pdf", ".png", ".jpg", ".jpeg", ".webp"},
    "audio": set(AUDIO_EXTS),
    "csv": {".csv", ".txt"},
    "xml": {".xml", ".txt"},
}
KIND_TEXT = {"document": "PDF, Word (.docx), image or text files", "image_or_pdf": "PDF and image files",
             "audio": "audio recordings (webm, ogg, mp3, m4a, wav, flac)", "csv": "CSV files", "xml": "Tally XML exports"}


def extension(filename: str | None) -> str:
    name = (filename or "").split("/")[-1].split("\\")[-1].lower()
    return name[name.rfind("."):] if "." in name else ""


def _looks_like_text(data: bytes) -> bool:
    head = data[:8192]
    if head.startswith((b"\xff\xfe", b"\xfe\xff")):   # UTF-16 with BOM
        return True
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
        return True
    except UnicodeDecodeError as exc:   # a multi-byte character cut at the 8 KB boundary is fine
        return exc.start >= len(head) - 4


def _magic_ok(ext: str, data: bytes) -> bool:
    if ext == ".pdf":
        return data[:1024].lstrip().startswith(b"%PDF-")
    if ext == ".docx":
        return data.startswith(b"PK\x03\x04") and b"word/" in data[:65536]
    if ext == ".png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in (".jpg", ".jpeg"):
        return data.startswith(b"\xff\xd8\xff")
    if ext == ".webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if ext in (".tif", ".tiff"):
        return data[:4] in (b"II*\x00", b"MM\x00*")
    if ext == ".webm":
        return data.startswith(b"\x1aE\xdf\xa3")                       # EBML (WebM/Matroska)
    if ext in (".ogg", ".oga", ".opus"):
        return data.startswith(b"OggS")
    if ext == ".mp3":
        return data.startswith(b"ID3") or (len(data) > 1 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0)
    if ext in (".m4a", ".mp4"):
        return data[4:8] == b"ftyp"
    if ext == ".wav":
        return data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    if ext == ".flac":
        return data.startswith(b"fLaC")
    if ext == ".aac":
        return len(data) > 1 and data[0] == 0xFF and data[1] & 0xF6 == 0xF0
    if ext in TEXT_EXTS:
        return _looks_like_text(data)
    return False


def check_upload(filename: str | None, data: bytes, kind: str) -> str:
    """The checked MIME type for this file, or 415 if it isn't allowed for this kind of upload."""
    ext = extension(filename)
    if ext not in KINDS[kind] or not _magic_ok(ext, data):
        raise HTTPException(415, f"only {KIND_TEXT[kind]} are accepted here, and the file must really be that type")
    return {**TEXT_EXTS, **IMAGE_EXTS, **AUDIO_EXTS, **OTHER_EXTS}[ext]


async def read_checked(file: UploadFile, kind: str, max_mb: int | None = None) -> tuple[bytes, str]:
    """Reads an upload within the size limit and checks its type. Returns (bytes, mime)."""
    limit = (max_mb or get_settings().max_upload_mb) * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"file larger than {limit // 1048576} MB")
    if not data:
        raise HTTPException(422, "empty file")
    return data, check_upload(file.filename, data, kind)
