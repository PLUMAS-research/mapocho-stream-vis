"""Derives the visualizer's Metro inputs from a GTFS feed:

  - src/json/RedMetro.json        : topology {line: [stations in order]}.
  - src/json/MetroParaderos.json  : station -> lat/lon table (key "metros").
  - src/json/LineasMetro.json     : per-line trace with its color.
  - src/json/HexMetro_r<res>.json : contiguous station pair -> H3 cells.

The topology (which stations each line has, in which order) is derived from
the feed itself: route_type 1 routes and the stop sequence of the longest
trip of each route (stop_times). There are no hand-written station lists;
what remains Santiago-specific are the spelling map ALIAS_GTFS (translates
GTFS names to the canonical names of the DTPM data) and ORDEN_GRAFO (a
reproducibility anchor for route tie-breaking, see its comment). A different
feed version reflects a different date of the network: to reproduce the
paper's data, pin the same GTFS.

Usage:
    uv run python gtfs_a_metro.py                 # downloads the default GTFS and generates
    uv run python gtfs_a_metro.py --gtfs-zip x.zip
    GTFS_URL=... uv run python gtfs_a_metro.py

All paths and the URL are controlled by arguments or environment variables.
"""

import argparse
import csv
import io
import json
import os
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

import h3

# URL of the DTPM GTFS feed. A different version reflects a different network date.
GTFS_URL_DEFAULT = "https://dtpm.cl/descargas/gtfs/GTFS_20260530_v2.zip"

# route_type 1 = metro (subway) in the GTFS specification.
ROUTE_TYPE_METRO = "1"

# Insertion order of the lines in RedMetro.json (those present; the rest
# follow the routes.txt order). It exists only for reproducibility: when two
# Metro routes tie in cost, Dijkstra's tie-breaking depends on the order in
# which nodes and edges were inserted into the graph, and this order
# reproduces the topology with which the published matrices were generated
# (28 of 7875 station pairs change route if it is altered). With another city
# or another feed the list does not apply and the natural routes.txt order is
# just as valid.
ORDEN_GRAFO = ["L6", "L3", "L2", "L1", "L5", "L4", "L4A"]

# Colors per line, RGB. These are the signage colors of Metro de Santiago;
# for a line not listed here, the feed's route_color is used.
COLORES_LINEAS = {
    "L1": [227, 30, 36],    # red
    "L2": [255, 199, 0],    # yellow
    "L3": [139, 90, 43],    # brown
    "L4": [0, 90, 200],     # blue
    "L4A": [0, 178, 227],   # light blue
    "L5": [0, 154, 68],     # green
    "L6": [130, 60, 150],   # purple
}

# Spelling differences between the GTFS and the canonical DTPM names.
# Key: GTFS base name (already without accents, uppercase, without the
# direction suffix). Value: canonical name used in the DTPM data.
ALIAS_GTFS = {
    "UNION LATINOAMERICANA": "UNION LATINO AMERICANA",
    "RONDIZZONI": "RONDIZONNI",
    "PARQUE O'HIGGINS": "PARQUE OHIGGINS",
    "PUENTE CAL Y CANTO": "CAL Y CANTO",
    "PDTE. PEDRO AGUIRRE CERDA": "PDTE PEDRO AGUIRRE CERDA",
    "PLAZA DE MAIPU": "PLAZA MAIPU",
}


def normalizar(texto):
    """Uppercase, no accents, no stray spaces."""
    texto = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return texto.upper().strip()


def nombre_base(stop_name):
    """Station name without the ' DIRECCION X' suffix of the GTFS platforms."""
    n = normalizar(stop_name)
    if " DIRECCION " in n:
        n = n.split(" DIRECCION ")[0].strip()
    return ALIAS_GTFS.get(n, n)


