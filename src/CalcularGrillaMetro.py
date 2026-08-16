import json
import numpy as np
from FuenteDatos import leer_segmentos_metro
from math import radians, cos, sin, asin, sqrt
from datetime import datetime, timedelta
import time
import multiprocessing
import os


def tiempoMinutos(horaInicio, horaFin):
    """Difference in minutes between two timestamps"""

    fecha_ref = datetime(2023, 8, 8)
    dtInicio = datetime.combine(fecha_ref.date(), horaInicio)
    dtFin = datetime.combine(fecha_ref.date(), horaFin)

    if dtFin < dtInicio:
        dtFin += timedelta(days=1)

    return (dtFin - dtInicio).total_seconds() / 60.0

def processGrillaMetro(resolucion: int, horaRango: int):
    """Processes one specific hour of the day"""
    print(f"\n{'='*50}")
    print(f"Starting processing for hour {horaRango} - H3 resolution: {resolucion}")
    print(f"{'='*50}")

    horaInicial = time.time()
    sufijo = f"r{resolucion}"

    # Load precomputed routes
    try:
        with open(f'json/HexMetro_{sufijo}.json', 'r', encoding='utf-8') as f:
            rutas = json.load(f)
        print(f"[DEBUG] Precomputed routes loaded ({len(rutas)} entries)")
    except FileNotFoundError:
        print(f"Error: metro routes file not found (json/HexMetro_{sufijo}.json)")
        raise

    # Load the H3 grid geometry
    try:
        with open(f'json/Hexagon_{sufijo}.json', 'r', encoding='utf-8') as f:
            hexData = json.load(f)
        nHexagonos = hexData['numCeldas']
        print(f"[DEBUG] H3 geometry loaded: {nHexagonos} cells")
    except FileNotFoundError:
        print(f"Error: geometry file not found (json/Hexagon_{sufijo}.json)")
        raise

    # Batched segment iterator (does not materialize the whole hour).
    registros = leer_segmentos_metro(horaRango)

    # Initialize matrices
    vectoresHexagonos = np.zeros((nHexagonos, 2), dtype=np.float64)
    pesosHexagonos = np.zeros(nHexagonos, dtype=np.float64)
    totalVectores = 0
    registrosInvalidos = 0
    totalCarga = 0

    for row in registros:
        estInicial, estFinal, latInicial, lonInicial, latFinal, lonFinal, tiempoinicial, tiempofinal, peso = row
        totalVectores += 1

        # Build the key and look up the hexagons
        key1 = f"{estInicial}->{estFinal}"
        key2 = f"{estFinal}->{estInicial}"
        hexIds = rutas.get(key1) or rutas.get(key2)

        if not hexIds:
            registrosInvalidos += 1
            if registrosInvalidos <= 5:
                print(f"Route not found: {key1} (or {key2})")
            continue


        # Compute the vector (per full hour)
        tiempoMin = tiempoMinutos(tiempoinicial, tiempofinal)
        # Avoid division by zero and invalid times
        if tiempoMin <= 0:
            registrosInvalidos += 1
            continue
        vectorLon = (lonFinal - lonInicial) / tiempoMin
        vectorLat = (latFinal - latInicial) / tiempoMin

        # For each hexagon, add the weight and the weighted vector. The vector
        # is multiplied by the weight so that the normalization (division by
        # the sum of weights) is a weighted mean, as in buses. With the
        # historical weight of 1.0 both forms coincided; with
        # factor_expansion they do not.
        for hexId in hexIds:
            if 0 <= hexId < nHexagonos:
                pesosHexagonos[hexId] += peso
                vectoresHexagonos[hexId, 0] += vectorLon * peso
                vectoresHexagonos[hexId, 1] += vectorLat * peso
                totalCarga += peso

    print(f"[DEBUG] Total records: {totalVectores}")
    print(f"[DEBUG] Missing routes: {registrosInvalidos}")

    # Normalize vectors by weight
    for hexId in range(nHexagonos):
        peso = pesosHexagonos[hexId]
        if peso > 0:
            vectoresHexagonos[hexId, 0] /= peso
            vectoresHexagonos[hexId, 1] /= peso

    # At the end of processGrillaMetro:

    # Save results
    archivoVectores = f"json/MatrizVectoresMetro_{sufijo}_{horaRango}.json"
    with open(archivoVectores, "w") as f:
        json.dump(vectoresHexagonos.tolist(), f, indent=2)

    archivoPesos = f"json/MatrizPesosMetro_{sufijo}_{horaRango}.json"
    with open(archivoPesos, "w") as f:
        json.dump({
            "CargaTotal": totalCarga,
            "MatrizPesos": pesosHexagonos.tolist()
        }, f, indent=2)

    print(f"Grids for hour {horaRango} saved.")
    deltaTiempo = time.time() - horaInicial
    print(f"Time: {deltaTiempo:.2f} seconds")

    # Return the generated file names
    return totalVectores, archivoVectores, archivoPesos
