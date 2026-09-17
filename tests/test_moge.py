import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ComfyNodes"))
from MoGeSplatNode import SharpSplatMoGeToSplat


class MoGeSplatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        api = types.ModuleType("comfy_api.latest")
        api.Types = types.SimpleNamespace(SPLAT=lambda **values: types.SimpleNamespace(**values))
        api_patch = patch.dict(sys.modules, {"comfy_api.latest": api})
        api_patch.start()
        cls.addClassCleanup(api_patch.stop)

    def setUp(self):
        self.geometry = {
            "points": torch.tensor([[[[0.0, 0.0, 1.0], [0.1, 0.0, 1.0]], [[0.0, 0.1, 1.0], [0.1, 0.1, 1.0]]]]),
            "image": torch.full((1, 2, 2, 3), 0.75),
            "mask": torch.ones((1, 2, 2), dtype=torch.bool),
        }

    def test_gaussian_attributes(self):
        splat, = SharpSplatMoGeToSplat().convert(self.geometry)
        self.assertEqual(splat.positions.shape, (1, 4, 3))
        self.assertEqual(splat.sh.shape, (1, 4, 1, 3))
        torch.testing.assert_close(splat.scales, torch.full((1, 4, 3), 0.06))
        torch.testing.assert_close(splat.opacities, torch.full((1, 4, 1), 0.95))
        torch.testing.assert_close(splat.rotations.norm(dim=-1), torch.ones((1, 4)))
        torch.testing.assert_close(splat.sh * 0.28209479177387814 + 0.5, torch.full((1, 4, 1, 3), 0.75))

    def test_invalid_points_are_removed(self):
        for invalid in (float("inf"), float("nan"), -1.0, 0.0):
            with self.subTest(invalid=invalid):
                self.geometry["points"][0, 0, 0, 2] = invalid
                splat, = SharpSplatMoGeToSplat().convert(self.geometry)
                self.assertEqual(splat.positions.shape[1], 3)
                self.assertTrue(torch.isfinite(splat.scales).all())

    def test_mask_is_respected(self):
        self.geometry["mask"][0, 0, 0] = False
        splat, = SharpSplatMoGeToSplat().convert(self.geometry)
        self.assertEqual(splat.positions.shape[1], 3)

    def test_scale_tracks_geometry_units(self):
        self.geometry["points"] *= 10
        splat, = SharpSplatMoGeToSplat().convert(self.geometry)
        torch.testing.assert_close(splat.scales, torch.full((1, 4, 3), 0.6))

    def test_empty_and_degenerate_geometry_fail(self):
        self.geometry["mask"].fill_(False)
        with self.assertRaisesRegex(ValueError, "no valid points"):
            SharpSplatMoGeToSplat().convert(self.geometry)
        self.geometry["mask"].fill_(True)
        self.geometry["points"].fill_(1)
        with self.assertRaisesRegex(ValueError, "no neighboring valid points"):
            SharpSplatMoGeToSplat().convert(self.geometry)

    def test_mismatched_image_fails(self):
        self.geometry["image"] = torch.zeros((1, 3, 3, 3))
        with self.assertRaisesRegex(ValueError, "dimensions do not match"):
            SharpSplatMoGeToSplat().convert(self.geometry)


if __name__ == "__main__":
    unittest.main()