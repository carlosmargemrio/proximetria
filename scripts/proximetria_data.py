from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

VALID_UFS = {
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
    "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
    "SP", "SE", "TO",
}

HELP_IMAGE_RE = re.compile(r"(?:^|/)help\.gif(?:$|\?)", re.I)


@dataclass
class BuiltData:
    index: list[dict[str, Any]]
    details: dict[str, dict[str, Any]]
    stats: dict[str, int]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: Any) -> Any:
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json_atomic(path: Path, data: Any, *, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as fh:
        if compact:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    tmp.replace(path)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def site_key_from_index(record: dict[str, Any]) -> str:
    if record.get("id_bem") not in (None, ""):
        return str(record["id_bem"])
    if record.get("co_iphan"):
        return f"co:{record['co_iphan']}"
    coord = record.get("coordinates") or []
    return f"coord:{','.join(map(str, coord))}:{record.get('identificacao_bem') or ''}"


def feature_key(feature: dict[str, Any]) -> str:
    props = feature.get("properties") or {}
    if props.get("id_bem") not in (None, ""):
        return str(props["id_bem"])
    if props.get("co_iphan"):
        return f"co:{props['co_iphan']}"
    fid = feature.get("id")
    if fid:
        return f"fid:{fid}"
    geom = feature.get("geometry") or {}
    coords = geom.get("coordinates") or []
    return f"coord:{','.join(map(str, coords))}:{props.get('identificacao_bem') or ''}"


def normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_number(value: Any) -> int | float | None:
    if value in (None, ""):
        return None
    try:
        num = float(value)
        return int(num) if num.is_integer() else num
    except (TypeError, ValueError):
        return None


def normalize_coords(feature: dict[str, Any]) -> list[float] | None:
    geom = feature.get("geometry") or {}
    coords = geom.get("coordinates")
    if not isinstance(coords, (list, tuple)) or len(coords) < 2:
        return None
    try:
        lon = float(coords[0])
        lat = float(coords[1])
    except (TypeError, ValueError):
        return None

    # GeoJSON é x/y (lon/lat), mas alguns serviços WFS podem expor ordem de eixos
    # influenciada pelo CRS. Se o par tiver a assinatura típica de Brasil invertido
    # (primeiro valor parece latitude e o segundo longitude), corrige com segurança.
    if -35.5 <= lon <= 6.5 and -74.5 <= lat <= -19.0:
        lon, lat = lat, lon

    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        return None
    return [round(lon, 8), round(lat, 8)]


def infer_uf(co_iphan: Any) -> str | None:
    text = normalize_text(co_iphan)
    if not text or len(text) < 2:
        return None
    uf = text[:2].upper()
    return uf if uf in VALID_UFS else None


def clean_image_url(value: Any) -> str | None:
    text = normalize_text(value)
    if not text or HELP_IMAGE_RE.search(text):
        return None
    return text


def build_data(features: Iterable[dict[str, Any]]) -> BuiltData:
    index: list[dict[str, Any]] = []
    details: dict[str, dict[str, Any]] = {}
    seen: set[str] = set()
    sem_coord = sem_mun = com_foto = 0

    for feature in features:
        if not isinstance(feature, dict):
            continue
        props = feature.get("properties") or {}
        key = feature_key(feature)
        if key in seen:
            continue
        seen.add(key)

        coords = normalize_coords(feature)
        municipio = normalize_text(props.get("municipio"))
        image_url = clean_image_url(props.get("imagem_url"))
        if coords is None:
            sem_coord += 1
        if municipio is None:
            sem_mun += 1
        if image_url:
            com_foto += 1

        record = {
            "id_bem": normalize_number(props.get("id_bem")),
            "co_iphan": normalize_text(props.get("co_iphan")),
            "identificacao_bem": normalize_text(props.get("identificacao_bem")),
            "municipio": municipio,
            "uf": infer_uf(props.get("co_iphan")),
            "coordinates": coords,
            "ds_classificacao": normalize_text(props.get("ds_classificacao")),
            "dt_cadastro": normalize_text(props.get("dt_cadastro")),
            "tem_foto": bool(image_url),
        }
        index.append(record)

        details[site_key_from_index(record)] = {
            "sintese_bem": normalize_text(props.get("sintese_bem")),
            "imagem_url": image_url,
            "no_logradouro": normalize_text(props.get("no_logradouro")),
            "nu_logradouro": normalize_text(props.get("nu_logradouro")),
            "ds_natureza": normalize_text(props.get("ds_natureza")),
            "codigo_iphan": normalize_text(props.get("codigo_iphan")),
            "ds_classificacao": normalize_text(props.get("ds_classificacao")),
            "ds_tipo_bem": normalize_text(props.get("ds_tipo_bem")),
            "sg_tipo_bem": normalize_text(props.get("sg_tipo_bem")),
        }

    index.sort(key=lambda r: (r.get("uf") or "", r.get("municipio") or "", r.get("identificacao_bem") or "", site_key_from_index(r)))
    stats = {
        "total_registros": len(index),
        "sem_coordenadas": sem_coord,
        "sem_municipio": sem_mun,
        "com_fotografia": com_foto,
    }
    return BuiltData(index=index, details=details, stats=stats)


def record_fingerprint(index_record: dict[str, Any], detail_record: dict[str, Any] | None = None) -> str:
    payload = {"i": index_record, "d": detail_record or {}}
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def compare_bases(
    old_index: list[dict[str, Any]],
    old_details: dict[str, dict[str, Any]],
    new_index: list[dict[str, Any]],
    new_details: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], int]:
    if not old_index:
        return [], 0

    old_map = {site_key_from_index(r): r for r in old_index}
    new_map = {site_key_from_index(r): r for r in new_index}
    new_sites = [new_map[k] for k in new_map.keys() - old_map.keys()]
    new_sites.sort(key=lambda r: site_key_from_index(r))

    changed = 0
    for key in new_map.keys() & old_map.keys():
        if record_fingerprint(old_map[key], old_details.get(key)) != record_fingerprint(new_map[key], new_details.get(key)):
            changed += 1
    return new_sites, changed


def validate_new_base(new: BuiltData, old_count: int = 0) -> None:
    total = new.stats["total_registros"]
    if total < 1000:
        raise ValueError(f"Base recusada: apenas {total} registros. O esperado é uma base nacional.")
    if old_count and total < int(old_count * 0.90):
        raise ValueError(f"Base recusada: caiu de {old_count} para {total} registros (>10%).")
    with_coords = total - new.stats["sem_coordenadas"]
    if with_coords / total < 0.90:
        raise ValueError("Base recusada: menos de 90% dos registros têm coordenadas válidas.")


def file_metadata(paths: Iterable[Path]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for path in paths:
        if path.exists():
            out[path.name] = {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
    return out
