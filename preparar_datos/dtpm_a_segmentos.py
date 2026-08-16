# %%
"""Converts the DTPM trip records into the two segment tables the pipeline reads.

Input
-----
- DTPM trip records (partitioned parquet): each row is one trip with up to
  four stages. Per stage k (1..4) the columns used are: tipo_transporte_k,
  paradero_subida_k, paradero_bajada_k, tiempo_subida_k, tiempo_bajada_k. The
  trip weight is factor_expansion (how many real trips the record represents).
- DTPM stop catalog (parquet): stop code -> geometry (point in UTM 19S,
  EPSG:32719). Reprojected to WGS84.
- Metro station coordinates: json/MetroParaderos.json (name -> lat/lon).

Output
------
Two parquet files of directed segments, with the schema the pipeline expects:
- buses.parquet:  id, latinicial, loninicial, latfinal, lonfinal,
                  tiempoinicial, tiempofinal, carga, horarango
- metro.parquet:  estacioninicial, estacionfinal, latinicial, loninicial,
                  latfinal, lonfinal, tiempoinicial, tiempofinal,
                  horarango, tipodia, peso

Mapping criteria
----------------
- One stage = one directed segment (boarding -> alighting).
- Bus  = tipo_transporte 1 (RED). The stop is a code; it is geolocated with
  the catalog. The segment is the straight boarding->alighting chord (the
  pipeline rasterizes the hexagons along that chord). carga = factor_expansion.
- Metro = tipo_transporte 2. The stop is a station name. The stage is routed
  over the network graph and split into station-to-station segments, with the
  time divided uniformly. peso = factor_expansion.
- tipo_transporte 3 (other buses) and 4 (suburban rail) are excluded by
  default, to keep the two-layer design (RED bus + Metro).
- Stages without alighting, with factor_expansion <= 0, or with invalid times
  are discarded.

Execution:
    cd preparar_datos && uv sync
    uv run python dtpm_a_segmentos.py --muestra 2

Paths and parameters are controlled by environment variables (see the config
block) or command-line arguments.
"""

# %%
import argparse
import csv
import io
import json
import os
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq
from pyproj import Transformer
from shapely import wkb

import metro_red

# %%
# Configuration. Everything can be overridden by environment or arguments.
GDS = Path(os.environ.get("GDS_DATA", Path.home() / "repositories/gds-course-materials/data"))
TESIS_SRC = Path(os.environ.get("TESIS_SRC", Path(__file__).resolve().parent.parent / "src"))

DEFAULTS = {
    "viajes": GDS / "dtpm-viajes/dtpm-2023.parquet",
    "paraderos": GDS / "dtpm-paraderos.parquet",
    "metro_coords": TESIS_SRC / "json/MetroParaderos.json",
    "metro_red": TESIS_SRC / "json/RedMetro.json",
    "salida": TESIS_SRC / "json/segmentos",
}

# tipo_transporte -> logical mode
MODOS_BUS = {"1"}      # RED. Add "3" to include other buses.
MODO_METRO = "2"
# DTPM tipodia considered a working day. In the 2023 data the value is "0".
TIPODIA_LABORAL = set(os.environ.get("TIPODIA_LABORAL", "0").split(","))
# CRS of the stop catalog geometry (UTM 19S for Santiago).
CRS_PARADEROS = int(os.environ.get("CRS_PARADEROS", "32719"))

# Column names of the stop catalog, tolerant to the two versions of the file
# (the regenerated catalog uses snake_case; the original, long names).
COLS_CODIGO_TS = ("codigo_ts", "Código paradero TS")
COLS_CODIGO_USUARIO = ("codigo_usuario", "Código paradero Usuario")


def _columna(columnas, candidatas, que):
    for c in candidatas:
        if c in columnas:
            return c
    raise SystemExit(f"The catalog has no {que} column (tried {candidatas}).")

