"""Unpacks an archive and builds its architecture graph in a scratch directory."""

import shutil
import tempfile
from pathlib import Path

from app.archive import extract_tarball
from app.graph.build import build_graph


def graph_archive(data: bytes) -> dict[str, object]:
    scratch = Path(tempfile.mkdtemp(prefix="ri-graph-"))
    try:
        extracted = extract_tarball(data, scratch / "repo")
        graph = build_graph(extracted.root)
        graph["archiveFiles"] = extracted.files
        return graph
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
