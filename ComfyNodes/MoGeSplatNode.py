import torch


class SharpSplatMoGeToSplat:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"moge_geometry": ("MOGE_GEOMETRY",)}}

    CATEGORY = "SharpSplat"
    RETURN_TYPES = ("SPLAT",)
    FUNCTION = "convert"

    def convert(self, moge_geometry):
        from comfy_api.latest import Types

        points = moge_geometry["points"][0].detach().float().cpu()
        colors = moge_geometry["image"][0, ..., :3].detach().float().cpu()
        valid = torch.isfinite(points).all(dim=-1) & (points[..., 2] > 0)
        if "mask" in moge_geometry:
            valid &= moge_geometry["mask"][0].detach().bool().cpu()
        if colors.shape != points.shape:
            raise ValueError("MoGe point map and image dimensions do not match.")
        valid &= torch.isfinite(colors).all(dim=-1)
        if not valid.any():
            raise ValueError("MoGe produced no valid points for Gaussian export.")

        spacing = torch.full(valid.shape, float("inf"))
        horizontal = (points[:, 1:] - points[:, :-1]).norm(dim=-1)
        vertical = (points[1:] - points[:-1]).norm(dim=-1)
        horizontal = torch.where(valid[:, 1:] & valid[:, :-1] & (horizontal > 0), horizontal, float("inf"))
        vertical = torch.where(valid[1:] & valid[:-1] & (vertical > 0), vertical, float("inf"))
        spacing[:, 1:] = torch.minimum(spacing[:, 1:], horizontal)
        spacing[:, :-1] = torch.minimum(spacing[:, :-1], horizontal)
        spacing[1:] = torch.minimum(spacing[1:], vertical)
        spacing[:-1] = torch.minimum(spacing[:-1], vertical)
        usable = valid & torch.isfinite(spacing)
        if not usable.any():
            raise ValueError("MoGe produced no neighboring valid points for Gaussian export.")
        typical_spacing = spacing[usable].median()
        scales = torch.where(torch.isfinite(spacing[valid]), spacing[valid], typical_spacing)
        scales = (scales * 0.6).clamp(min=1e-6, max=max(float(typical_spacing) * 4, 1e-6))
        positions = points[valid]
        rotations = torch.zeros((positions.shape[0], 4))
        rotations[:, 0] = 1
        splat = Types.SPLAT(
            positions=positions.unsqueeze(0),
            scales=scales[:, None].expand(-1, 3).contiguous().unsqueeze(0),
            rotations=rotations.unsqueeze(0),
            opacities=torch.full((1, positions.shape[0], 1), 0.95),
            sh=((colors[valid].clamp(0, 1) - 0.5) / 0.28209479177387814)[None, :, None, :],
        )
        return (splat,)


NODE_CLASS_MAPPINGS = {"SharpSplatMoGeToSplat": SharpSplatMoGeToSplat}