ESQUEMA_BUSES = pa.schema([
    ("id", pa.int64()),
    ("latinicial", pa.float64()), ("loninicial", pa.float64()),
    ("latfinal", pa.float64()), ("lonfinal", pa.float64()),
    ("tiempoinicial", pa.timestamp("us")), ("tiempofinal", pa.timestamp("us")),
    ("carga", pa.float64()), ("horarango", pa.int32()),
])
ESQUEMA_METRO = pa.schema([
    ("estacioninicial", pa.string()), ("estacionfinal", pa.string()),
    ("latinicial", pa.float64()), ("loninicial", pa.float64()),
    ("latfinal", pa.float64()), ("lonfinal", pa.float64()),
    ("tiempoinicial", pa.string()), ("tiempofinal", pa.string()),
    ("horarango", pa.int32()), ("tipodia", pa.string()), ("peso", pa.float64()),
])


# %%
def cargar_coords_paraderos(ruta_paraderos):
    """Reads the catalog and returns {codigo_ts: (lon, lat)} in WGS84."""
    print(f"[paraderos] reading catalog: {ruta_paraderos}")
    par = pd.read_parquet(ruta_paraderos)
    col = _columna(par.columns, COLS_CODIGO_TS, "TS code")
    transformer = Transformer.from_crs(CRS_PARADEROS, 4326, always_xy=True)
    coords = {}
    for codigo, geom in zip(par[col].astype(str), par["geometry"]):
        try:
            punto = wkb.loads(bytes(geom))
            lon, lat = transformer.transform(punto.x, punto.y)
            coords[codigo] = (lon, lat)
        except Exception:
            continue
    print(f"[paraderos] {len(coords)} stops geolocated (CRS {CRS_PARADEROS} -> 4326)")
    return coords


def cargar_coords_paraderos_gtfs(ruta_gtfs_zip, ruta_catalogo):
    """Stop coordinates from the GTFS feed's stops.txt. The DTPM catalog is
    used only as a code map (codigo_ts -> codigo_usuario, which is the feed's
    stop_id); the geometry comes from the feed. This is the path of the
    generic trips + GTFS contract. Measured against the catalog (2026 feed):
    the same location in practice (median 0 m, p99 8.3 m) and stage coverage
    of 99.1% against 99.2%, but it does NOT reproduce bit-by-bit the matrices
    generated with the catalog; to regenerate the published data use the
    default."""
    print(f"[paraderos] reading stops.txt from the GTFS: {ruta_gtfs_zip}")
    with zipfile.ZipFile(ruta_gtfs_zip) as zf, zf.open("stops.txt") as f:
        stops = {}
        for s in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")):
            if s.get("location_type", "0") not in ("", "0"):
                continue
            try:
                stops[s["stop_id"]] = (float(s["stop_lon"]), float(s["stop_lat"]))
            except (KeyError, ValueError):
                continue
    par = pd.read_parquet(ruta_catalogo)
    col_ts = _columna(par.columns, COLS_CODIGO_TS, "TS code")
    col_usuario = _columna(par.columns, COLS_CODIGO_USUARIO, "user code")
    coords = {}
    for ts, usuario in zip(par[col_ts].astype(str), par[col_usuario].astype(str)):
        if usuario in stops:
            coords[ts] = stops[usuario]
    print(f"[paraderos] {len(coords)} stops geolocated via GTFS "
          f"({len(stops)} stops in the feed)")
    return coords


def cargar_coords_metro(ruta_metro_coords):
    """Reads json/MetroParaderos.json and returns {station_name: (lat, lon)}."""
    print(f"[metro] reading station coordinates: {ruta_metro_coords}")
    with open(ruta_metro_coords, encoding="utf-8") as f:
        data = json.load(f)
    coords = {m["nombre"]: (float(m["latitud"]), float(m["longitud"])) for m in data["metros"]}
    print(f"[metro] {len(coords)} stations with coordinates")
    return coords


