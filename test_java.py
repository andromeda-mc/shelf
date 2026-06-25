from pathlib import Path
from shutil import which
import re
import subprocess

paths = [Path("/nix/store"), Path("/usr/lib/jvm"), Path("/usr/java")]
keywords = ["jre", "jdk", "temurin"]


def get_java_version(bin: Path) -> str | None:
    result = subprocess.run(
        [str(bin), "-version"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    output = result.stdout

    match = re.search(r'version "(.*?)"', output)
    if match:
        return match.group(1).removeprefix("1.").replace("_", ".")

    return None


def find_java_versions():
    major_versions: set[str] = set()
    found_versions: set[tuple[str, str]] = set()
    binaries: set[Path] = set()

    def add(version: str, java_bin: Path):
        data = (version, str(java_bin))
        major_version = version.split(".", 1)[0]

        major_versions.add(major_version)
        found_versions.add(data)
        binaries.add(java_bin)

    # Method 1: PATH

    java_path = which("java")
    if java_path:
        version = get_java_version(Path(java_path).resolve())
        if version:
            add(version, Path(java_path).resolve())

    # Method 2: Folders

    for store in paths:
        if not store.is_dir():
            continue
        for path in store.iterdir():
            path = path.resolve()
            # Stage 0: Already known

            if path in binaries or not path.is_dir():
                continue

            # Stage 1: Name check
            if path.parts[1] == "nix":
                split_name = path.name.split("-", 1)

                if len(split_name) == 1:
                    continue
                name = split_name[1]
            else:
                name = path.name

            if not any(keyword in name for keyword in keywords):
                continue

            # Stage 2: Version recognition
            candidate_bins = [path / "bin/java", path / "jre/bin/java", path / "jdk/bin/java"]            
            
            for java_bin in candidate_bins:
                if java_bin.is_file():
                    version = get_java_version(java_bin)
                    if version:
                        add(version, java_bin)
                    break

    return major_versions, found_versions


major, versions = find_java_versions()
for version, java_bin in versions:
    print(f"{version:20} {java_bin}")
