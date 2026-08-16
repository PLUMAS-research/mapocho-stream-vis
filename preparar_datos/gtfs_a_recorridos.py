"""Derives the bus network structure (Red) from the GTFS feed as a set of
polylines, to draw it as a context layer in the frontend.

  - src/json/LineasBuses.json : list of routes [[lon, lat], ...].

Unlike the vector field (which shows the flow of trips with demand), this
layer shows the physical trace of the network: where the bus lines run,
whether or not they carry demand at a given hour. The bus route geometries
(route_type 3) are taken from shapes.txt, deduplicated, simplified, and
clipped to the grid bbox to bound the file size.

Usage:
    uv run python gtfs_a_recorridos.py                 # uses the cached GTFS
    uv run python gtfs_a_recorridos.py --gtfs-zip x.zip
    GTFS_URL=... uv run python gtfs_a_recorridos.py
"""

import argparse
import csv
import io
import json
import os
import zipfile
from collections import defaultdict
from pathlib import Path

from shapely.geometry import LineString, box

from gtfs_a_metro import GTFS_URL_DEFAULT, descargar_gtfs

# route_type 3 = bus in the GTFS specification.
ROUTE_TYPE_BUS = "3"

# Simplification tolerance (degrees). ~0.0003 deg is ~30 m in Santiago. It
# reduces the points per route without deforming the trace at map scale.
TOLERANCIA_SIMPLIFICACION = 0.0003
# Coordinate decimals in the JSON (5 is ~1 m). Smaller file.
DECIMALES = 5


def _leer_csv(zf, nombre):
    with zf.open(nombre) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


def shapes_de_buses(zip_path):
    """Returns the polylines [[lon, lat], ...] of the shape_ids used by bus
    routes, sorted by shape_pt_sequence."""
    with zipfile.ZipFile(zip_path) as zf:
        routes = _leer_csv(zf, "routes.txt")
        trips = _leer_csv(zf, "trips.txt")
        # shapes.txt is large: it is streamed, grouping by shape_id.
        rutas_bus = {r["route_id"] for r in routes if r["route_type"] == ROUTE_TYPE_BUS}
        shapes_bus = {t["shape_id"] for t in trips
                      if t["route_id"] in rutas_bus and t.get("shape_id")}
        print(f"[buses] bus routes: {len(rutas_bus)}, unique shape_ids: {len(shapes_bus)}")

        puntos = defaultdict(list)
        with zf.open("shapes.txt") as f:
            for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")):
                sid = row["shape_id"]
                if sid not in shapes_bus:
                    continue
                puntos[sid].append((
                    int(row["shape_pt_sequence"]),
                    float(row["shape_pt_lon"]),
                    float(row["shape_pt_lat"]),
                ))

    polilineas = []
    for sid, pts in puntos.items():
        pts.sort()
        polilineas.append([(lon, lat) for _, lon, lat in pts])
    return polilineas


def simplificar_y_recortar(polilineas, grilla):
    """Simplifies each polyline, clips it to the grid bbox, and deduplicates.
    Returns the list of routes [[lon, lat], ...] with rounded coordinates."""
    bbox = box(grilla["minLon"], grilla["minLat"], grilla["maxLon"], grilla["maxLat"])

    vistos = set()
    salida = []
    for pts in polilineas:
        if len(pts) < 2:
            continue
        linea = LineString(pts).simplify(TOLERANCIA_SIMPLIFICACION, preserve_topology=False)
        recorte = linea.intersection(bbox)
        if recorte.is_empty:
            continue
        # The clip can be a LineString or a MultiLineString.
        geoms = recorte.geoms if recorte.geom_type == "MultiLineString" else [recorte]
        for g in geoms:
            if g.geom_type != "LineString" or g.length == 0:
                continue
            coords = [[round(x, DECIMALES), round(y, DECIMALES)] for x, y in g.coords]
            if len(coords) < 2:
                continue
            clave = tuple(map(tuple, coords))
            if clave in vistos:
                continue
            vistos.add(clave)
            salida.append(coords)
    return salida


def main():
    aqui = Path(__file__).resolve().parent
    src_json_def = aqui.parent / "src" / "json"

    ap = argparse.ArgumentParser(description="Derives the bus network (polylines) from GTFS.")
    ap.add_argument("--gtfs-url", default=os.environ.get("GTFS_URL", GTFS_URL_DEFAULT))
    ap.add_argument("--gtfs-zip", default=None,
                    help="Path to a local GTFS; when given, nothing is downloaded.")
    ap.add_argument("--cache-dir", default=os.environ.get("GTFS_CACHE", str(aqui / ".gtfs_cache")),
                    help="Where to store/look for the downloaded GTFS zip.")
    ap.add_argument("--salida-dir", default=str(src_json_def),
                    help="src/json directory where LineasBuses.json is written.")
    ap.add_argument("--resolucion", default=os.environ.get("RESOLUCION_H3", "9"),
                    help="H3 resolution of the grid (suffix of Hexagon_r<res>.json, for the bbox).")
    args = ap.parse_args()

    salida = Path(args.salida_dir)
    grilla_path = salida / f"Hexagon_r{args.resolucion}.json"
    if not grilla_path.exists():
        raise SystemExit(f"Missing grid {grilla_path}. Run CreacionGrilla.py first.")

    zip_path = Path(args.gtfs_zip) if args.gtfs_zip else descargar_gtfs(args.gtfs_url, args.cache_dir)

    with open(grilla_path, encoding="utf-8") as f:
        grilla = json.load(f)

    polilineas = shapes_de_buses(zip_path)
    recorridos = simplificar_y_recortar(polilineas, grilla)
    n_puntos = sum(len(r) for r in recorridos)
    print(f"[buses] routes after simplify/clip/dedupe: {len(recorridos)} "
          f"({n_puntos} points)")

    ruta_salida = salida / "LineasBuses.json"
    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump({"recorridos": recorridos}, f, ensure_ascii=False)
    tam_kb = ruta_salida.stat().st_size // 1024
    print(f"[buses] {ruta_salida}: {len(recorridos)} routes ({tam_kb} KB)")
    print("[ok] bus network generated from GTFS.")


if __name__ == "__main__":
    main()
