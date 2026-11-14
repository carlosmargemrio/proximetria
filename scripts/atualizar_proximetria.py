#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from proximetria_data import (
    build_data,
    compare_bases,
    file_metadata,
    read_json,
    utc_now_iso,
    validate_new_base,
    write_json_atomic,
)

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "dados"
INDEX_PATH = DATA_DIR / "sitios_brasil.json"
DETAILS_PATH = DATA_DIR / "sitios_brasil_detalhes.json"
META_PATH = DATA_DIR / "sitios_brasil.meta.json"
NEW_PATH = DATA_DIR / "novos_sitios.json"

DEFAULT_ENDPOINTS = [
    "https://portal.iphan.gov.br/geoserver/SICG/ows",
    "http://portal.iphan.gov.br/geoserver/SICG/ows",
    "http://portal.iphan.gov.br/geoserver/wfs",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Atualiza a base estática da ProxiMetria a partir do WFS SICG/IPHAN.")
    p.add_argument("--force", action="store_true", help="Ignora o intervalo mínimo e consulta o GeoServer agora.")
    p.add_argument("--min-hours", type=float, default=48.0, help="Intervalo mínimo entre consultas bem-sucedidas ao GeoServer.")
    p.add_argument("--page-size", type=int, default=2000, help="Quantidade de feições por página WFS 2.0.")
    p.add_argument("--endpoint", action="append", default=[], help="Endpoint WFS alternativo. Pode ser repetido.")
    return p.parse_args()


def parse_iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def due_for_update(meta: dict[str, Any], min_hours: float) -> tuple[bool, str]:
    last = parse_iso(meta.get("ultima_consulta_utc"))
    if not last:
        return True, "nenhuma consulta anterior registrada"
    now = datetime.now(timezone.utc)
    next_allowed = last + timedelta(hours=min_hours)
    if now >= next_allowed:
        return True, f"intervalo mínimo de {min_hours:g} h transcorrido"
    remaining = next_allowed - now
    hours = remaining.total_seconds() / 3600
    return False, f"faltam aproximadamente {hours:.1f} h para completar {min_hours:g} h"


def make_session() -> requests.Session:
    retry = Retry(
        total=4,
        connect=4,
        read=4,
        backoff_factor=1.2,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET"]),
        raise_on_status=False,
    )
    session = requests.Session()
    session.headers.update({
        "User-Agent": "ProxiMetria/1.0 (+GitHub Actions; dados publicos SICG/IPHAN)",
        "Accept": "application/json,application/geo+json;q=0.9,*/*;q=0.1",
    })
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.mount("http://", HTTPAdapter(max_retries=retry))
    return session


def get_json(session: requests.Session, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
    response = session.get(endpoint, params=params, timeout=(20, 180))
    response.raise_for_status()
    try:
        data = response.json()
    except json.JSONDecodeError as exc:
        snippet = response.text[:250].replace("\n", " ")
        raise RuntimeError(f"Resposta não-JSON de {endpoint}: {snippet}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("features"), list):
        raise RuntimeError(f"Resposta WFS sem FeatureCollection válida em {endpoint}")
    return data


def fetch_wfs2_paged(session: requests.Session, endpoint: str, page_size: int) -> list[dict[str, Any]]:
    features: list[dict[str, Any]] = []
    start = 0
    previous_signature: tuple[Any, Any, int] | None = None

    while True:
        params = {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "SICG:sitios",
            "outputFormat": "application/json",
            "srsName": "EPSG:4326",
            "count": page_size,
            "startIndex": start,
        }
        data = get_json(session, endpoint, params)
        page = data.get("features", [])
        if not page:
            break

        signature = (page[0].get("id"), page[-1].get("id"), len(page))
        if start > 0 and signature == previous_signature:
            raise RuntimeError("O servidor ignorou startIndex; paginação WFS 2.0 não é confiável neste endpoint.")
        previous_signature = signature
        features.extend(page)
        print(f"  WFS 2.0: {len(features):,} feições recebidas", flush=True)

        matched_raw = data.get("numberMatched")
        try:
            matched = int(matched_raw)
        except (TypeError, ValueError):
            matched = None

        start += len(page)
        if matched is not None and start >= matched:
            break
        # Não encerramos apenas porque len(page) < page_size: o GeoServer pode
        # aplicar um limite interno menor que o count solicitado. A próxima página
        # confirma o fim da coleção.
        if start > 500_000:
            raise RuntimeError("Limite de segurança de paginação excedido.")

    if not features:
        raise RuntimeError("Nenhuma feição retornada pelo WFS 2.0.")
    return features


def fetch_wfs1_single(session: requests.Session, endpoint: str) -> list[dict[str, Any]]:
    params = {
        "service": "WFS",
        "version": "1.0.0",
        "request": "GetFeature",
        "typeName": "SICG:sitios",
        "outputFormat": "application/json",
        "srsName": "EPSG:4326",
        "maxFeatures": 2147483647,
    }
    data = get_json(session, endpoint, params)
    features = data.get("features", [])
    if not features:
        raise RuntimeError("Nenhuma feição retornada pelo WFS 1.0.")
    print(f"  WFS 1.0: {len(features):,} feições recebidas", flush=True)
    return features


def fetch_all(endpoints: list[str], page_size: int) -> tuple[list[dict[str, Any]], str, str]:
    session = make_session()
    errors: list[str] = []

    for endpoint in endpoints:
        try:
            print(f"Tentando WFS 2.0 paginado: {endpoint}")
            return fetch_wfs2_paged(session, endpoint, page_size), endpoint, "2.0.0"
        except Exception as exc:
            errors.append(f"{endpoint} WFS2: {exc}")
            print(f"  Falhou: {exc}", file=sys.stderr)

    for endpoint in endpoints:
        try:
            print(f"Tentando WFS 1.0 em carga única: {endpoint}")
            return fetch_wfs1_single(session, endpoint), endpoint, "1.0.0"
        except Exception as exc:
            errors.append(f"{endpoint} WFS1: {exc}")
            print(f"  Falhou: {exc}", file=sys.stderr)

    raise RuntimeError("Nenhum endpoint WFS respondeu adequadamente:\n- " + "\n- ".join(errors))


def main() -> int:
    args = parse_args()
    meta = read_json(META_PATH, {})

    if not args.force:
        due, reason = due_for_update(meta, args.min_hours)
        if not due:
            print(f"SKIP: GeoServer não consultado; {reason}.")
            return 0
        print(f"Atualização autorizada: {reason}.")
    else:
        print("Atualização forçada manualmente.")

    endpoints = args.endpoint or [x.strip() for x in os.getenv("PROXIMETRIA_WFS_ENDPOINTS", "").split(",") if x.strip()] or DEFAULT_ENDPOINTS
    features, endpoint_used, wfs_version = fetch_all(endpoints, max(100, args.page_size))

    old_index = read_json(INDEX_PATH, [])
    old_details = read_json(DETAILS_PATH, {})
    built = build_data(features)
    validate_new_base(built, old_count=len(old_index))
    new_sites, changed = compare_bases(old_index, old_details, built.index, built.details)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    write_json_atomic(INDEX_PATH, built.index)
    write_json_atomic(DETAILS_PATH, built.details)
    write_json_atomic(NEW_PATH, new_sites)

    now = utc_now_iso()
    new_meta = {
        "schema_version": 1,
        "estado": "ok",
        "fonte": "SICG/IPHAN — camada SICG:sitios",
        "endpoint": endpoint_used,
        "wfs_version": wfs_version,
        "ultima_consulta_utc": now,
        "ultima_atualizacao_utc": now,
        **built.stats,
        "novos_desde_ultima": len(new_sites),
        "alterados_desde_ultima": changed,
        "primeira_carga": not bool(old_index),
    }
    write_json_atomic(META_PATH, new_meta, compact=False)
    new_meta["arquivos"] = file_metadata([INDEX_PATH, DETAILS_PATH, NEW_PATH])
    write_json_atomic(META_PATH, new_meta, compact=False)

    print("Atualização concluída:")
    print(f"  Registros: {built.stats['total_registros']:,}")
    print(f"  Sem coordenadas: {built.stats['sem_coordenadas']:,}")
    print(f"  Sem município: {built.stats['sem_municipio']:,}")
    print(f"  Com fotografia: {built.stats['com_fotografia']:,}")
    print(f"  Novos desde a base anterior: {len(new_sites):,}")
    print(f"  Registros alterados: {changed:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
