"""Runs the requested scanners over one uploaded archive."""

import shutil
import tempfile
import time
from pathlib import Path

from app.archive import extract_tarball
from app.scanners.base import ScanResult
from app.scanners.inventory import scan_inventory
from app.scanners.tools import SCANNERS

ALL_TOOLS = ("inventory", *SCANNERS)


def scan_archive(data: bytes, tools: list[str]) -> dict[str, object]:
    """Extracts into a scratch directory, scans, and always removes the directory afterwards."""
    scratch = Path(tempfile.mkdtemp(prefix="ri-scan-"))
    try:
        extracted = extract_tarball(data, scratch / "repo")
        results: list[ScanResult] = []
        for tool in tools:
            if tool == "inventory":
                started = time.monotonic()
                result = scan_inventory(extracted.root)
                result.duration_ms = int((time.monotonic() - started) * 1000)
                results.append(result)
            elif tool in SCANNERS:
                results.append(SCANNERS[tool].execute(extracted.root))
        return {
            "archiveFiles": extracted.files,
            "archiveBytes": extracted.bytes,
            "results": [r.to_dict() for r in results],
        }
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def list_scanners() -> list[dict[str, object]]:
    from app.scanners.base import tool_version

    rows: list[dict[str, object]] = [{"tool": "inventory", "available": True, "version": None}]
    for name, scanner in SCANNERS.items():
        path = scanner.available()
        rows.append(
            {
                "tool": name,
                "available": path is not None,
                "version": tool_version(path, scanner.version_args) if path else None,
            }
        )
    return rows
