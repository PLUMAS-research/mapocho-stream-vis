# %%
# Genera la grilla hexagonal del Gran Santiago con el indexado H3 de Uber.
# Reemplaza la grilla custom con offset odd-r por celdas H3 equiárea, lo que
# habilita además el multi-resolución vía cell_to_parent en el futuro.
#
# La resolución es configurable con la variable de entorno RESOLUCION_H3
# (por defecto 9). Referencia de tamaño sobre el bbox de Santiago:
#   res 8  ~= 2.150 celdas (arista ~461 m)
#   res 9  ~= 15.060 celdas (arista ~174 m)
#   res 10 ~= 105.000 celdas (arista ~66 m)
#
# Salida: json/Hexagon_r<res>.json, mínima. Solo el arreglo `celdas` con los
# índices H3 ordenados (el id local de cada celda es su posición en el arreglo),
# más resolucion, bbox y numCeldas. Todo lo demás (centros, vértices, vecinos y
# el mapa índice->id) se deriva de `celdas` con h3 al cargar, tanto en el cliente
# como en el pipeline. Así la grilla pesa ~1.6 MB en vez de ~30 MB a res 10.

import csv
import io
import os
import json
import zipfile

import h3

# Resolución H3 (configurable). El resto del pipeline deriva su sufijo de aquí.
RESOLUCION_H3 = int(os.environ.get("RESOLUCION_H3", 9))

# Bounding box del Gran Santiago (mismo extent que la versión anterior). Es el
# default; para otra ciudad se sobreescribe con una de dos variables de entorno:
#   BBOX="minLat,maxLat,minLon,maxLon"   bbox explícito
#   BBOX_GTFS=ruta/al/gtfs.zip           extensión de las paradas del feed + margen
BBOX_SANTIAGO = (-33.6688434969977, -33.3193395244284, -70.8739928318388, -70.4935176827249)
# Margen alrededor de las paradas del feed, en grados (~2 km).
MARGEN_GTFS = float(os.environ.get("BBOX_GTFS_MARGEN", "0.02"))


def bbox_desde_gtfs(ruta_zip, margen):
    """Extensión de las paradas (stops.txt) del feed, más un margen."""
    lats, lons = [], []
    with zipfile.ZipFile(ruta_zip) as zf, zf.open("stops.txt") as f:
        for s in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")):
            try:
                lats.append(float(s["stop_lat"]))
                lons.append(float(s["stop_lon"]))
            except (KeyError, ValueError):
                continue
    if not lats:
        raise SystemExit(f"El feed {ruta_zip} no trae paradas con coordenadas.")
    return (min(lats) - margen, max(lats) + margen,
            min(lons) - margen, max(lons) + margen)


if os.environ.get("BBOX"):
    minLat, maxLat, minLon, maxLon = map(float, os.environ["BBOX"].split(","))
    origenBbox = "variable BBOX"
elif os.environ.get("BBOX_GTFS"):
    minLat, maxLat, minLon, maxLon = bbox_desde_gtfs(os.environ["BBOX_GTFS"], MARGEN_GTFS)
    origenBbox = f"stops del GTFS ({os.environ['BBOX_GTFS']})"
else:
    minLat, maxLat, minLon, maxLon = BBOX_SANTIAGO
    origenBbox = "Gran Santiago (default)"

sufijo = f"r{RESOLUCION_H3}"
archivoSalida = f"json/Hexagon_{sufijo}.json"

print(f"Generando grilla H3 resolución {RESOLUCION_H3} | bbox: {origenBbox}")
print(f"  lat [{minLat:.4f}, {maxLat:.4f}] lon [{minLon:.4f}, {maxLon:.4f}]")

# Celdas H3 que cubren el rectángulo. LatLngPoly toma pares (lat, lon).
poligono = h3.LatLngPoly([
    (minLat, minLon), (minLat, maxLon), (maxLat, maxLon), (maxLat, minLon),
])
celdas = sorted(h3.polygon_to_cells(poligono, RESOLUCION_H3))
print(f"  {len(celdas)} celdas")

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

print(f"Grilla escrita: {archivoSalida}")
print(f"Total de celdas: {len(celdas)} (resolución {RESOLUCION_H3})")
