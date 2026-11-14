#!/usr/bin/env python3
from pathlib import Path

from proximetria_data import read_json, site_key_from_index

ROOT = Path(__file__).resolve().parents[1]
index = read_json(ROOT / "dados" / "sitios_brasil.json", [])
details = read_json(ROOT / "dados" / "sitios_brasil_detalhes.json", {})
meta = read_json(ROOT / "dados" / "sitios_brasil.meta.json", {})

if not isinstance(index, list):
    raise SystemExit("ERRO: sitios_brasil.json não é uma lista")
if not isinstance(details, dict):
    raise SystemExit("ERRO: sitios_brasil_detalhes.json não é um objeto")

keys = [site_key_from_index(x) for x in index]
if len(keys) != len(set(keys)):
    raise SystemExit("ERRO: há chaves duplicadas no índice")

bad_coords = 0
for r in index:
    coord = r.get("coordinates")
    if coord is None:
        bad_coords += 1
        continue
    if not isinstance(coord, list) or len(coord) < 2:
        raise SystemExit(f"ERRO: coordenadas inválidas em {site_key_from_index(r)}")
    lon, lat = coord[:2]
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise SystemExit(f"ERRO: coordenadas fora do intervalo em {site_key_from_index(r)}")

print(f"OK: {len(index)} registros; {bad_coords} sem coordenadas; meta.estado={meta.get('estado')}")
