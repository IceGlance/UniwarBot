from __future__ import annotations

import json
import re
import ssl
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "webgui" / "public" / "gui-assets"
UNIT_OUTPUT = OUTPUT / "units"
TERRAIN_OUTPUT = OUTPUT / "terrains"
DICTIONARY_PATH = ROOT / "data" / "validated" / "game-dictionary.json"
BASE_URL = "https://unicalc.github.io/web/assets"

TERRAIN_SOURCE_NAMES: dict[str, str] = {
    "plain": "plain",
    "base": "base",
    "city": "city",
    "medical": "medical",
    "forest": "forest",
    "mountain": "mountain",
    "desert": "desert",
    "swamp": "swamp",
    "chasm": "chasm",
    "road_land": "road",
    "road_water": "bridge",
    "harbor": "harbor",
    "water": "water",
    "reef": "reef",
    "ocean": "ocean",
}


def load_unit_ids() -> list[str]:
    data = json.loads(DICTIONARY_PATH.read_text(encoding="utf-8"))
    return sorted(str(unit_id) for unit_id in data["units"])


def unit_filename(unit_id: str) -> str:
    normalized = unit_id.lower()
    normalized = normalized.replace("mecha_ii", "mecha_2")
    normalized = re.sub(r"[^a-z0-9_]+", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized).strip("_")
    return f"{normalized}.png"


def download_file(url: str, destination: Path) -> None:
    context = ssl.create_default_context()
    with urllib.request.urlopen(url, context=context) as response:
        destination.write_bytes(response.read())


def download_units() -> None:
    UNIT_OUTPUT.mkdir(parents=True, exist_ok=True)
    for unit_id in load_unit_ids():
        filename = unit_filename(unit_id)
        download_file(f"{BASE_URL}/units/{filename}", UNIT_OUTPUT / filename)


def download_terrains() -> None:
    TERRAIN_OUTPUT.mkdir(parents=True, exist_ok=True)
    for local_name, remote_name in TERRAIN_SOURCE_NAMES.items():
        download_file(f"{BASE_URL}/terrain/{remote_name}.png", TERRAIN_OUTPUT / f"{local_name}.png")


def main() -> None:
    download_units()
    download_terrains()
    print(f"Downloaded UniCalc assets into {OUTPUT}")


if __name__ == "__main__":
    main()
