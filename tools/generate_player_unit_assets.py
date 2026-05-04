from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "webgui" / "public" / "gui-assets" / "units"
OUTPUT_DIRS = {
    "red": ROOT / "webgui" / "public" / "gui-assets" / "units-red",
    "blue": ROOT / "webgui" / "public" / "gui-assets" / "units-blue",
}
TARGET_HUES = {
    "red": 0,
    "blue": 153,
}


def recolor_sprite(source_path: Path, output_path: Path, target_hue: int) -> None:
    image = Image.open(source_path).convert("RGBA")
    alpha = image.getchannel("A")
    hsv = image.convert("HSV")
    hue_band, saturation_band, value_band = hsv.split()

    hue_band = Image.new("L", image.size, color=target_hue)
    saturation_band = saturation_band.point(lambda value: max(value, 132))

    recolored_hsv = Image.merge("HSV", (hue_band, saturation_band, value_band))
    recolored = recolored_hsv.convert("RGBA")
    recolored.putalpha(alpha)

    recolored = ImageEnhance.Contrast(recolored).enhance(1.12)
    recolored = ImageEnhance.Sharpness(recolored).enhance(1.3)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    recolored.save(output_path)


def main() -> None:
    png_files = sorted(SOURCE_DIR.glob("*.png"))
    if not png_files:
        raise SystemExit(f"No source PNG files found in {SOURCE_DIR}")
    for palette_name, target_dir in OUTPUT_DIRS.items():
        target_hue = TARGET_HUES[palette_name]
        for source_path in png_files:
            recolor_sprite(source_path, target_dir / source_path.name, target_hue)
    print(f"Generated {len(png_files)} red and blue player sprites.")


if __name__ == "__main__":
    main()
