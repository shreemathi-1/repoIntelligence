"""Facts about the files in a repository that need no external tool."""

import contextlib
import re
from pathlib import Path

from app.scanners.base import ScanResult

LANGUAGES = {
    ".py": "Python",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".java": "Java",
    ".go": "Go",
    ".rs": "Rust",
    ".rb": "Ruby",
    ".php": "PHP",
    ".cs": "C#",
    ".kt": "Kotlin",
    ".swift": "Swift",
    ".c": "C",
    ".h": "C",
    ".cpp": "C++",
    ".hpp": "C++",
    ".scala": "Scala",
}
SKIP_DIRS = {
    "node_modules",
    ".git",
    "vendor",
    "dist",
    "build",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    "coverage",
}
TEST_PATH = re.compile(
    r"(^|/)(tests?|__tests__|spec|specs)(/|$)|(\.|_)(test|spec)\.\w+$|^test_\w+\.py$|_test\.(go|py|rb)$"
)
TEST_FRAMEWORKS = {
    "pytest": re.compile(r"\bpytest\b"),
    "unittest": re.compile(r"\bimport unittest\b"),
    "jest": re.compile(r"\bjest\b"),
    "vitest": re.compile(r"\bvitest\b"),
    "mocha": re.compile(r"\bmocha\b"),
    "junit": re.compile(r"\borg\.junit\b"),
    "go test": re.compile(r'"testing"'),
    "rspec": re.compile(r"\brspec\b"),
}
COVERAGE_FILES = {
    ".coveragerc",
    "codecov.yml",
    ".codecov.yml",
    "coverage.xml",
    "lcov.info",
    ".nycrc",
    ".nycrc.json",
    "jest.config.js",
    "jest.config.ts",
}
LINTERS = {
    "ruff": {"ruff.toml", ".ruff.toml"},
    "eslint": {
        ".eslintrc",
        ".eslintrc.json",
        ".eslintrc.js",
        ".eslintrc.cjs",
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.ts",
    },
    "flake8": {".flake8", "setup.cfg", "tox.ini"},
    "pylint": {".pylintrc"},
    "golangci": {".golangci.yml", ".golangci.yaml"},
    "checkstyle": {"checkstyle.xml"},
}
FORMATTERS = {
    "prettier": {
        ".prettierrc",
        ".prettierrc.json",
        ".prettierrc.js",
        "prettier.config.js",
        ".prettierrc.yml",
    },
    "black": set(),
    "editorconfig": {".editorconfig"},
}
MANIFESTS = {
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "go.mod",
    "Cargo.toml",
    "Gemfile",
    "composer.json",
}
LOCKFILES = {
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "go.sum",
    "Cargo.lock",
    "Gemfile.lock",
    "composer.lock",
}
COMMUNITY = {
    "README": re.compile(r"^readme(\.|$)", re.I),
    "LICENSE": re.compile(r"^(license|licence|copying)(\.|$)", re.I),
    "CONTRIBUTING": re.compile(r"^contributing(\.|$)", re.I),
    "CODE_OF_CONDUCT": re.compile(r"^code[_-]of[_-]conduct(\.|$)", re.I),
    "SECURITY": re.compile(r"^security(\.|$)", re.I),
    "CHANGELOG": re.compile(r"^(changelog|changes|history|releases)(\.|$)", re.I),
}
API_DOC_FILES = re.compile(r"^(openapi|swagger)[\w.-]*\.(json|ya?ml)$|^docs?/api", re.I)
MAX_README_BYTES = 512 * 1024


def _count_lines(path: Path) -> int:
    try:
        with path.open("rb") as handle:
            return sum(chunk.count(b"\n") for chunk in iter(lambda: handle.read(1 << 16), b""))
    except OSError:
        return 0


def _read_text(path: Path, limit: int) -> str:
    try:
        return path.read_bytes()[:limit].decode("utf-8", "replace")
    except OSError:
        return ""


