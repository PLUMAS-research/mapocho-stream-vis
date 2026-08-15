"""Deriva desde un feed GTFS los insumos de Metro del visualizador:

  - src/json/RedMetro.json        : topología {linea: [estaciones en orden]}.
  - src/json/MetroParaderos.json  : tabla estación -> lat/lon (clave "metros").
  - src/json/LineasMetro.json     : trazado por línea con su color.
  - src/json/HexMetro_r<res>.json : par de estaciones contiguas -> celdas H3.

La topología (qué estaciones tiene cada línea, en qué orden) se deriva del
propio feed: rutas con route_type 1 y la secuencia de paradas del viaje más
largo de cada ruta (stop_times). No hay listas de estaciones escritas a mano;
lo Santiago-específico que queda son el mapa de ortografías ALIAS_GTFS (traduce
los nombres del GTFS a los canónicos de los datos DTPM) y ORDEN_GRAFO (ancla de
reproducibilidad del desempate de rutas, ver su comentario). Una versión
distinta del feed refleja otra fecha de la red: para reproducir los datos del
paper hay que fijar el mismo GTFS.

Uso:
    uv run python gtfs_a_metro.py                 # baja el GTFS por defecto y genera
    uv run python gtfs_a_metro.py --gtfs-zip x.zip
    GTFS_URL=... uv run python gtfs_a_metro.py

Todas las rutas y la URL se controlan por argumentos o variables de entorno.
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

# URL del feed GTFS de DTPM. Una versión distinta refleja otra fecha de la red.
GTFS_URL_DEFAULT = "https://dtpm.cl/descargas/gtfs/GTFS_20260530_v2.zip"

# route_type 1 = metro (subway) en la especificación GTFS.
ROUTE_TYPE_METRO = "1"

# Orden de inserción de las líneas en RedMetro.json (las que existan; las demás
# siguen en el orden de routes.txt). Existe solo por reproducibilidad: cuando dos
# rutas de Metro empatan en costo, el desempate de Dijkstra depende del orden en
# que se insertaron nodos y aristas al grafo, y este orden reproduce el de la
# topología con que se generaron las matrices publicadas (28 de 7875 pares de
# estaciones cambian de ruta si se altera). Con otra ciudad u otro feed la lista
# no aplica y el orden natural de routes.txt es igual de válido.
ORDEN_GRAFO = ["L6", "L3", "L2", "L1", "L5", "L4", "L4A"]

# Colores por línea, RGB. Estos son los de la señalética de Metro de Santiago;
# para una línea que no esté aquí se usa el route_color del feed GTFS.
COLORES_LINEAS = {
    "L1": [227, 30, 36],    # roja
    "L2": [255, 199, 0],    # amarilla
    "L3": [139, 90, 43],    # café
    "L4": [0, 90, 200],     # azul
    "L4A": [0, 178, 227],   # celeste
    "L5": [0, 154, 68],     # verde
    "L6": [130, 60, 150],   # morada
}

# Diferencias de ortografía entre el GTFS y los nombres canónicos de DTPM/topología.
# Clave: nombre base del GTFS (ya sin acentos, mayúsculas, sin sufijo de dirección).
# Valor: nombre canónico usado en los datos DTPM.
ALIAS_GTFS = {
    "UNION LATINOAMERICANA": "UNION LATINO AMERICANA",
    "RONDIZZONI": "RONDIZONNI",
    "PARQUE O'HIGGINS": "PARQUE OHIGGINS",
    "PUENTE CAL Y CANTO": "CAL Y CANTO",
    "PDTE. PEDRO AGUIRRE CERDA": "PDTE PEDRO AGUIRRE CERDA",
    "PLAZA DE MAIPU": "PLAZA MAIPU",
}


def normalizar(texto):
    """Mayúsculas, sin acentos, sin espacios sobrantes."""
    texto = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return texto.upper().strip()


def nombre_base(stop_name):
    """Nombre de estación sin el sufijo ' DIRECCION X' de los andenes del GTFS."""
    n = normalizar(stop_name)
    if " DIRECCION " in n:
        n = n.split(" DIRECCION ")[0].strip()
    return ALIAS_GTFS.get(n, n)


def descargar_gtfs(url, cache_dir):
    """Descarga el zip GTFS a cache_dir si no está. Devuelve la ruta local."""
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    destino = cache_dir / "gtfs.zip"
    if destino.exists():
        print(f"[gtfs] usando cache: {destino} ({destino.stat().st_size // 1024} KB)")
        return destino
    print(f"[gtfs] descargando {url}")
    with urllib.request.urlopen(url, timeout=120) as resp, open(destino, "wb") as f:
        f.write(resp.read())
    print(f"[gtfs] descargado: {destino} ({destino.stat().st_size // 1024} KB)")
    return destino


def _leer_csv(zf, nombre):
    with zf.open(nombre) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


def derivar_red(zip_path):
    """Lee el feed una vez y deriva la red de Metro completa. Devuelve
    (lineas, coords, colores_feed):

      - lineas: {route_id: [estaciones en orden]} con nombres canónicos. La
        secuencia de cada línea es la del viaje con más paradas de la ruta
        (dirección 0 si existe); la orientación da lo mismo para el grafo y
        para el trazado, y se verificó que tampoco cambia las celdas H3.
      - coords: {nombre_canonico: (lat, lon)}, promediando los andenes.
      - colores_feed: {route_id: [r, g, b]} desde route_color, si viene.

    El orden del dict `lineas` sigue ORDEN_GRAFO (ver arriba) y luego el orden
    de routes.txt para líneas no listadas."""
    with zipfile.ZipFile(zip_path) as zf:
        rutas = [r for r in _leer_csv(zf, "routes.txt")
                 if r.get("route_type") == ROUTE_TYPE_METRO]
        trips = _leer_csv(zf, "trips.txt")
        stops = {s["stop_id"]: s for s in _leer_csv(zf, "stops.txt")}
        stop_times = _leer_csv(zf, "stop_times.txt")

    ids_metro = {r["route_id"] for r in rutas}
    print(f"[gtfs] rutas con route_type {ROUTE_TYPE_METRO}: {sorted(ids_metro)}")

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

    # Secuencia más larga por (ruta, dirección).
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
            print(f"[aviso] ruta {rid} sin stop_times; se omite")
            continue
        nombres = []
        for sid in sec:
            n = nombre_base(stops[sid]["stop_name"])
            if not nombres or nombres[-1] != n:
                nombres.append(n)
        lineas[rid] = nombres
        print(f"[gtfs] {rid}: {len(nombres)} estaciones ({nombres[0]} -> {nombres[-1]})")

    coords = {}
    for nombre, puntos in acumulado.items():
        lat = sum(p[0] for p in puntos) / len(puntos)
        lon = sum(p[1] for p in puntos) / len(puntos)
        coords[nombre] = (lat, lon)
    print(f"[gtfs] estaciones de Metro con coordenadas: {len(coords)}")

    colores_feed = {}
    for r in rutas:
        hexcolor = (r.get("route_color") or "").strip()
        if len(hexcolor) == 6:
            colores_feed[r["route_id"]] = [int(hexcolor[i:i+2], 16) for i in (0, 2, 4)]
    return lineas, coords, colores_feed


def escribir_redmetro(lineas, ruta_salida):
    """Escribe RedMetro.json, la topología derivada del GTFS: {linea:
    [estaciones en orden]}. La consume dtpm_a_segmentos.py para construir el
    grafo de ruteo (el orden del dict fija el desempate, ver ORDEN_GRAFO)."""
    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump({"lineas": lineas}, f, ensure_ascii=False, indent=2)
    n_est = len({e for ests in lineas.values() for e in ests})
    print(f"[metro] {ruta_salida}: {len(lineas)} líneas, {n_est} estaciones")


def escribir_metroparaderos(coords, lineas, ruta_salida):
    """Escribe MetroParaderos.json con la tabla 'metros' (nombre -> lat/lon),
    en el orden y los nombres de la topología derivada."""
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
    print(f"[metro] {ruta_salida}: {len(vistos)} estaciones")


def escribir_lineas_metro(coords, lineas, colores_feed, ruta_salida):
    """Escribe LineasMetro.json: por cada línea, la polilínea [lon, lat] que une
    sus estaciones en orden, más su color (COLORES_LINEAS si está, si no el
    route_color del feed). Es el trazado esquemático de la red (segmentos rectos
    estación a estación), que el frontend dibuja como capa de contexto
    conmutable, independiente de las etiquetas de nombres. Si una estación no
    tiene coordenadas en el feed, se corta la polilínea para no dibujar un salto
    largo a través de la ciudad."""
    salida_lineas = []
    for linea, estaciones in lineas.items():
        # Segmentos contiguos con coordenadas; un hueco parte la polilínea.
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
    print(f"[metro] {ruta_salida}: {len(salida_lineas)} líneas, {n_pol} polilíneas")


# --- Trazado sobre la grilla H3 -----------------------------------------------

def construir_hexmetro(coords, lineas, grilla):
    """Para cada par de estaciones contiguas de cada línea, traza la línea de
    celdas H3 entre ellas y devuelve {'A->B': [ids locales de celdas]}."""
    resolucion = grilla["resolucion"]
    h3_a_id = {c: i for i, c in enumerate(grilla["celdas"])}

    # Celda H3 que contiene cada estación.
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
    print(f"[metro] HexMetro: {len(rutas)} pares de estaciones contiguas")
    return rutas


def main():
    aqui = Path(__file__).resolve().parent
    src_json_def = aqui.parent / "src" / "json"

    ap = argparse.ArgumentParser(description="Deriva insumos de Metro desde GTFS.")
    ap.add_argument("--gtfs-url", default=os.environ.get("GTFS_URL", GTFS_URL_DEFAULT))
    ap.add_argument("--gtfs-zip", default=None,
                    help="Ruta a un GTFS local; si se da, no se descarga.")
    ap.add_argument("--cache-dir", default=os.environ.get("GTFS_CACHE", str(aqui / ".gtfs_cache")),
                    help="Dónde guardar/buscar el zip GTFS descargado.")
    ap.add_argument("--salida-dir", default=str(src_json_def),
                    help="Directorio src/json donde escribir los dos archivos.")
    ap.add_argument("--resolucion", default=os.environ.get("RESOLUCION_H3", "9"),
                    help="Resolución H3 de la grilla (sufijo de los archivos).")
    args = ap.parse_args()

    salida = Path(args.salida_dir)
    grilla_path = salida / f"Hexagon_r{args.resolucion}.json"
    if not grilla_path.exists():
        raise SystemExit(f"Falta la grilla {grilla_path}. Corre antes CreacionGrilla.py.")

    zip_path = Path(args.gtfs_zip) if args.gtfs_zip else descargar_gtfs(args.gtfs_url, args.cache_dir)

    lineas, coords, colores_feed = derivar_red(zip_path)

    # Cobertura: estaciones de la topología sin coordenadas en este feed.
    canonicas = {est for ests in lineas.values() for est in ests}
    faltan = sorted(canonicas - set(coords))
    if faltan:
        print(f"[aviso] {len(faltan)} estaciones de la topología sin coordenadas en el GTFS:")
        for f in faltan:
            print(f"        - {f}")
    else:
        print(f"[gtfs] cobertura completa: las {len(canonicas)} estaciones de la topología tienen coordenadas.")

    with open(grilla_path, encoding="utf-8") as f:
        grilla = json.load(f)

    escribir_redmetro(lineas, salida / "RedMetro.json")
    escribir_metroparaderos(coords, lineas, salida / "MetroParaderos.json")
    escribir_lineas_metro(coords, lineas, colores_feed, salida / "LineasMetro.json")
    rutas = construir_hexmetro(coords, lineas, grilla)
    hexmetro_path = salida / f"HexMetro_r{args.resolucion}.json"
    with open(hexmetro_path, "w", encoding="utf-8") as f:
        json.dump(rutas, f, ensure_ascii=False, indent=2)
    print(f"[metro] {hexmetro_path}: {len(rutas)} entradas")
    print("[ok] insumos de Metro generados desde GTFS.")


if __name__ == "__main__":
    main()
