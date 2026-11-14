#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from proximetria_data import (
    build_data,
    compare_bases,
    file_metadata,
    read_json,
    utc_now_iso,
    write_json_atomic,
)

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "dados"
INDEX_PATH = DATA_DIR / "sitios_brasil.json"
DETAILS_PATH = DATA_DIR / "sitios_brasil_detalhes.json"
META_PATH = DATA_DIR / "sitios_brasil.meta.json"
NEW_PATH = DATA_DIR / "novos_sitios.json"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Converte um GeoJSON/JSON bruto já baixado do SICG para o formato compacto da ProxiMetria.")
    p.add_argument("arquivo", type=Path, help="Ex.: resultado_imagens8.json")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    with args.arquivo.open("r", encoding="utf-8-sig") as fh:
        raw = json.load(fh)

    features = raw.get("features") if isinstance(raw, dict) else raw
    if not isinstance(features, list):
        raise SystemExit("O arquivo precisa ser uma FeatureCollection GeoJSON ou uma lista de feições.")

    old_index = read_json(INDEX_PATH, [])
    old_details = read_json(DETAILS_PATH, {})
    built = build_data(features)
    if not built.index:
        raise SystemExit("Nenhum registro válido foi encontrado no arquivo.")

    new_sites, changed = compare_bases(old_index, old_details, built.index, built.details)
    write_json_atomic(INDEX_PATH, built.index)
    write_json_atomic(DETAILS_PATH, built.details)
    write_json_atomic(NEW_PATH, new_sites)

    now = utc_now_iso()
    meta = {
        "schema_version": 1,
        "estado": "ok_importacao_local",
        "fonte": f"Importação local de {args.arquivo.name}",
        "ultima_consulta_utc": None,
        "ultima_atualizacao_utc": now,
        **built.stats,
        "novos_desde_ultima": len(new_sites),
        "alterados_desde_ultima": changed,
        "primeira_carga": not bool(old_index),
    }
    write_json_atomic(META_PATH, meta, compact=False)
    meta["arquivos"] = file_metadata([INDEX_PATH, DETAILS_PATH, NEW_PATH])
    write_json_atomic(META_PATH, meta, compact=False)

    print(f"Registros: {built.stats['total_registros']}")
    print(f"Sem coordenadas: {built.stats['sem_coordenadas']}")
    print(f"Sem município: {built.stats['sem_municipio']}")
    print(f"Com fotografia: {built.stats['com_fotografia']}")
    print(f"Índice: {INDEX_PATH.stat().st_size / 1024 / 1024:.2f} MiB")
    print(f"Detalhes: {DETAILS_PATH.stat().st_size / 1024 / 1024:.2f} MiB")
    print("Importação concluída. ultima_consulta_utc ficou vazia para permitir uma atualização imediata do GeoServer.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
