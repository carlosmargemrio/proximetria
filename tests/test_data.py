import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from proximetria_data import build_data, compare_bases, site_key_from_index  # noqa: E402


def test_build_sample():
    raw = json.loads((ROOT / "tests" / "fixtures" / "sample.geojson").read_text(encoding="utf-8"))
    built = build_data(raw["features"])
    assert built.stats["total_registros"] == 2
    assert built.stats["com_fotografia"] == 1
    assert built.stats["sem_coordenadas"] == 0
    assert built.index[0]["uf"] in {"PI", "PE"}
    assert len({site_key_from_index(x) for x in built.index}) == 2


def test_compare():
    raw = json.loads((ROOT / "tests" / "fixtures" / "sample.geojson").read_text(encoding="utf-8"))
    built = build_data(raw["features"])
    new_sites, changed = compare_bases(built.index, built.details, built.index, built.details)
    assert new_sites == []
    assert changed == 0
