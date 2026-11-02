"""Shared plumbing for running external tools on an extracted repository."""

import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

Status = Literal["ok", "unavailable", "failed", "timeout"]
Severity = Literal["critical", "high", "medium", "low", "info"]

# Keep stored finding lists bounded; the full count is always reported.
MAX_FINDINGS = 500


@dataclass
class ScanResult:
    tool: str
    status: Status
    version: str | None
    reason: str | None
    duration_ms: int
    data: dict[str, object] | None

    def to_dict(self) -> dict[str, object]:
        return {
            "tool": self.tool,
            "status": self.status,
            "version": self.version,
            "reason": self.reason,
            "durationMs": self.duration_ms,
            "data": self.data,
        }


@dataclass
class ToolRun:
    returncode: int | None
    stdout: str
    stderr: str
    timed_out: bool = False


def find_tool(name: str) -> str | None:
    """Prefer a copy installed next to this interpreter (the venv), then PATH."""
    local = Path(sys.executable).parent / name
    if local.is_file():
        return str(local)
    return shutil.which(name)


def tool_version(executable: str, args: Sequence[str] = ("--version",)) -> str | None:
    try:
        run = subprocess.run(  # noqa: S603 - fixed executable, fixed arguments
            [executable, *args], capture_output=True, text=True, timeout=15, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (run.stdout or run.stderr).strip().splitlines()
    return text[0][:80] if text else None


def run_tool(argv: Sequence[str], cwd: Path, timeout_s: float) -> ToolRun:
    """Runs a tool with no shell, a timeout and a fixed working directory."""
    try:
        run = subprocess.run(  # noqa: S603 - argv is built by the adapter, never from input
            list(argv),
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
            errors="replace",
        )
    except subprocess.TimeoutExpired as err:
        return ToolRun(
            returncode=None,
            stdout=_text(err.stdout),
            stderr=_text(err.stderr),
            timed_out=True,
        )
    except OSError as err:
        return ToolRun(returncode=None, stdout="", stderr=str(err))
    return ToolRun(returncode=run.returncode, stdout=run.stdout, stderr=run.stderr)


def _text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    return value if isinstance(value, str) else value.decode("utf-8", "replace")


@dataclass
class Finding:
    tool: str
    rule: str
    severity: Severity
    message: str
    path: str
    line: int | None

    def to_dict(self) -> dict[str, object]:
        return {
            "tool": self.tool,
            "rule": self.rule,
            "severity": self.severity,
            "message": self.message[:300],
            "path": self.path,
            "line": self.line,
        }


def findings_data(findings: list[Finding], files_checked: int | None) -> dict[str, object]:
    return {
        "filesChecked": files_checked,
        "findings": [f.to_dict() for f in findings[:MAX_FINDINGS]],
        "count": len(findings),
    }


def relative(path: str, root: Path) -> str:
    """A path as the repository sees it, never the scratch directory."""
    try:
        return Path(path).resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return Path(path).as_posix().lstrip("./")


@dataclass
class Scanner:
    """How to run one tool. `run` is only called when the executable exists."""

    name: str
    executable: str
    timeout_s: float
    run: Callable[[str, Path], ScanResult]
    version_args: Sequence[str] = field(default_factory=lambda: ["--version"])

    def available(self) -> str | None:
        return find_tool(self.executable)

    def execute(self, root: Path) -> ScanResult:
        started = time.monotonic()
        path = self.available()
        if path is None:
            return ScanResult(
                self.name, "unavailable", None, f"{self.executable} is not installed", 0, None
            )
        try:
            result = self.run(path, root)
        except Exception as err:  # noqa: BLE001 - a crashing tool must not take the scan down
            result = ScanResult(
                self.name, "failed", None, f"{type(err).__name__}: {err}"[:200], 0, None
            )
        result.duration_ms = int((time.monotonic() - started) * 1000)
        if result.version is None:
            result.version = tool_version(path, self.version_args)
        return result


def unavailable(tool: str, reason: str) -> ScanResult:
    return ScanResult(tool, "unavailable", None, reason, 0, None)


def failed(tool: str, run: ToolRun, detail: str = "") -> ScanResult:
    if run.timed_out:
        return ScanResult(tool, "timeout", None, "the tool did not finish in time", 0, None)
    reason = detail or run.stderr.strip().splitlines()[-1:] or ["exited with an error"]
    text = reason if isinstance(reason, str) else reason[0]
    return ScanResult(tool, "failed", None, f"exit {run.returncode}: {text}"[:200], 0, None)
