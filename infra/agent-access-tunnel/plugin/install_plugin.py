#!/usr/bin/env python3
"""Install webagenttools-home into a MiniMax Code data directory.

The cloud/Linux package uses the portable Node launcher because POSIX Python is
commonly named python3. Windows Desktop uses python directly because its
runtime PATH includes the installed Python interpreter but not necessarily the
system Node.js installation.
"""

import argparse
import os
import shutil
import sys
from pathlib import Path


PACKAGE_FILES = ("plugin.json", "bridge.py", "bridge-launcher.mjs")


def install(source: Path, data_dir: Path, platform: str) -> Path:
    package = source / "webagenttools-home"
    target = data_dir / "plugins" / "webagenttools-home"
    staging = target.with_name(target.name + ".tmp")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    for name in PACKAGE_FILES:
        shutil.copyfile(package / name, staging / name)

    mcp_source = package / ("mcp.windows.json" if platform == "windows" else "mcp.json")
    shutil.copyfile(mcp_source, staging / "mcp.json")

    if target.exists():
        shutil.rmtree(target)
    staging.replace(target)
    return target


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data-dir",
        required=True,
        help="MiniMax Code data directory containing plugins/ and v2/",
    )
    parser.add_argument(
        "--platform",
        choices=("windows", "posix"),
        default="windows" if os.name == "nt" else "posix",
    )
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    target = install(source, Path(args.data_dir).expanduser().resolve(), args.platform)
    print(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
