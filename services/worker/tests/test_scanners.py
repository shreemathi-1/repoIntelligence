from pathlib import Path

import pytest
from app.archive import extract_tarball
from app.scan import scan_archive
from app.scanners import base, tools
from app.scanners.base import Scanner, ScanResult, ToolRun
from app.scanners.inventory import scan_inventory

from tests.fixtures import PYTHON_PROJECT, tarball


def findings_of(data: dict[str, object] | None) -> list[dict[str, object]]:
    assert data is not None
    rows = data["findings"]
    assert isinstance(rows, list)
    return [row for row in rows if isinstance(row, dict)]


@pytest.fixture
def project(tmp_path: Path) -> Path:
    return extract_tarball(tarball(PYTHON_PROJECT), tmp_path / "repo").root


def test_inventory_reads_project_facts(project: Path) -> None:
    data = scan_inventory(project).data
    assert data is not None
    assert data["sourceFiles"] == 3
    assert data["testFiles"] == 1
    assert data["testFrameworks"] == ["pytest"]
    assert data["ciWorkflows"] == ["ci.yml"]
    assert data["dependabotOrRenovate"] is True
    assert data["linterConfig"] == ["ruff"]
    assert data["typeChecking"] is True
    assert data["coverageConfig"] is False
    community = data["communityFiles"]
    assert isinstance(community, dict)
    assert community["README"] and community["LICENSE"] and not community["CONTRIBUTING"]
    assert data["readmeHasInstall"] is True
    assert data["readmeHasUsage"] is True
    assert data["readmeHasCodeBlocks"] is True
    assert data["manifests"] == ["pyproject.toml", "requirements.txt"]
    assert isinstance(data["linesByLanguage"], dict)
    assert data["linesByLanguage"]["Python"] > 30


def test_inventory_reports_unknowns_as_none_not_false(tmp_path: Path) -> None:
    root = extract_tarball(tarball({"main.go": "package main\n"}), tmp_path / "repo").root
    data = scan_inventory(root).data
    assert data is not None
    assert data["readmeLines"] is None
    assert data["readmeHasInstall"] is None


def test_ruff_finds_real_issues(project: Path) -> None:
    result = tools.SCANNERS["ruff"].execute(project)
    assert result.status == "ok", result.reason
    assert result.version is not None
    data = result.data
    assert data is not None
    rules = {f["rule"] for f in findings_of(data)}
    assert "S605" in rules or "S307" in rules
    assert data["filesChecked"] == 3
    paths = {str(f["path"]) for f in findings_of(data)}
    assert "src/tool/core.py" in paths
    assert not any(p.startswith("/") for p in paths)


def test_lizard_measures_complexity(project: Path) -> None:
    result = tools.SCANNERS["lizard"].execute(project)
    assert result.status == "ok", result.reason
    data = result.data
    assert data is not None
    assert data["functionCount"] == 3
    complex_functions = data["complexFunctions"]
    assert isinstance(complex_functions, list)
    assert len(complex_functions) == 1
    assert complex_functions[0]["name"] == "tangled"
    assert complex_functions[0]["path"] == "src/tool/core.py"
    assert complex_functions[0]["ccn"] > 15


def test_scanner_without_source_is_unavailable_not_clean(tmp_path: Path) -> None:
    root = extract_tarball(tarball({"README.md": "docs only"}), tmp_path / "repo").root
    for name in ("ruff", "lizard", "osv"):
        result = tools.SCANNERS[name].execute(root) if tools.SCANNERS[name].available() else None
        if result is not None:
            assert result.status == "unavailable"
            assert result.data is None