def scan_inventory(root: Path) -> ScanResult:
    files = 0
    total_bytes = 0
    lines_by_language: dict[str, int] = {}
    source_files = 0
    test_files = 0
    frameworks: set[str] = set()
    coverage = False
    workflows: list[str] = []
    lockfiles: list[str] = []
    manifests: list[str] = []
    linters: set[str] = set()
    formatters: set[str] = set()
    api_docs = False
    dockerfile = False
    type_checking = False
    pre_commit = False
    dependabot = False
    codeowners = False
    community = dict.fromkeys(COMMUNITY, False)
    readme: Path | None = None
    sampled_sources = 0

    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if any(part in SKIP_DIRS for part in rel.parts[:-1]):
            continue
        if not path.is_file() or path.is_symlink():
            continue
        files += 1
        with contextlib.suppress(OSError):
            total_bytes += path.stat().st_size
        name = path.name
        rel_posix = rel.as_posix()
        depth = len(rel.parts)

        if depth == 1:
            for key, pattern in COMMUNITY.items():
                if pattern.match(name):
                    community[key] = True
                    if key == "README" and readme is None:
                        readme = path
            if name in MANIFESTS or name.startswith("requirements"):
                manifests.append(name)
            if name in LOCKFILES:
                lockfiles.append(name)
            if name in COVERAGE_FILES:
                coverage = True
            if name.lower() in ("dockerfile", "containerfile") or name.lower().startswith(
                "dockerfile."
            ):
                dockerfile = True
            if name in ("tsconfig.json", "mypy.ini", "pyrightconfig.json", "py.typed"):
                type_checking = True
            if name in (
                ".pre-commit-config.yaml",
                ".pre-commit-config.yml",
                ".husky",
                "lefthook.yml",
            ):
                pre_commit = True
            for linter, names in LINTERS.items():
                if name in names:
                    linters.add(linter)
            for formatter, names in FORMATTERS.items():
                if name in names:
                    formatters.add(formatter)
            if name == "pyproject.toml":
                text = _read_text(path, 64 * 1024)
                if "[tool.ruff" in text:
                    linters.add("ruff")
                if "[tool.black" in text:
                    formatters.add("black")
                if "[tool.mypy" in text or "[tool.pyright" in text:
                    type_checking = True
                if "[tool.coverage" in text or "pytest-cov" in text:
                    coverage = True
            if name == "package.json":
                text = _read_text(path, 64 * 1024)
                if '"husky"' in text or '"lint-staged"' in text:
                    pre_commit = True
                if '"eslint"' in text:
                    linters.add("eslint")
                if '"prettier"' in text:
                    formatters.add("prettier")
                if '"typescript"' in text:
                    type_checking = True
                if '"coverage"' in text or '"c8"' in text or '"nyc"' in text:
                    coverage = True
        if rel_posix.startswith(".github/workflows/") and path.suffix in (".yml", ".yaml"):
            workflows.append(name)
        if rel_posix in (
            ".github/dependabot.yml",
            ".github/dependabot.yaml",
            "renovate.json",
            ".renovaterc",
            ".github/renovate.json",
        ):
            dependabot = True
        if rel_posix in ("CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"):
            codeowners = True
        if depth == 2 and rel.parts[0] == ".github":
            for key in ("SECURITY", "CONTRIBUTING", "CODE_OF_CONDUCT"):
                if COMMUNITY[key].match(name):
                    community[key] = True
        if API_DOC_FILES.match(rel_posix) or API_DOC_FILES.match(name):
            api_docs = True
        if ".pre-commit-config" in name:
            pre_commit = True

        language = LANGUAGES.get(path.suffix.lower())
        if language:
            source_files += 1
            lines_by_language[language] = lines_by_language.get(language, 0) + _count_lines(path)
            if TEST_PATH.search(rel_posix):
                test_files += 1
            # Framework detection reads a bounded number of files, oldest-path first.
            if sampled_sources < 400:
                sampled_sources += 1
                text = _read_text(path, 32 * 1024)
                for framework, pattern in TEST_FRAMEWORKS.items():
                    if pattern.search(text):
                        frameworks.add(framework)

    readme_lines: int | None = None
    has_install: bool | None = None
    has_usage: bool | None = None
    has_code: bool | None = None
    if readme is not None:
        text = _read_text(readme, MAX_README_BYTES)
        readme_lines = text.count("\n") + 1
        has_install = (
            re.search(
                r"^#+.*\b(install|installation|setup|getting started|quick ?start)\b",
                text,
                re.I | re.M,
            )
            is not None
        )
        has_usage = (
            re.search(
                r"^#+.*\b(usage|example|examples|how to|api|documentation)\b", text, re.I | re.M
            )
            is not None
        )
        has_code = "```" in text

    data: dict[str, object] = {
        "files": files,
        "bytes": total_bytes,
        "linesByLanguage": dict(sorted(lines_by_language.items(), key=lambda kv: -kv[1])),
        "sourceFiles": source_files,
        "testFiles": test_files,
        "testFrameworks": sorted(frameworks),
        "coverageConfig": coverage,
        "ciWorkflows": sorted(workflows),
        "lockfiles": sorted(lockfiles),
        "manifests": sorted(manifests),
        "communityFiles": community,
        "readmeLines": readme_lines,
        "readmeHasInstall": has_install,
        "readmeHasUsage": has_usage,
        "readmeHasCodeBlocks": has_code,
        "apiDocs": api_docs,
        "dockerfile": dockerfile,
        "linterConfig": sorted(linters),
        "formatterConfig": sorted(formatters),
        "typeChecking": type_checking,
        "preCommitHooks": pre_commit,
        "securityPolicy": community["SECURITY"],
        "dependabotOrRenovate": dependabot,
        "codeowners": codeowners,
    }
    return ScanResult("inventory", "ok", None, None, 0, data)
