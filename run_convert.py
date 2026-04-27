"""Convert a Gaussian Splat PLY file to the compact .splat binary format.

Usage:
    python run_convert.py <input.ply> <output.splat>

Used by the SwarmUI SharpSplat extension after ml-sharp generates a PLY file.
The .splat format is a packed 32-byte-per-splat binary that gsplat.js can load
without any property-type parsing issues.
"""
import sys
import ply2splat

if len(sys.argv) != 3:
    print(f"Usage: {sys.argv[0]} <input.ply> <output.splat>", file=sys.stderr)
    sys.exit(1)

input_ply = sys.argv[1]
output_splat = sys.argv[2]

count = ply2splat.convert(input_ply, output_splat)
print(f"Converted {count} splats to {output_splat}")