def etapas_largas(df):
    """Turns a trip fragment (wide format, up to 4 stages) into long format:
    one row per stage, with columns modo, sub, baj, t_sub, t_baj, factor."""
    piezas = []
    for k in range(1, 5):
        cols = {
            f"tipo_transporte_{k}": "modo",
            f"paradero_subida_{k}": "sub",
            f"paradero_bajada_{k}": "baj",
            f"tiempo_subida_{k}": "t_sub",
            f"tiempo_bajada_{k}": "t_baj",
        }
        if not all(c in df.columns for c in cols):
            continue
        pieza = df[list(cols) + ["factor_expansion"]].rename(columns=cols)
        piezas.append(pieza)
    largo = pd.concat(piezas, ignore_index=True)
    largo["factor"] = pd.to_numeric(largo["factor_expansion"], errors="coerce")
    # Common filters: complete stage with positive weight.
    largo = largo[
        (largo["modo"].notna())
        & (largo["sub"].notna()) & (largo["sub"] != "-")
        & (largo["baj"].notna()) & (largo["baj"] != "-")
        & (largo["t_sub"].notna()) & (largo["t_sub"] != "-")
        & (largo["t_baj"].notna()) & (largo["t_baj"] != "-")
        & (largo["factor"] > 0)
    ]
    return largo


def construir_buses(largo, coords_par, id_inicial):
    """Builds bus segment rows from the long-format stages."""
    bus = largo[largo["modo"].isin(MODOS_BUS)].copy()
    if bus.empty:
        return None, id_inicial

    lon_ini, lat_ini = zip(*(coords_par.get(c, (np.nan, np.nan)) for c in bus["sub"]))
    lon_fin, lat_fin = zip(*(coords_par.get(c, (np.nan, np.nan)) for c in bus["baj"]))
    bus["loninicial"], bus["latinicial"] = lon_ini, lat_ini
    bus["lonfinal"], bus["latfinal"] = lon_fin, lat_fin
    bus["tiempoinicial"] = pd.to_datetime(bus["t_sub"], errors="coerce")
    bus["tiempofinal"] = pd.to_datetime(bus["t_baj"], errors="coerce")

    bus = bus.dropna(subset=["loninicial", "latinicial", "lonfinal", "latfinal",
                             "tiempoinicial", "tiempofinal"])
    if bus.empty:
        return None, id_inicial

    bus["horarango"] = bus["tiempoinicial"].dt.hour.astype("int32")
    bus["id"] = np.arange(id_inicial, id_inicial + len(bus), dtype="int64")
    bus = bus.rename(columns={"factor": "carga"})
    salida = bus[["id", "latinicial", "loninicial", "latfinal", "lonfinal",
                  "tiempoinicial", "tiempofinal", "carga", "horarango"]]
    return pa.Table.from_pandas(salida, schema=ESQUEMA_BUSES, preserve_index=False), id_inicial + len(bus)


def construir_metro(largo, grafo, coords_metro, cache_rutas):
    """Builds Metro segment rows by routing each stage over the network."""
    metro = largo[largo["modo"] == MODO_METRO]
    if metro.empty:
        return None, 0

    filas = []
    sin_ruta = 0
    for sub, baj, t_sub, t_baj, factor in zip(
        metro["sub"], metro["baj"], metro["t_sub"], metro["t_baj"], metro["factor"]
    ):
        par = (sub, baj)
        if par not in cache_rutas:
            cache_rutas[par] = metro_red.camino_estaciones(grafo, sub, baj)
        estaciones = cache_rutas[par]
        if len(estaciones) < 2:
            sin_ruta += 1
            continue

        ts = pd.to_datetime(t_sub, errors="coerce")
        tb = pd.to_datetime(t_baj, errors="coerce")
        if pd.isna(ts) or pd.isna(tb):
            continue
        horarango = int(ts.hour)

        for estIni, estFin, hIni, hFin in metro_red.segmentos_con_tiempo(
            estaciones, ts.to_pydatetime(), tb.to_pydatetime()
        ):
            ci = coords_metro.get(estIni)
            cf = coords_metro.get(estFin)
            if ci is None or cf is None:
                continue
            filas.append((
                estIni, estFin, ci[0], ci[1], cf[0], cf[1],
                hIni.strftime("%H:%M:%S"), hFin.strftime("%H:%M:%S"),
                horarango, "LABORAL", float(factor),
            ))

    if not filas:
        return None, sin_ruta

    cols = list(zip(*filas))
    tabla = pa.table({name: list(col) for name, col in zip(ESQUEMA_METRO.names, cols)},
                     schema=ESQUEMA_METRO)
    return tabla, sin_ruta


