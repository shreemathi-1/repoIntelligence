"""Builds gzipped tarballs in memory, shaped like the ones GitHub serves."""

import io
import tarfile


def tarball(files: dict[str, bytes | str], prefix: str = "acme-tool-abc123/") -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode() if isinstance(content, str) else content
            info = tarfile.TarInfo(name=f"{prefix}{name}")
            info.size = len(data)
            info.mode = 0o755
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def tarball_with_symlink() -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        link = tarfile.TarInfo(name="repo/evil")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        tar.addfile(link)
        data = b"x = 1\n"
        info = tarfile.TarInfo(name="repo/ok.py")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


PYTHON_PROJECT: dict[str, bytes | str] = {
    "README.md": (
        "# Tool\n\n## Installation\n\n```sh\npip install tool\n```\n\n## Usage\n\nRun it.\n"
    ),
    "LICENSE": "MIT",
    "pyproject.toml": (
        '[project]\nname = "tool"\n[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n'
    ),
    "requirements.txt": "requests==2.31.0\n",
    ".github/workflows/ci.yml": "name: CI\n",
    ".github/dependabot.yml": "version: 2\n",
    "src/tool/__init__.py": "",
    "src/tool/core.py": (
        "import os\n\n\ndef risky(cmd):\n    os.system(cmd)\n    return eval('1')\n\n\n"
        "def tangled(a, b, c, d):\n"
        + "".join(f"    if a == {i}:\n        return {i}\n" for i in range(18))
        + "    return 0\n"
    ),
    "tests/test_core.py": "import pytest\n\n\ndef test_x():\n    assert 1\n",
}
