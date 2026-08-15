"""Fuente de datos de segmentos para la agregación.

El pipeline lee dos conjuntos de segmentos dirigidos: buses y Metro, desde
json/segmentos/{buses,metro}.parquet (producidos por
preparar_datos/dtpm_a_segmentos.py). No usa base de datos.

Contrato de salida:
- leer_segmentos_buses(hora) -> iterador de tuplas
    (id, latIni, lonIni, latFin, lonFin, tIni, tFin, carga, horarango)
    con tIni/tFin como datetime.datetime.
- leer_segmentos_metro(hora) -> iterador de tuplas
    (estIni, estFin, latIni, lonIni, latFin, lonFin, tIni, tFin, peso)
    con tIni/tFin como datetime.time.

Las dos funciones devuelven generadores que recorren el parquet por lotes
(ParquetFile.iter_batches) y filtran cada lote por hora. La memoria por
proceso queda acotada por el lote (TAMANO_LOTE, configurable por entorno) y
el row group, no por el tamaño del archivo: con el año completo (~164 M de
segmentos de Metro, ~20 M en la hora pico) la versión anterior materializaba
la hora entera como lista de tuplas (~4 GB por proceso) y con 17 procesos en
paralelo gatillaba el OOM killer. Medido sobre la hora pico, esta versión
mantiene el proceso bajo ~0.6 GB.
"""

import os
from pathlib import Path

import pandas as pd
import pyarrow.compute as pc
import pyarrow.parquet as pq

# Rutas de los parquet de segmentos (relativas al cwd, que es src/).
DIR_SEGMENTOS = Path(os.environ.get("DIR_SEGMENTOS", "json/segmentos"))
PARQUET_BUSES = DIR_SEGMENTOS / "buses.parquet"
PARQUET_METRO = DIR_SEGMENTOS / "metro.parquet"

# Filas por lote de lectura. Con ~250k filas cada lote pesa unas decenas de MB.
TAMANO_LOTE = int(os.environ.get("TAMANO_LOTE", "262144"))


def _dias_laborales():
    """Días laborales distintos del extracto, desde metadatos.json (default 1).

    Los pesos (carga/peso = factor_expansion) se dividen por este número al
    leer, de modo que las matrices agregadas representen un día laboral
    promedio y no la suma del extracto completo. Las paletas y umbrales del
    visualizador asumen esa escala. metadatos.json lo escribe
    preparar_datos/dtpm_a_segmentos.py.
    """
    import json
    ruta = DIR_SEGMENTOS / "metadatos.json"
    try:
        with open(ruta, encoding="utf-8") as f:
            return max(1, int(json.load(f)["dias_laborales"]))
    except (FileNotFoundError, KeyError, ValueError):
        print(f"[FuenteDatos] sin {ruta}; pesos sin normalizar por día")
        return 1


DIAS_LABORALES = _dias_laborales()


def _lotes(ruta, columnas, mascara):
    """Recorre el parquet por lotes filtrados, como DataFrames chicos.

    mascara(lote) -> BooleanArray con las filas de la hora pedida. Se filtra
    lote a lote (no hay pushdown útil: los row groups mezclan todas las
    horas), y solo las filas que sobreviven se convierten a pandas.
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
        # .tolist() sobre datetime64 entrega pd.Timestamp (subclase de
        # datetime.datetime), compatible con la aritmética de los consumidores.
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
        # Conversión vectorizada de "HH:MM:SS" a datetime.time (reemplaza un
        # strptime por fila, que dominaba el tiempo de lectura).
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
# API pública
# --------------------------------------------------------------------------
def leer_segmentos_buses(hora):
    print(f"[FuenteDatos] buses hora {hora} desde {PARQUET_BUSES}")
    return _buses_parquet(hora)


def leer_segmentos_metro(hora):
    print(f"[FuenteDatos] metro hora {hora} desde {PARQUET_METRO}")
    return _metro_parquet(hora)
