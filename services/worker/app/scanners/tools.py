"""Adapters for the external scanners. Each turns a tool's own output into our shape."""

import csv
import io
import json
import tempfile
from pathlib import Path
from typing import Any

from app.scanners.base import (
    Finding,
    Scanner,
    ScanResult,
    Severity,
    failed,
    findings_data,
    relative,
    run_tool,
    unavailable,
)

COMPLEXITY_THRESHOLD = 15
MAX_COMPLEX_FUNCTIONS = 200
SOURCE_SUFFIXES = (
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".java",
    ".go",
    ".rb",
    ".php",
    ".cs",
    ".kt",
    ".swift",
    ".c",
    ".cpp",
    ".rs",
    ".scala",
)
EXCLUDES = [
    "node_modules",
    "vendor",
    "dist",
    "build",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".git",
]


def _json(text: str) -> Any:  # noqa: ANN401 - tool output has no fixed shape until validated
    return json.loads(text) if text.strip() else None


def _has_source(root: Path, suffixes: tuple[str, ...]) -> bool:
    for path in root.rglob("*"):
        if path.suffix in suffixes and not any(
            part in EXCLUDES for part in path.relative_to(root).parts
        ):
            return True
    return False


# ---- lizard: cyclomatic complexity ----------------------------------------------------------


def run_lizard(executable: str, root: Path) -> ScanResult:
    if not _has_source(root, SOURCE_SUFFIXES):
        return unavailable("lizard", "no source files lizard understands")
    argv = [executable, "--csv", "--working_threads", "2"]
    for name in EXCLUDES:
        argv += ["-x", f"./{name}/*", "-x", f"*/{name}/*"]
    argv.append(".")
    run = run_tool(argv, root, timeout_s=240)
    if run.returncode is None or run.returncode not in (0, 1):
        return failed("lizard", run)

    functions = 0
    nloc_total = 0
    ccn_total = 0
    files: set[str] = set()
    complex_functions: list[dict[str, object]] = []
    # Columns: NLOC, CCN, token, PARAM, length, location, file, function, long_name, start, end
    for row in csv.reader(io.StringIO(run.stdout)):
        if len(row) < 11:
            continue
        try:
            nloc, ccn, params, start = int(row[0]), int(row[1]), int(row[3]), int(row[9])
        except ValueError:
            continue
        path = relative(row[6], root)
        files.add(path)
        functions += 1
        nloc_total += nloc
        ccn_total += ccn
        if ccn > COMPLEXITY_THRESHOLD and len(complex_functions) < MAX_COMPLEX_FUNCTIONS:
            complex_functions.append(
                {
                    "name": row[7],
                    "path": path,
                    "line": start,
                    "ccn": ccn,
                    "nloc": nloc,
                    "parameters": params,
                }
            )
    complex_functions.sort(key=lambda f: -int(str(f["ccn"])))
    data: dict[str, object] = {
        "filesAnalysed": len(files),
        "nloc": nloc_total,
        "functionCount": functions,
        "averageCcn": round(ccn_total / functions, 2) if functions else None,
        "complexFunctions": complex_functions,
    }
    return ScanResult("lizard", "ok", None, None, 0, data)


# ---- jscpd: duplication -------------------------------------------------------------------------


def run_jscpd(executable: str, root: Path) -> ScanResult:
    if not _has_source(root, SOURCE_SUFFIXES):
        return unavailable("jscpd", "no source files to compare")
    with tempfile.TemporaryDirectory(prefix="jscpd-") as out:
        argv = [
            executable,
            "--reporters",
            "json",
            "--output",
            out,
            "--silent",
            "--min-tokens",
            "50",
            "--min-lines",
            "5",
        ]
        for name in EXCLUDES:
            argv += ["--ignore", f"**/{name}/**"]
        argv.append(".")
        run = run_tool(argv, root, timeout_s=240)
        report = Path(out) / "jscpd-report.json"
        if run.timed_out or not report.exists():
            return failed("jscpd", run, "no report was written")
        payload = _json(report.read_text(encoding="utf-8", errors="replace"))
    stats = payload.get("statistics", {}).get("total", {}) if isinstance(payload, dict) else {}
    total = int(stats.get("lines", 0))
    duplicated = int(stats.get("duplicatedLines", 0))
    data: dict[str, object] = {
        "totalLines": total,
        "duplicatedLines": duplicated,
        "duplicationPercent": round(float(stats.get("percentage", 0.0)), 2),
        "cloneCount": int(stats.get("clones", 0)),
    }
    return ScanResult("jscpd", "ok", None, None, 0, data)


