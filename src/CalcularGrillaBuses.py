import json
import numpy as np
from FuenteDatos import leer_segmentos_buses
from math import radians, cos, sin, asin, sqrt
from datetime import timedelta
import time
from PreProcesamientoBuses import rutasHexagonos

# Maximum plausible bus speed (km/h); above this the segment is discarded as
# an outlier. The paper documents this >100 km/h filter.
VELOCIDAD_MAX_KMH = 100


def haversine(lat1, lon1, lat2, lon2):
    # Distance in km between two geographic points
    R = 6371  # Earth radius in km
    dLat = radians(lat2 - lat1)
    dLon = radians(lon2 - lon1)
    a = sin(dLat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dLon/2)**2
    return R * 2 * asin(sqrt(a))

def tiempoMinutos(horaInicio, horaFin):
    """Difference in minutes between two timestamps"""
    if horaFin < horaInicio:
        horaFin += timedelta(days=1)
    return (horaFin - horaInicio).total_seconds() / 60.0


def processGrillaBuses(resolucion: int, horaRango: int):
    horaInicial = time.time()
    print(f"\n{'='*50}")
    print(f"Processing hour {horaRango} with H3 resolution {resolucion}")
    print(f"{'='*50}")

    # Load the H3 grid geometry
    sufijo = f"r{resolucion}"
    try:
        with open(f'json/Hexagon_{sufijo}.json', 'r', encoding='utf-8') as f:
            hexData = json.load(f)

        nHexagonos = hexData['numCeldas']
        h3ToId = {c: i for i, c in enumerate(hexData['celdas'])}
        print(f"H3 geometry loaded: {nHexagonos} cells (resolution {resolucion})")
    except FileNotFoundError:
        print(f"Error: geometry file not found (json/Hexagon_{sufijo}.json)")
        raise

    # Batched segment iterator (does not materialize the whole hour).
    registros = leer_segmentos_buses(horaRango)

    # Initialize the hexagon matrices
    vectoresHexagonos = np.zeros((nHexagonos, 2), dtype=np.float64)
    pesosHexagonos = np.zeros(nHexagonos, dtype=np.float64)

    totalRegistros = 0
    registrosValidos = 0
    registrosInvalidos = 0
    totalCarga = 0.0

    for row in registros:
        if totalRegistros % 100000 == 0:
            print(f"Record number: {totalRegistros}")

        id, latIni, lonIni, latFin, lonFin, tIni, tFin, carga, horarango = row

        # Convert to float
        latIni = float(latIni)
        lonIni = float(lonIni)
        latFin = float(latFin)
        lonFin = float(lonFin)
        carga = float(carga)

        totalRegistros += 1

        try:
            # Compute the time in minutes
            tiempoMin = tiempoMinutos(tIni, tFin)

            # 1. Avoid division by zero
            if tiempoMin <= 0:
                registrosInvalidos += 1
                continue

            # 2. Filter outliers by speed
            distancia = haversine(latIni, lonIni, latFin, lonFin)
            velocidad_kmh = distancia / (tiempoMin / 60)  # km/h

            if velocidad_kmh > VELOCIDAD_MAX_KMH:  # discard buses that are too fast
                registrosInvalidos += 1
                continue

        except Exception as e:
            print(f"Error in record {id}: {e}")
            registrosInvalidos += 1
            continue

        # Compute the unit vector per minute
        unitLon = (lonFin - lonIni) / tiempoMin
        unitLat = (latFin - latIni) / tiempoMin

        # Get the H3 cells along the route
        try:
            hexIds = rutasHexagonos(latIni, lonIni, latFin, lonFin, resolucion, h3ToId)
        except Exception as e:
            print(f"Error in rutasHexagonos: {e}")
            registrosInvalidos += 1
            continue

        # Process each hexagon along the route
        for hexId in hexIds:
            if 0 <= hexId < nHexagonos:
                vectoresHexagonos[hexId, 0] += unitLon * carga
                vectoresHexagonos[hexId, 1] += unitLat * carga
                pesosHexagonos[hexId] += carga
                totalCarga += carga

        registrosValidos += 1

    print(f"Total records processed: {totalRegistros}")
    print(f"  - Valid records: {registrosValidos}")
    print(f"  - Discarded records: {registrosInvalidos}")
    print(f"Total contributions to the grid: {totalCarga}")

    MAX_VECTOR_THRESHOLD = 3

    # Normalize the vectors
    for hexId in range(nHexagonos):
        peso = pesosHexagonos[hexId]
        if peso > 0.0:
            vectoresHexagonos[hexId, 0] /= peso
            vectoresHexagonos[hexId, 1] /= peso

            # Anomaly detection
            magnitud = sqrt(vectoresHexagonos[hexId, 0]**2 + vectoresHexagonos[hexId, 1]**2)
            if magnitud > MAX_VECTOR_THRESHOLD:
                print(f"Anomalous hexagon {hexId}: peso={peso:.8f}, "
                      f"vector=({vectoresHexagonos[hexId, 0]:.4f}, {vectoresHexagonos[hexId, 1]:.4f})")

    # Save results
    rutaVectores = f"./json/MatrizVectoresBuses_{sufijo}_{horaRango}.json"
    with open(rutaVectores, "w") as f:
        json.dump(vectoresHexagonos.tolist(), f, indent=2)

    resultado = {
        "CargaTotal": totalCarga,
        "MatrizPesos": pesosHexagonos.tolist()
    }

    rutaPesos = f"./json/MatrizPesosBuses_{sufijo}_{horaRango}.json"
    with open(rutaPesos, "w") as f:
        json.dump(resultado, f, indent=2)

    print(f"Grids for hour {horaRango} saved.")
    deltaTiempo = time.time() - horaInicial
    print(f"Time: {deltaTiempo:.2f} seconds")

    # Return the paths of the generated files
    return rutaVectores, rutaPesos
