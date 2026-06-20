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

ML_SHARP_PACKAGE = "git+https://github.com/apple/ml-sharp.git"
VGGT_PACKAGE = "git+https://github.com/facebookresearch/vggt.git"

#: Non-torch, non-numpy runtime dependencies of each git package.
ML_SHARP_DEPS = (
    "scipy",
    "matplotlib",
    "imageio[ffmpeg]",
    "pillow-heif",
    "plyfile",
    "timm",
    "gsplat",
    "click",
    "ply2splat",
)
VGGT_DEPS = (
    "Pillow",
    "huggingface_hub",
    "einops",
    "safetensors",
    "opencv-python-headless",
)


def _numpy_constraints_file():
    """Writes a pip constraints file pinning numpy to the installed version."""
    numpy_version = importlib.metadata.version("numpy")
    fd, path = tempfile.mkstemp(prefix="swarm-numpy-", suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(f"numpy=={numpy_version}\n")
    return path


def pip_install(*packages, requirements=None, upgrade=False, no_deps=False):
    constraints = _numpy_constraints_file()
    try:
        args = [sys.executable, "-m", "pip", "install", "--quiet", "-c", constraints]
        if upgrade:
            args.append("--upgrade")
        if no_deps:
            args.append("--no-deps")
        args.extend(packages)
        if requirements:
            args.extend(["-r", requirements])
        subprocess.run(args, check=True)
    finally:
        os.remove(constraints)


def _installed_version(package):
    """Returns the installed distribution version, or None if the package is absent."""
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


def ensure_pinned_scientific_stack(upgrade=False):
    """Installs the newest SciPy/OpenCV compatible with Swarm's numpy."""
    missing = [pkg for pkg in SCIENTIFIC_PACKAGES if _installed_version(pkg) is None]
    if not missing:
        return
    try:
        pip_install(*missing, upgrade=upgrade)
    except subprocess.CalledProcessError as exc:
        print(
            f"[SharpSplat] Warning: could not install scientific stack "
            f"({', '.join(missing)}): {exc}. Continuing with existing packages.",
            file=sys.stderr,
        )


def install_model(package, deps):
    """Installs a git package's dependencies, then the package itself with --no-deps."""
    if deps:
        pip_install(*deps)
    pip_install(package, no_deps=True)


def install_sharp():
    """Installs Apple ml-sharp (and ply2splat) and their dependencies."""
    install_model(ML_SHARP_PACKAGE, ML_SHARP_DEPS)


def install_vggt():
    """Installs VGGT and its dependencies."""
    install_model(VGGT_PACKAGE, VGGT_DEPS)


def install_all():
    """Best-effort install of every SharpSplat git package"""
    failures = []
    for name, installer in (("ml-sharp", install_sharp), ("VGGT", install_vggt)):
        try:
            installer()
        except Exception as exc:  # noqa: BLE001 - report and continue
            print(f"[SharpSplat] Failed to install {name}: {exc}", file=sys.stderr)
            failures.append(name)
    if failures:
        raise RuntimeError(f"Failed to install: {', '.join(failures)}")
