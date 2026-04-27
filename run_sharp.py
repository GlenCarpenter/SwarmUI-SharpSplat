"""Thin wrapper that invokes the ml-sharp CLI entry point.
Used by SwarmUI SharpSplat extension to call 'sharp predict' via the
Python environment managed by SwarmUI, without relying on the 'sharp'
script being on PATH.
"""
from sharp.cli import main_cli

main_cli()