# %%
def main():
    ap = argparse.ArgumentParser(description="Converts DTPM trips into bus and Metro segments.")
    ap.add_argument("--viajes", default=str(DEFAULTS["viajes"]))
    ap.add_argument("--paraderos", default=str(DEFAULTS["paraderos"]))
    ap.add_argument("--paraderos-gtfs", default=None, metavar="GTFS_ZIP",
                    help="Geolocate the bus stops with the stops.txt of this GTFS feed "
                         "instead of the catalog geometry (path of the generic contract; "
                         "the catalog still provides the codigo_ts -> stop_id map).")
    ap.add_argument("--metro-coords", default=str(DEFAULTS["metro_coords"]))
    ap.add_argument("--metro-red", default=str(DEFAULTS["metro_red"]),
                    help="RedMetro.json with the topology {line: [stations]} (generated by gtfs_a_metro.py).")
    ap.add_argument("--salida", default=str(DEFAULTS["salida"]))
    ap.add_argument("--muestra", type=int, default=0,
                    help="Process only the first N fragments (0 = all). For testing.")
    args = ap.parse_args()

    salida = Path(args.salida)
    salida.mkdir(parents=True, exist_ok=True)
    print("=" * 60)
    print(f"Trips:         {args.viajes}")
    print(f"Stops:         {args.paraderos}")
    print(f"Metro coords:  {args.metro_coords}")
    print(f"Output:        {salida}")
    print(f"Bus modes:     {sorted(MODOS_BUS)} | metro mode: {MODO_METRO}")
    print(f"working-day tipodia: {sorted(TIPODIA_LABORAL)}")
    print(f"Sample:        {args.muestra or 'all fragments'}")
    print("=" * 60)

    if args.paraderos_gtfs:
        coords_par = cargar_coords_paraderos_gtfs(args.paraderos_gtfs, args.paraderos)
    else:
        coords_par = cargar_coords_paraderos(args.paraderos)
    coords_metro = cargar_coords_metro(args.metro_coords)
    with open(args.metro_red, encoding="utf-8") as f:
        lineas_metro = json.load(f)["lineas"]
    grafo = metro_red.construir_grafo(lineas_metro)
    print(f"[metro] network: {len(lineas_metro)} lines ({args.metro_red}) | "
          f"graph: {grafo.number_of_nodes()} nodes, {grafo.number_of_edges()} edges")

    columnas = ["tipodia", "factor_expansion"]
    for k in range(1, 5):
        columnas += [f"tipo_transporte_{k}", f"paradero_subida_{k}", f"paradero_bajada_{k}",
                     f"tiempo_subida_{k}", f"tiempo_bajada_{k}"]

    dataset = ds.dataset(args.viajes, format="parquet")
    fragmentos = list(dataset.get_fragments())
    if args.muestra:
        fragmentos = fragmentos[:args.muestra]
    print(f"[viajes] {len(fragmentos)} fragments to process")

    writer_bus = pq.ParquetWriter(salida / "buses.parquet", ESQUEMA_BUSES)
    writer_metro = pq.ParquetWriter(salida / "metro.parquet", ESQUEMA_METRO)
    cache_rutas = {}
    id_bus = 0
    tot_bus = tot_metro = tot_sin_ruta = 0
    # Demand count per hour (expanded trips at the stage level, not the
    # segment level). Reproduces the semantics of json/CantidadViajes.json.
    conteo_bus = np.zeros(24)
    conteo_metro = np.zeros(24)
    # Distinct working dates in the extract: they normalize the counts (and,
    # via metadatos.json, the aggregation weights) to an average working day.
    fechas = set()

    try:
        for n, frag in enumerate(fragmentos, 1):
            df = frag.to_table(columns=[c for c in columnas if c in dataset.schema.names]).to_pandas()
            df = df[df["tipodia"].isin(TIPODIA_LABORAL)]
            if df.empty:
                print(f"[frag {n}/{len(fragmentos)}] no working-day rows, skipping")
                continue

            largo = etapas_largas(df)

            # Demand count per hour, at the stage level (before routing).
            t_etapa = pd.to_datetime(largo["t_sub"], errors="coerce")
            fechas.update(t_etapa.dropna().dt.date.unique())
            hora_etapa = t_etapa.dt.hour
            es_bus = largo["modo"].isin(MODOS_BUS) & hora_etapa.notna()
            es_metro = (largo["modo"] == MODO_METRO) & hora_etapa.notna()
            np.add.at(conteo_bus, hora_etapa[es_bus].astype(int).to_numpy(),
                      largo.loc[es_bus, "factor"].to_numpy())
            np.add.at(conteo_metro, hora_etapa[es_metro].astype(int).to_numpy(),
                      largo.loc[es_metro, "factor"].to_numpy())

            tabla_bus, id_bus = construir_buses(largo, coords_par, id_bus)
            tabla_metro, sin_ruta = construir_metro(largo, grafo, coords_metro, cache_rutas)
            tot_sin_ruta += sin_ruta

            if tabla_bus is not None:
                writer_bus.write_table(tabla_bus)
                tot_bus += tabla_bus.num_rows
            if tabla_metro is not None:
                writer_metro.write_table(tabla_metro)
                tot_metro += tabla_metro.num_rows

            print(f"[frag {n}/{len(fragmentos)}] trips={len(df)} "
                  f"-> bus_seg={tabla_bus.num_rows if tabla_bus is not None else 0} "
                  f"metro_seg={tabla_metro.num_rows if tabla_metro is not None else 0} "
                  f"(cum bus={tot_bus}, metro={tot_metro})")
    finally:
        writer_bus.close()
        writer_metro.close()

    # Per-hour counts normalized to an average working day, next to the other
    # JSON files of the visualizer. The app reads json/CantidadViajes.json.
    n_dias = max(1, len(fechas))
    ruta_conteos = TESIS_SRC / "json/CantidadViajes.json"
    with open(ruta_conteos, "w", encoding="utf-8") as f:
        json.dump({
            "BUSES": [int(round(x / n_dias)) for x in conteo_bus],
            "METRO": [int(round(x / n_dias)) for x in conteo_metro],
        }, f, indent=2)

    # Extract metadata. FuenteDatos.py uses dias_laborales to bring the
    # aggregation weights to an average working day.
    ruta_metadatos = salida / "metadatos.json"
    with open(ruta_metadatos, "w", encoding="utf-8") as f:
        json.dump({
            "dias_laborales": n_dias,
            "fecha_min": str(min(fechas)) if fechas else None,
            "fecha_max": str(max(fechas)) if fechas else None,
        }, f, indent=2)

    print("=" * 60)
    print(f"Bus segments:   {tot_bus}")
    print(f"Metro segments: {tot_metro}")
    print(f"Metro stages with no route in the graph: {tot_sin_ruta}")
    print(f"Working days in the extract: {n_dias} "
          f"({min(fechas) if fechas else '?'} -> {max(fechas) if fechas else '?'})")
    print(f"Expanded trips/h bus, average day (peak):   "
          f"{conteo_bus.max() / n_dias:.0f} at hour {conteo_bus.argmax()}")
    print(f"Expanded trips/h metro, average day (peak): "
          f"{conteo_metro.max() / n_dias:.0f} at hour {conteo_metro.argmax()}")
    print(f"Written to: {salida}/buses.parquet, {salida}/metro.parquet")
    print(f"Counts in: {ruta_conteos} | Metadata in: {ruta_metadatos}")
    print("=" * 60)


if __name__ == "__main__":
    main()
