import traceback

NODE_CLASS_MAPPINGS = {}

try:
    from . import SharpSplatNode
    NODE_CLASS_MAPPINGS.update(SharpSplatNode.NODE_CLASS_MAPPINGS)
except Exception:
    print("Error: [SharpSplat] SharpSplatNode not available")
    traceback.print_exc()
