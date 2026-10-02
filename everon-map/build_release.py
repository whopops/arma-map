"""Build a small-memory production archive, excluding Git and local runtime state.

Run before deployment: python build_release.py --output dist/everon-map.tar.gz
Extract into the serving directory, then start server.py as usual.
"""
import argparse
import gzip
import mimetypes
import os
from pathlib import Path
import shutil
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent
TEXT_TYPES = {"text/html", "text/css", "application/javascript", "application/json"}
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")


def build(output, root=ROOT):
    root = Path(root).resolve()
    output = Path(output).resolve()
    static = root / "static"
    if output == root / "server.py" or static == output or static in output.parents:
        raise ValueError("The archive must be outside static/ and must not replace server.py.")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=output.parent, suffix=".part")
    os.close(fd)
    try:
        with tempfile.TemporaryDirectory() as staging, tarfile.open(temporary, "w:gz", compresslevel=6) as archive:
            archive.add(root / "server.py", arcname="server.py")
            for source in sorted(static.rglob("*")):
                if not source.is_file():
                    continue
                if source.is_symlink():
                    raise ValueError(f"Static symlinks are not supported: {source}")
                name = source.relative_to(root).as_posix()
                archive.add(source, arcname=name)
                if source.stat().st_size <= 1000 or mimetypes.guess_type(source)[0] not in TEXT_TYPES:
                    continue
                if source.with_name(source.name + ".gz").exists():
                    raise ValueError(f"Remove the existing text sidecar before building: {source}.gz")
                compressed = Path(staging) / "body.gz"
                with source.open("rb") as src, compressed.open("wb") as out:
                    with gzip.GzipFile(filename="", fileobj=out, mode="wb", compresslevel=6, mtime=0) as gz:
                        shutil.copyfileobj(src, gz, 64 * 1024)
                st = source.stat()
                os.utime(compressed, ns=(st.st_atime_ns, st.st_mtime_ns))
                archive.add(compressed, arcname=name + ".gz")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "everon-map.tar.gz")
    args = parser.parse_args()
    output = build(args.output)
    print(f"Production archive: {output} ({output.stat().st_size / 2**20:.1f} MiB)")


if __name__ == "__main__":
    main()