def descargar_gtfs(url, cache_dir):
    """Downloads the GTFS zip to cache_dir if absent. Returns the local path."""
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    destino = cache_dir / "gtfs.zip"
    if destino.exists():
        print(f"[gtfs] using cache: {destino} ({destino.stat().st_size // 1024} KB)")
        return destino
    print(f"[gtfs] downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as resp, open(destino, "wb") as f:
        f.write(resp.read())
    print(f"[gtfs] downloaded: {destino} ({destino.stat().st_size // 1024} KB)")
    return destino


def _leer_csv(zf, nombre):
    with zf.open(nombre) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


def derivar_red(zip_path):
    """Reads the feed once and derives the whole Metro network. Returns
    (lineas, coords, colores_feed):

      - lineas: {route_id: [stations in order]} with canonical names. The
        sequence of each line is that of the trip with the most stops of the
        route (direction 0 when present); the orientation does not matter for
        the graph or the trace, and it was verified that it does not change
        the H3 cells either.
      - coords: {canonical_name: (lat, lon)}, averaging the platforms.
      - colores_feed: {route_id: [r, g, b]} from route_color, when present.

    The order of the `lineas` dict follows ORDEN_GRAFO (see above) and then
    the routes.txt order for unlisted lines."""
    with zipfile.ZipFile(zip_path) as zf:
        rutas = [r for r in _leer_csv(zf, "routes.txt")
                 if r.get("route_type") == ROUTE_TYPE_METRO]
        trips = _leer_csv(zf, "trips.txt")
        stops = {s["stop_id"]: s for s in _leer_csv(zf, "stops.txt")}
        stop_times = _leer_csv(zf, "stop_times.txt")

    ids_metro = {r["route_id"] for r in rutas}
    print(f"[gtfs] routes with route_type {ROUTE_TYPE_METRO}: {sorted(ids_metro)}")

    trip_ruta = {t["trip_id"]: (t["route_id"], t.get("direction_id", "0"))
                 for t in trips if t["route_id"] in ids_metro}
    paradas_trip = defaultdict(list)
    acumulado = defaultdict(list)
    for st in stop_times:
        clave = trip_ruta.get(st["trip_id"])
        if clave is None:
            continue
        paradas_trip[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"]))
        s = stops.get(st["stop_id"])
        if s:
            nombre = nombre_base(s["stop_name"])
            acumulado[nombre].append((float(s["stop_lat"]), float(s["stop_lon"])))

    # Longest sequence per (route, direction).
    mejor = {}
    for tid, paradas in paradas_trip.items():
        ruta, dire = trip_ruta[tid]
        sec = [sid for _, sid in sorted(paradas)]
        clave = (ruta, dire)
        if clave not in mejor or len(sec) > len(mejor[clave]):
            mejor[clave] = sec

    orden_rutas = sorted(ids_metro, key=lambda rid: (
        ORDEN_GRAFO.index(rid) if rid in ORDEN_GRAFO else len(ORDEN_GRAFO),
        rid))
    lineas = {}
    for rid in orden_rutas:
        sec = mejor.get((rid, "0")) or mejor.get((rid, "1"))
        if not sec:
            print(f"[aviso] route {rid} has no stop_times; skipped")
            continue
        nombres = []
        for sid in sec:
            n = nombre_base(stops[sid]["stop_name"])
            if not nombres or nombres[-1] != n:
                nombres.append(n)
        lineas[rid] = nombres
        print(f"[gtfs] {rid}: {len(nombres)} stations ({nombres[0]} -> {nombres[-1]})")

    coords = {}
    for nombre, puntos in acumulado.items():
        lat = sum(p[0] for p in puntos) / len(puntos)
        lon = sum(p[1] for p in puntos) / len(puntos)
        coords[nombre] = (lat, lon)
    print(f"[gtfs] Metro stations with coordinates: {len(coords)}")

    colores_feed = {}
    for r in rutas:
        hexcolor = (r.get("route_color") or "").strip()
        if len(hexcolor) == 6:
            colores_feed[r["route_id"]] = [int(hexcolor[i:i+2], 16) for i in (0, 2, 4)]
    return lineas, coords, colores_feed


def escribir_redmetro(lineas, ruta_salida):
    """Writes RedMetro.json, the topology derived from the GTFS: {line:
    [stations in order]}. dtpm_a_segmentos.py consumes it to build the
    routing graph (the dict order fixes the tie-breaking, see ORDEN_GRAFO)."""
    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump({"lineas": lineas}, f, ensure_ascii=False, indent=2)
    n_est = len({e for ests in lineas.values() for e in ests})
    print(f"[metro] {ruta_salida}: {len(lineas)} lines, {n_est} stations")


def escribir_metroparaderos(coords, lineas, ruta_salida):
    """Writes MetroParaderos.json with the 'metros' table (name -> lat/lon),
    in the order and with the names of the derived topology."""
    vistos = {}
    idx = 1
    for estaciones in lineas.values():
        for est in estaciones:
            if est in vistos or est not in coords:
                continue
            lat, lon = coords[est]
            vistos[est] = {"id": str(idx), "nombre": est, "latitud": lat, "longitud": lon}
            idx += 1
    salida = {"metros": list(vistos.values())}
    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, indent=4)
    print(f"[metro] {ruta_salida}: {len(vistos)} stations")


def escribir_lineas_metro(coords, lineas, colores_feed, ruta_salida):
    """Writes LineasMetro.json: for each line, the [lon, lat] polyline that
    joins its stations in order, plus its color (COLORES_LINEAS when present,
    otherwise the feed's route_color). It is the schematic trace of the
    network (straight station-to-station segments), which the frontend draws
    as a toggleable context layer, independent of the name labels. If a
    station has no coordinates in the feed, the polyline is cut so a long
    jump is not drawn across the city."""
    salida_lineas = []
    for linea, estaciones in lineas.items():
        # Contiguous segments with coordinates; a gap splits the polyline.
        tramos = [[]]
        for est in estaciones:
            if est in coords:
                lat, lon = coords[est]
                tramos[-1].append([round(lon, 6), round(lat, 6)])
            elif tramos[-1]:
                tramos.append([])
        polilineas = [t for t in tramos if len(t) >= 2]
        color = COLORES_LINEAS.get(linea) or colores_feed.get(linea) or [150, 150, 150]
        salida_lineas.append({
            "id": linea,
            "color": color,
            "polilineas": polilineas,
        })
    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump({"lineas": salida_lineas}, f, ensure_ascii=False, indent=2)
    n_pol = sum(len(l["polilineas"]) for l in salida_lineas)
    print(f"[metro] {ruta_salida}: {len(salida_lineas)} lines, {n_pol} polylines")


# --- Trace over the H3 grid ---------------------------------------------------

def construir_hexmetro(coords, lineas, grilla):
    """For each pair of contiguous stations of each line, traces the H3 cell
    line between them and returns {'A->B': [local cell ids]}."""
    resolucion = grilla["resolucion"]
    h3_a_id = {c: i for i, c in enumerate(grilla["celdas"])}

    # H3 cell containing each station.
    celda_est = {est: h3.latlng_to_cell(lat, lon, resolucion)
                 for est, (lat, lon) in coords.items()}

    rutas = {}
    pares = set()
    for estaciones in lineas.values():
        for a, b in zip(estaciones, estaciones[1:]):
            if a == b or a not in celda_est or b not in celda_est:
                continue
            if (a, b) in pares or (b, a) in pares:
                continue
            pares.add((a, b))
            ca, cb = celda_est[a], celda_est[b]
            if ca == cb:
                camino = [ca]
            else:
                try:
                    camino = h3.grid_path_cells(ca, cb)
                except Exception:
                    camino = [ca, cb]
            ids = []
            ultimo = None
            for c in camino:
                hid = h3_a_id.get(c)
                if hid is not None and hid != ultimo:
                    ids.append(hid)
                    ultimo = hid
            rutas[f"{a}->{b}"] = ids
    print(f"[metro] HexMetro: {len(rutas)} contiguous station pairs")
    return rutas


def main():
    aqui = Path(__file__).resolve().parent
    src_json_def = aqui.parent / "src" / "json"

    ap = argparse.ArgumentParser(description="Derives the Metro inputs from GTFS.")
    ap.add_argument("--gtfs-url", default=os.environ.get("GTFS_URL", GTFS_URL_DEFAULT))
    ap.add_argument("--gtfs-zip", default=None,
                    help="Path to a local GTFS; when given, nothing is downloaded.")
    ap.add_argument("--cache-dir", default=os.environ.get("GTFS_CACHE", str(aqui / ".gtfs_cache")),
                    help="Where to store/look for the downloaded GTFS zip.")
    ap.add_argument("--salida-dir", default=str(src_json_def),
                    help="src/json directory where the files are written.")
    ap.add_argument("--resolucion", default=os.environ.get("RESOLUCION_H3", "9"),
                    help="H3 resolution of the grid (suffix of the files).")
    args = ap.parse_args()

    salida = Path(args.salida_dir)
    grilla_path = salida / f"Hexagon_r{args.resolucion}.json"
    if not grilla_path.exists():
        raise SystemExit(f"Missing grid {grilla_path}. Run CreacionGrilla.py first.")

    zip_path = Path(args.gtfs_zip) if args.gtfs_zip else descargar_gtfs(args.gtfs_url, args.cache_dir)

    lineas, coords, colores_feed = derivar_red(zip_path)

    # Coverage: topology stations without coordinates in this feed.
    canonicas = {est for ests in lineas.values() for est in ests}
    faltan = sorted(canonicas - set(coords))
    if faltan:
        print(f"[aviso] {len(faltan)} topology stations without coordinates in the GTFS:")
        for f in faltan:
            print(f"        - {f}")
    else:
        print(f"[gtfs] full coverage: all {len(canonicas)} topology stations have coordinates.")

    with open(grilla_path, encoding="utf-8") as f:
        grilla = json.load(f)

    escribir_redmetro(lineas, salida / "RedMetro.json")
    escribir_metroparaderos(coords, lineas, salida / "MetroParaderos.json")
    escribir_lineas_metro(coords, lineas, colores_feed, salida / "LineasMetro.json")
    rutas = construir_hexmetro(coords, lineas, grilla)
    hexmetro_path = salida / f"HexMetro_r{args.resolucion}.json"
    with open(hexmetro_path, "w", encoding="utf-8") as f:
        json.dump(rutas, f, ensure_ascii=False, indent=2)
    print(f"[metro] {hexmetro_path}: {len(rutas)} entries")
    print("[ok] Metro inputs generated from GTFS.")


if __name__ == "__main__":
    main()
