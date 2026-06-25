from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Iterable

JAVA_VERSION_REGEX = re.compile(r'version "(.*?)"')


def get_java_version(java_bin: Path) -> str | None:
    try:
        result = subprocess.run(
            [str(java_bin), "-version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=3,
        )

        output = result.stdout

        match = JAVA_VERSION_REGEX.search(output)
        if match:
            return match.group(1)

    except Exception:
        pass

    return None


def candidate_directories() -> Iterable[Path]:
    home = Path.home()

    candidates = [
        Path("/usr/lib/jvm"),
        Path("/usr/java"),
        home / ".sdkman/candidates/java",
        home / ".asdf/installs/java",
        Path("/opt"),
        Path("/nix/store"),
    ]

    for path in candidates:
        if path.exists():
            yield path


def find_java_binaries() -> set[Path]:
    binaries: set[Path] = set()

    # PATH
    java_in_path = shutil.which("java")
    if java_in_path:
        binaries.add(Path(java_in_path).resolve())

    # Known directories
    for base_dir in candidate_directories():
        try:
            for path in base_dir.rglob("java"):
                if not path.is_file():
                    continue

                if not os.access(path, os.X_OK):
                    continue

                # usually java binaries live in /bin/java
                if path.parent.name != "bin":
                    continue

                binaries.add(path.resolve())

        except PermissionError:
            continue

    return binaries


def list_installed_java_versions():
    results = []

    for java_bin in sorted(find_java_binaries()):
        version = get_java_version(java_bin)

        if version is None:
            continue

        results.append(
            {
                "version": version,
                "path": str(java_bin),
            }
        )

    return results


if __name__ == "__main__":
    for java in list_installed_java_versions():
        print(f"{java['version']:20} {java['path']}")
