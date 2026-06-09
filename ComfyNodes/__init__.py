import traceback

NODE_CLASS_MAPPINGS = {}

try:
    from . import SharpSplatNode
    NODE_CLASS_MAPPINGS.update(SharpSplatNode.NODE_CLASS_MAPPINGS)
except Exception:
    print("Error: [SharpSplat] SharpSplatNode not available")
    traceback.print_exc()

try:
    from . import VGGTSplatNode
    NODE_CLASS_MAPPINGS.update(VGGTSplatNode.NODE_CLASS_MAPPINGS)
except Exception:
    print("Error: [SharpSplat] VGGTSplatNode not available")
    traceback.print_exc()

try:
    from . import InstantSplatNode
    NODE_CLASS_MAPPINGS.update(InstantSplatNode.NODE_CLASS_MAPPINGS)
except Exception:
    print("Error: [SharpSplat] InstantSplatNode not available")
    traceback.print_exc()

try:
    from . import TripoSplatNode
    NODE_CLASS_MAPPINGS.update(TripoSplatNode.NODE_CLASS_MAPPINGS)
except Exception:
    print("Error: [SharpSplat] TripoSplatNode not available")
    traceback.print_exc()
