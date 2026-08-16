# %%
# Generates the hexagonal grid with Uber's H3 indexing. Replaces the custom
# odd-r offset grid with equal-area H3 cells, which also enables
# multi-resolution via cell_to_parent in the future.
#
# The resolution is configurable with the RESOLUCION_H3 environment variable
# (default 9). Size reference over the Santiago bbox:
#   res 8  ~= 2,150 cells (edge ~461 m)
#   res 9  ~= 15,060 cells (edge ~174 m)
#   res 10 ~= 105,000 cells (edge ~66 m)
#
# Output: json/Hexagon_r<res>.json, minimal. Only the `celdas` array with the
# sorted H3 indices (the local id of each cell is its position in the array),
# plus resolucion, bbox, and numCeldas. Everything else (centers, vertices,
# neighbors, and the index->id map) is derived from `celdas` with h3 at load
# time, both in the client and in the pipeline. The grid then weighs ~1.6 MB
# instead of ~30 MB at res 10.

import csv
import io
import os
import json
import zipfile

import h3

# H3 resolution (configurable). The rest of the pipeline derives its suffix
# from here.
RESOLUCION_H3 = int(os.environ.get("RESOLUCION_H3", 9))

# Bounding box of Greater Santiago (same extent as the previous version). It
# is the default; for another city, override it with one of two environment
# variables:
#   BBOX="minLat,maxLat,minLon,maxLon"   explicit bbox
#   BBOX_GTFS=path/to/gtfs.zip           extent of the feed's stops + margin
BBOX_SANTIAGO = (-33.6688434969977, -33.3193395244284, -70.8739928318388, -70.4935176827249)
# Margin around the feed's stops, in degrees (~2 km).
MARGEN_GTFS = float(os.environ.get("BBOX_GTFS_MARGEN", "0.02"))


def bbox_desde_gtfs(ruta_zip, margen):
    """Extent of the feed's stops (stops.txt), plus a margin."""
    lats, lons = [], []
    with zipfile.ZipFile(ruta_zip) as zf, zf.open("stops.txt") as f:
        for s in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")):
            try:
                lats.append(float(s["stop_lat"]))
                lons.append(float(s["stop_lon"]))
            except (KeyError, ValueError):
                continue
    if not lats:
        raise SystemExit(f"The feed {ruta_zip} has no stops with coordinates.")
    return (min(lats) - margen, max(lats) + margen,
            min(lons) - margen, max(lons) + margen)


if os.environ.get("BBOX"):
    minLat, maxLat, minLon, maxLon = map(float, os.environ["BBOX"].split(","))
    origenBbox = "BBOX variable"
elif os.environ.get("BBOX_GTFS"):
    minLat, maxLat, minLon, maxLon = bbox_desde_gtfs(os.environ["BBOX_GTFS"], MARGEN_GTFS)
    origenBbox = f"GTFS stops ({os.environ['BBOX_GTFS']})"
else:
    minLat, maxLat, minLon, maxLon = BBOX_SANTIAGO
    origenBbox = "Greater Santiago (default)"

sufijo = f"r{RESOLUCION_H3}"
archivoSalida = f"json/Hexagon_{sufijo}.json"

print(f"Generating H3 grid at resolution {RESOLUCION_H3} | bbox: {origenBbox}")
print(f"  lat [{minLat:.4f}, {maxLat:.4f}] lon [{minLon:.4f}, {maxLon:.4f}]")

# H3 cells covering the rectangle. LatLngPoly takes (lat, lon) pairs.
poligono = h3.LatLngPoly([
    (minLat, minLon), (minLat, maxLon), (maxLat, maxLon), (maxLat, minLon),
])
celdas = sorted(h3.polygon_to_cells(poligono, RESOLUCION_H3))
print(f"  {len(celdas)} cells")

os.makedirs("json", exist_ok=True)
with open(archivoSalida, "w", encoding="utf-8") as f:
    json.dump({
        "resolucion": RESOLUCION_H3,
        "minLat": minLat,
        "maxLat": maxLat,
        "minLon": minLon,
        "maxLon": maxLon,
        "numCeldas": len(celdas),
        "celdas": celdas,
    }, f, ensure_ascii=False, separators=(',', ':'))

print(f"Grid written: {archivoSalida}")
print(f"Total cells: {len(celdas)} (resolution {RESOLUCION_H3})")