def test_missing_tool_is_unavailable(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(base, "find_tool", lambda name: None)
    result = Scanner("ruff", "ruff", 10, tools.run_ruff).execute(project)
    assert result.status == "unavailable"
    assert result.reason == "ruff is not installed"
    assert result.data is None


def test_timeout_and_crash_are_reported(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        tools, "run_tool", lambda argv, cwd, timeout_s: ToolRun(None, "", "", timed_out=True)
    )
    timed_out = Scanner("ruff", "ruff", 10, tools.run_ruff).execute(project)
    assert timed_out.status == "timeout"

    def explode(executable: str, root: Path) -> ScanResult:
        raise RuntimeError("boom")

    crashed = Scanner("ruff", "ruff", 10, explode).execute(project)
    assert crashed.status == "failed"
    assert crashed.reason == "RuntimeError: boom"


def test_gitleaks_output_never_includes_the_secret(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report = (
        '[{"RuleID":"aws-access-key","Description":"AWS key","File":"REPO/src/tool/core.py",'
        '"StartLine":4,"Secret":"AKIA_THE_SECRET","Match":"AKIA_THE_SECRET"}]'
    )

    def fake_run(argv: list[str], cwd: Path, timeout_s: float) -> ToolRun:
        Path(argv[argv.index("--report-path") + 1]).write_text(report.replace("REPO", str(cwd)))
        return ToolRun(0, "", "")

    monkeypatch.setattr(tools, "run_tool", fake_run)
    result = tools.run_gitleaks("gitleaks", project)
    assert result.status == "ok"
    assert "AKIA_THE_SECRET" not in str(result.to_dict())
    finding = findings_of(result.data)[0]
    assert finding == {
        "tool": "gitleaks",
        "rule": "aws-access-key",
        "severity": "critical",
        "message": "AWS key",
        "path": "src/tool/core.py",
        "line": 4,
    }


def test_osv_parses_vulnerabilities(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {
        "results": [
            {
                "packages": [
                    {
                        "package": {"name": "requests", "version": "2.31.0", "ecosystem": "PyPI"},
                        "vulnerabilities": [
                            {
                                "id": "GHSA-xxxx",
                                "severity": [{"type": "CVSS_V3", "score": "7.5"}],
                                "affected": [
                                    {
                                        "package": {"name": "requests"},
                                        "ranges": [
                                            {"events": [{"introduced": "0"}, {"fixed": "2.32.0"}]}
                                        ],
                                    }
                                ],
                            },
                            {"id": "GHSA-yyyy", "database_specific": {"severity": "LOW"}},
                        ],
                    },
                    {
                        "package": {"name": "safe", "version": "1", "ecosystem": "PyPI"},
                        "vulnerabilities": [],
                    },
                ]
            }
        ]
    }
    import json

    monkeypatch.setattr(
        tools, "run_tool", lambda argv, cwd, timeout_s: ToolRun(1, json.dumps(payload), "")
    )
    result = tools.run_osv("osv-scanner", project)
    assert result.status == "ok"
    data = result.data
    assert data is not None
    assert data["lockfilesScanned"] == ["requirements.txt"]
    assert data["packagesScanned"] == 2
    vulns = data["vulnerabilities"]
    assert isinstance(vulns, list)
    assert vulns[0] == {
        "id": "GHSA-xxxx",
        "package": "requests",
        "ecosystem": "PyPI",
        "version": "2.31.0",
        "severity": "high",
        "fixedIn": "2.32.0",
    }
    assert vulns[1]["severity"] == "low"


def test_scan_archive_runs_selected_tools_and_cleans_up(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    import tempfile

    tempfile.tempdir = None
    response = scan_archive(tarball(PYTHON_PROJECT), ["inventory", "ruff", "gitleaks"])
    assert response["archiveFiles"] == len(PYTHON_PROJECT)
    results = response["results"]
    assert isinstance(results, list)
    assert [r["tool"] for r in results] == ["inventory", "ruff", "gitleaks"]
    statuses = {r["tool"]: r["status"] for r in results}
    assert statuses["inventory"] == "ok"
    assert statuses["ruff"] == "ok"
    assert statuses["gitleaks"] in ("ok", "unavailable")
    assert not list(tmp_path.glob("ri-scan-*"))