# ---- ruff: python lint ------------------------------------------------------------------------


def run_ruff(executable: str, root: Path) -> ScanResult:
    if not _has_source(root, (".py",)):
        return unavailable("ruff", "no Python files")
    # The repository's own configuration is ignored so every project is measured the same way.
    argv = [
        executable,
        "check",
        ".",
        "--output-format",
        "json",
        "--exit-zero",
        "--isolated",
        "--select",
        "E,F,B,S",
        "--no-cache",
    ]
    for name in EXCLUDES:
        argv += ["--exclude", name]
    run = run_tool(argv, root, timeout_s=180)
    if run.returncode != 0:
        return failed("ruff", run)
    rows = _json(run.stdout) or []
    findings = [
        Finding(
            tool="ruff",
            rule=str(row.get("code") or "unknown"),
            severity="medium" if str(row.get("code", "")).startswith(("S", "B")) else "low",
            message=str(row.get("message", "")),
            path=relative(str(row.get("filename", "")), root),
            line=int(row.get("location", {}).get("row", 0)) or None,
        )
        for row in rows
        if isinstance(row, dict)
    ]
    checked = sum(
        1
        for p in root.rglob("*.py")
        if not any(part in EXCLUDES for part in p.relative_to(root).parts)
    )
    return ScanResult("ruff", "ok", None, None, 0, findings_data(findings, checked))


# ---- semgrep: static analysis -----------------------------------------------------------------

SEMGREP_SEVERITY: dict[str, Severity] = {"ERROR": "high", "WARNING": "medium", "INFO": "low"}


def run_semgrep(executable: str, root: Path) -> ScanResult:
    if not _has_source(root, SOURCE_SUFFIXES):
        return unavailable("semgrep", "no source files")
    argv = [
        executable,
        "scan",
        "--json",
        "--config",
        "p/default",
        "--metrics=off",
        "--timeout",
        "30",
        "--quiet",
        ".",
    ]
    for name in EXCLUDES:
        argv += ["--exclude", name]
    run = run_tool(argv, root, timeout_s=600)
    if run.returncode not in (0, 1) or not run.stdout.strip():
        return failed("semgrep", run)
    payload = _json(run.stdout) or {}
    findings = [
        Finding(
            tool="semgrep",
            rule=str(item.get("check_id", "unknown")).split(".")[-1],
            severity=SEMGREP_SEVERITY.get(str(item.get("extra", {}).get("severity", "")), "medium"),
            message=str(item.get("extra", {}).get("message", "")),
            path=relative(str(item.get("path", "")), root),
            line=int(item.get("start", {}).get("line", 0)) or None,
        )
        for item in payload.get("results", [])
        if isinstance(item, dict)
    ]
    scanned = payload.get("paths", {}).get("scanned", [])
    return ScanResult(
        "semgrep",
        "ok",
        None,
        None,
        0,
        findings_data(findings, len(scanned) if isinstance(scanned, list) else None),
    )


# ---- gitleaks: secrets ------------------------------------------------------------------------


def run_gitleaks(executable: str, root: Path) -> ScanResult:
    with tempfile.NamedTemporaryFile(prefix="gitleaks-", suffix=".json", delete=False) as handle:
        report = Path(handle.name)
    try:
        argv = [
            executable,
            "detect",
            "--no-git",
            "--source",
            ".",
            "--report-format",
            "json",
            "--report-path",
            str(report),
            "--exit-code",
            "0",
            "--redact",
            "--no-banner",
        ]
        run = run_tool(argv, root, timeout_s=240)
        if run.returncode != 0 or not report.exists():
            return failed("gitleaks", run)
        rows = _json(report.read_text(encoding="utf-8", errors="replace")) or []
    finally:
        report.unlink(missing_ok=True)
    # Only the location and rule are kept. The matched text never leaves the worker.
    findings = [
        Finding(
            tool="gitleaks",
            rule=str(row.get("RuleID", "secret")),
            severity="critical",
            message=str(row.get("Description", "Possible secret")),
            path=relative(str(row.get("File", "")), root),
            line=int(row.get("StartLine", 0)) or None,
        )
        for row in rows
        if isinstance(row, dict)
    ]
    return ScanResult("gitleaks", "ok", None, None, 0, findings_data(findings, None))


