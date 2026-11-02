from pathlib import Path

import pytest
from app import archive
from app.archive import ArchiveError, extract_tarball

from tests.fixtures import tarball, tarball_with_symlink


def test_extracts_and_strips_the_github_prefix(tmp_path: Path) -> None:
    result = extract_tarball(tarball({"README.md": "hi", "src/a.py": "x = 1\n"}), tmp_path / "repo")
    assert result.files == 2
    assert result.bytes == len("hi") + len("x = 1\n")
    assert (result.root / "README.md").read_text() == "hi"
    assert (result.root / "src" / "a.py").exists()
    assert not (result.root / "acme-tool-abc123").exists()


def test_keeps_a_flat_archive_as_is(tmp_path: Path) -> None:
    result = extract_tarball(tarball({"a.txt": "a", "b.txt": "b"}, prefix=""), tmp_path / "repo")
    assert sorted(p.name for p in result.root.iterdir()) == ["a.txt", "b.txt"]


def test_rejects_path_traversal(tmp_path: Path) -> None:
    with pytest.raises(ArchiveError, match="unsafe path"):
        extract_tarball(tarball({"../../escape.txt": "boom"}, prefix=""), tmp_path / "repo")
    assert not (tmp_path / "escape.txt").exists()


def test_skips_symlinks_and_strips_execute_bits(tmp_path: Path) -> None:
    result = extract_tarball(tarball_with_symlink(), tmp_path / "repo")
    assert result.files == 1
    assert not (result.root / "evil").exists()
    assert (result.root / "ok.py").stat().st_mode & 0o111 == 0


def test_rejects_too_many_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(archive, "MAX_FILES", 2)
    with pytest.raises(ArchiveError, match="more than 2 files"):
        extract_tarball(tarball({"a": "1", "b": "2", "c": "3"}), tmp_path / "repo")


def test_rejects_garbage(tmp_path: Path) -> None:
    with pytest.raises(ArchiveError, match="could not read"):
        extract_tarball(b"not a tarball", tmp_path / "repo")
