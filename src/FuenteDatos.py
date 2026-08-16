"""Segment data source for the aggregation.

The pipeline reads two sets of directed segments, buses and Metro, from
json/segmentos/{buses,metro}.parquet (produced by
preparar_datos/dtpm_a_segmentos.py). No database.

Output contract:
- leer_segmentos_buses(hora) -> iterator of tuples
    (id, latIni, lonIni, latFin, lonFin, tIni, tFin, carga, horarango)
    with tIni/tFin as datetime.datetime.
- leer_segmentos_metro(hora) -> iterator of tuples
    (estIni, estFin, latIni, lonIni, latFin, lonFin, tIni, tFin, peso)
    with tIni/tFin as datetime.time.

Both functions return generators that walk the parquet in batches
(ParquetFile.iter_batches) and filter each batch by hour. Memory per process
is bounded by the batch (TAMANO_LOTE, configurable by environment) and the
row group, not by file size: with the full extract (~164 M Metro segments,
~20 M at the peak hour) the previous version materialized the whole hour as a
list of tuples (~4 GB per process) and with 17 parallel processes it
triggered the OOM killer. Measured at the peak hour, this version keeps the
process under ~0.6 GB.
"""

import os
from pathlib import Path

import pandas as pd
import pyarrow.compute as pc
import pyarrow.parquet as pq

# Paths of the segment parquet files (relative to cwd, which is src/).
DIR_SEGMENTOS = Path(os.environ.get("DIR_SEGMENTOS", "json/segmentos"))
PARQUET_BUSES = DIR_SEGMENTOS / "buses.parquet"
PARQUET_METRO = DIR_SEGMENTOS / "metro.parquet"

# Rows per read batch. At ~250k rows each batch weighs a few tens of MB.
TAMANO_LOTE = int(os.environ.get("TAMANO_LOTE", "262144"))


def _dias_laborales():
    """Distinct working days in the extract, from metadatos.json (default 1).

    Weights (carga/peso = factor_expansion) are divided by this number on
    read, so the aggregated matrices represent an average working day and not
    the sum of the whole extract. The visualizer's palettes and thresholds
    assume that scale. metadatos.json is written by
    preparar_datos/dtpm_a_segmentos.py.
    """
    import json
    ruta = DIR_SEGMENTOS / "metadatos.json"
    try:
        with open(ruta, encoding="utf-8") as f:
            return max(1, int(json.load(f)["dias_laborales"]))
    except (FileNotFoundError, KeyError, ValueError):
        print(f"[FuenteDatos] no {ruta}; weights not normalized per day")
        return 1


DIAS_LABORALES = _dias_laborales()


def _lotes(ruta, columnas, mascara):
    """Walks the parquet in filtered batches, as small DataFrames.

    mascara(lote) -> BooleanArray with the rows of the requested hour. The
    filter runs batch by batch (no useful pushdown: row groups mix all
    hours), and only the surviving rows are converted to pandas.
    """
    pf = pq.ParquetFile(ruta)
    for lote in pf.iter_batches(batch_size=TAMANO_LOTE, columns=columnas):
        filtrado = lote.filter(mascara(lote))
        if filtrado.num_rows > 0:
            yield filtrado.to_pandas()


def _buses_parquet(hora):
    columnas = ["id", "latinicial", "loninicial", "latfinal", "lonfinal",
                "tiempoinicial", "tiempofinal", "carga", "horarango"]

    def mascara(lote):
        return pc.and_(pc.equal(lote.column("horarango"), int(hora)),
                       pc.greater(lote.column("carga"), 0))

    for df in _lotes(PARQUET_BUSES, columnas, mascara):
        df = df[df[columnas[1:8]].notna().all(axis=1)]
        if df.empty:
            continue
        # .tolist() over datetime64 yields pd.Timestamp (a subclass of
        # datetime.datetime), compatible with the consumers' arithmetic.
        yield from zip(
            df["id"].tolist(),
            df["latinicial"].tolist(), df["loninicial"].tolist(),
            df["latfinal"].tolist(), df["lonfinal"].tolist(),
            df["tiempoinicial"].tolist(), df["tiempofinal"].tolist(),
            (df["carga"] / DIAS_LABORALES).tolist(), df["horarango"].tolist(),
        )


def _metro_parquet(hora):
    columnas = ["estacioninicial", "estacionfinal",
                "latinicial", "loninicial", "latfinal", "lonfinal",
                "tiempoinicial", "tiempofinal", "peso", "horarango", "tipodia"]
    salida = columnas[:9]

    def mascara(lote):
        return pc.and_(pc.equal(lote.column("horarango"), int(hora)),
                       pc.equal(lote.column("tipodia"), "LABORAL"))

    for df in _lotes(PARQUET_METRO, columnas, mascara):
        df = df[df[salida[2:8]].notna().all(axis=1)]
        if df.empty:
            continue
        # Vectorized conversion of "HH:MM:SS" to datetime.time (replaces a
        # per-row strptime, which dominated the read time).
        tIni = pd.to_datetime(df["tiempoinicial"], format="%H:%M:%S").dt.time
        tFin = pd.to_datetime(df["tiempofinal"], format="%H:%M:%S").dt.time
        yield from zip(
            df["estacioninicial"].tolist(), df["estacionfinal"].tolist(),
            df["latinicial"].tolist(), df["loninicial"].tolist(),
            df["latfinal"].tolist(), df["lonfinal"].tolist(),
            tIni.tolist(), tFin.tolist(),
            (df["peso"] / DIAS_LABORALES).tolist(),
        )


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------
def leer_segmentos_buses(hora):
    print(f"[FuenteDatos] buses hour {hora} from {PARQUET_BUSES}")
    return _buses_parquet(hora)


def leer_segmentos_metro(hora):
    print(f"[FuenteDatos] metro hour {hora} from {PARQUET_METRO}")
    return _metro_parquet(hora)