# ---- osv-scanner: known vulnerabilities -----------------------------------------------------

LOCKFILES = (
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "requirements.txt",
    "go.mod",
    "Cargo.lock",
    "Gemfile.lock",
    "composer.lock",
    "pom.xml",
)


def _osv_severity(vuln: dict[str, Any]) -> Severity:
    for entry in vuln.get("severity", []) or []:
        score = str(entry.get("score", ""))
        # CVSS vectors carry no number; the database_specific severity below covers those.
        try:
            value = float(score)
        except ValueError:
            continue
        if value >= 9:
            return "critical"
        if value >= 7:
            return "high"
        if value >= 4:
            return "medium"
        return "low"
    text = str((vuln.get("database_specific") or {}).get("severity", "")).upper()
    mapping: dict[str, Severity] = {
        "CRITICAL": "critical",
        "HIGH": "high",
        "MODERATE": "medium",
        "MEDIUM": "medium",
        "LOW": "low",
    }
    return mapping.get(text, "medium")


def _fixed_in(vuln: dict[str, Any], package: str) -> str | None:
    for affected in vuln.get("affected", []) or []:
        if str((affected.get("package") or {}).get("name", "")) != package:
            continue
        for rng in affected.get("ranges", []) or []:
            for event in rng.get("events", []) or []:
                if "fixed" in event:
                    return str(event["fixed"])
    return None


def run_osv(executable: str, root: Path) -> ScanResult:
    lockfiles = sorted(
        p.relative_to(root).as_posix()
        for p in root.rglob("*")
        if p.name in LOCKFILES and not any(part in EXCLUDES for part in p.relative_to(root).parts)
    )
    if not lockfiles:
        return unavailable("osv", "no dependency lockfile or manifest to scan")
    argv = [executable, "scan", "source", "--format", "json", "--recursive", "."]
    run = run_tool(argv, root, timeout_s=300)
    # Exit 1 means vulnerabilities were found; anything else is a real failure.
    if run.returncode not in (0, 1) or not run.stdout.strip():
        return failed("osv", run)
    payload = _json(run.stdout) or {}
    vulnerabilities: list[dict[str, object]] = []
    packages = 0
    for result in payload.get("results", []) or []:
        for pkg in result.get("packages", []) or []:
            packages += 1
            info = pkg.get("package", {})
            name = str(info.get("name", ""))
            for vuln in pkg.get("vulnerabilities", []) or []:
                vulnerabilities.append(
                    {
                        "id": str(vuln.get("id", "")),
                        "package": name,
                        "ecosystem": str(info.get("ecosystem", "")),
                        "version": str(info.get("version", "")),
                        "severity": _osv_severity(vuln),
                        "fixedIn": _fixed_in(vuln, name),
                    }
                )
    data: dict[str, object] = {
        "lockfilesScanned": lockfiles,
        "packagesScanned": packages,
        "vulnerabilities": vulnerabilities[:500],
    }
    return ScanResult("osv", "ok", None, None, 0, data)


SCANNERS: dict[str, Scanner] = {
    "lizard": Scanner("lizard", "lizard", 240, run_lizard),
    "jscpd": Scanner("jscpd", "jscpd", 240, run_jscpd),
    "ruff": Scanner("ruff", "ruff", 180, run_ruff),
    "semgrep": Scanner("semgrep", "semgrep", 600, run_semgrep),
    "gitleaks": Scanner("gitleaks", "gitleaks", 240, run_gitleaks, version_args=["version"]),
    "osv": Scanner("osv", "osv-scanner", 300, run_osv),
}
