import importlib.metadata
import os
import subprocess
import sys
import tempfile

#: Packages installed at their newest numpy-compatible versions.
SCIENTIFIC_PACKAGES = (
    "scipy",
    "opencv-python-headless",
)


def _numpy_constraints_file():
    """Writes a pip constraints file pinning numpy to the installed version."""
    numpy_version = importlib.metadata.version("numpy")
    fd, path = tempfile.mkstemp(prefix="swarm-numpy-", suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(f"numpy=={numpy_version}\n")
    return path


def pip_install(*packages, requirements=None, upgrade=False):
    constraints = _numpy_constraints_file()
    try:
        args = [sys.executable, "-m", "pip", "install", "--quiet", "-c", constraints]
        if upgrade:
            args.append("--upgrade")
        args.extend(packages)
        if requirements:
            args.extend(["-r", requirements])
        subprocess.run(args, check=True)
    finally:
        os.remove(constraints)


def ensure_pinned_scientific_stack(upgrade=False):
    """Installs the newest SciPy/OpenCV compatible with Swarm's numpy."""
    pip_install(*SCIENTIFIC_PACKAGES, upgrade=upgrade)
