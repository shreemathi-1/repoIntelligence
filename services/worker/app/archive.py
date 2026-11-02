"""Unpacks a repository tarball into a scratch directory without trusting its contents."""

import io
import tarfile
from dataclasses import dataclass
from pathlib import Path

MAX_FILES = 20_000
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_FILE_BYTES = 20 * 1024 * 1024


class ArchiveError(ValueError):
    """The archive is malformed, too large or tries to escape the target directory."""


@dataclass(frozen=True)
class Extracted:
    root: Path
    files: int
    bytes: int


def _safe_member(member: tarfile.TarInfo, root: Path) -> Path | None:
    """The destination of a member, or None when it should be skipped."""
    if not (member.isfile() or member.isdir()):
        # Links and devices are never extracted: a symlink could point anywhere.
        return None
    parts = Path(member.name).parts
    if not parts or any(part in ("..", "") for part in parts) or Path(member.name).is_absolute():
        raise ArchiveError(f"unsafe path in archive: {member.name!r}")
    target = (root / Path(*parts)).resolve()
    if root not in target.parents and target != root:
        raise ArchiveError(f"path escapes archive root: {member.name!r}")
    return target


def extract_tarball(data: bytes, root: Path) -> Extracted:
    """Extracts a .tar.gz into `root`, dropping the single top-level folder GitHub adds."""
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    files = 0
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            members = tar.getmembers()
            prefix = _common_prefix(members)
            for member in members:
                if member.isfile():
                    if member.size > MAX_FILE_BYTES:
                        continue
                    files += 1
                    total += member.size
                    if files > MAX_FILES:
                        raise ArchiveError(f"archive has more than {MAX_FILES} files")
                    if total > MAX_TOTAL_BYTES:
                        raise ArchiveError("archive is larger than the limit when unpacked")
                name = (
                    member.name[len(prefix) :]
                    if prefix and member.name.startswith(prefix)
                    else member.name
                )
                if name in ("", "/"):
                    continue
                member.name = name
                target = _safe_member(member, root)
                if target is None:
                    continue
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                if source is None:
                    continue
                with source, target.open("wb") as out:
                    out.write(source.read())
                # Nothing from an archive is ever executable here.
                target.chmod(0o644)
    except (tarfile.TarError, EOFError, OSError) as err:
        raise ArchiveError(f"could not read archive: {err}") from err
    return Extracted(root=root, files=files, bytes=total)


def _common_prefix(members: list[tarfile.TarInfo]) -> str:
    """GitHub tarballs wrap everything in `owner-repo-sha/`; return that folder with its slash."""
    tops = {m.name.split("/", 1)[0] for m in members if m.name not in ("", ".")}
    if len(tops) == 1:
        top = tops.pop()
        # A ".." wrapper is an escape attempt, not a folder; leave it for the safety check.
        if top not in ("..", ".") and any(m.name != top for m in members):
            return f"{top}/"
    return ""
