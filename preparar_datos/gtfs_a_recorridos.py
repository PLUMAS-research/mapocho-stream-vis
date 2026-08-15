"""Deriva desde el feed GTFS de DTPM la estructura de la red de buses (Red) como
un conjunto de polilíneas, para dibujarla como capa de contexto en el frontend.

  - src/json/LineasBuses.json : lista de recorridos [[lon, lat], ...].

A diferencia del campo vectorial (que muestra el flujo de los viajes con demanda),
esta capa muestra la traza física de la red: por dónde pasan las líneas de bus,
tengan o no demanda en una hora dada. Se toma de shapes.txt las geometrías de las
rutas de bus (route_type 3), se deduplican, se simplifican y se recortan al bbox
de la grilla para acotar el tamaño del archivo.

Uso:
    uv run python gtfs_a_recorridos.py                 # usa el GTFS cacheado
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

# route_type 3 = bus en la especificación GTFS.
ROUTE_TYPE_BUS = "3"

# Tolerancia de simplificación (grados). ~0.0003° ≈ 30 m en Santiago. Baja los
# puntos por recorrido sin deformar la traza a la escala del mapa.
TOLERANCIA_SIMPLIFICACION = 0.0003
# Decimales de las coordenadas en el JSON (5 ≈ 1 m). Menos peso de archivo.
DECIMALES = 5


def _leer_csv(zf, nombre):
    with zf.open(nombre) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


def shapes_de_buses(zip_path):
    """Devuelve las polilíneas [[lon, lat], ...] de los shape_id usados por rutas
    de bus, ordenadas por shape_pt_sequence."""
    with zipfile.ZipFile(zip_path) as zf:
        routes = _leer_csv(zf, "routes.txt")
        trips = _leer_csv(zf, "trips.txt")
        # shapes.txt es grande: se lee en streaming, agrupando por shape_id.
        rutas_bus = {r["route_id"] for r in routes if r["route_type"] == ROUTE_TYPE_BUS}
        shapes_bus = {t["shape_id"] for t in trips
                      if t["route_id"] in rutas_bus and t.get("shape_id")}
        print(f"[buses] rutas bus: {len(rutas_bus)}, shape_id únicos: {len(shapes_bus)}")

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
    """Simplifica cada polilínea, la recorta al bbox de la grilla y deduplica.
    Devuelve la lista de recorridos [[lon, lat], ...] con coordenadas redondeadas."""
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
        # El recorte puede ser una LineString o una MultiLineString.
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

    ap = argparse.ArgumentParser(description="Deriva la red de buses (polilíneas) desde GTFS.")
    ap.add_argument("--gtfs-url", default=os.environ.get("GTFS_URL", GTFS_URL_DEFAULT))
    ap.add_argument("--gtfs-zip", default=None,
                    help="Ruta a un GTFS local; si se da, no se descarga.")
    ap.add_argument("--cache-dir", default=os.environ.get("GTFS_CACHE", str(aqui / ".gtfs_cache")),
                    help="Dónde guardar/buscar el zip GTFS descargado.")
    ap.add_argument("--salida-dir", default=str(src_json_def),
                    help="Directorio src/json donde escribir LineasBuses.json.")
    ap.add_argument("--diametro", default="02", help="Sufijo de diámetro de la grilla (para el bbox).")
    args = ap.parse_args()

    salida = Path(args.salida_dir)
    grilla_path = salida / f"Hexagon{args.diametro}.json"
    if not grilla_path.exists():
        raise SystemExit(f"Falta la grilla {grilla_path}. Corre antes CreacionGrilla.py.")

    zip_path = Path(args.gtfs_zip) if args.gtfs_zip else descargar_gtfs(args.gtfs_url, args.cache_dir)

    with open(grilla_path, encoding="utf-8") as f:
        grilla = json.load(f)

    polilineas = shapes_de_buses(zip_path)
    recorridos = simplificar_y_recortar(polilineas, grilla)
    n_puntos = sum(len(r) for r in recorridos)
    print(f"[buses] recorridos tras simplificar/recortar/deduplicar: {len(recorridos)} "
          f"({n_puntos} puntos)")

    ruta_salida = salida / "LineasBuses.json"
    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump({"recorridos": recorridos}, f, ensure_ascii=False)
    tam_kb = ruta_salida.stat().st_size // 1024
    print(f"[buses] {ruta_salida}: {len(recorridos)} recorridos ({tam_kb} KB)")
    print("[ok] red de buses generada desde GTFS.")


if __name__ == "__main__":
    main()
