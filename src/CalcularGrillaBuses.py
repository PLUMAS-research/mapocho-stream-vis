import json
import numpy as np
from FuenteDatos import leer_segmentos_buses
from math import radians, cos, sin, asin, sqrt
from datetime import timedelta
import time
from PreProcesamientoBuses import rutasHexagonos

# Velocidad máxima plausible de un bus (km/h); sobre esto el segmento se
# descarta como outlier. El paper documenta este filtro de >100 km/h.
VELOCIDAD_MAX_KMH = 100


def haversine(lat1, lon1, lat2, lon2):
    # Se calcula la distancia en km entre dos puntos geográficos
    R = 6371  # Radio de la Tierra en km
    dLat = radians(lat2 - lat1)
    dLon = radians(lon2 - lon1)
    a = sin(dLat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dLon/2)**2
    return R * 2 * asin(sqrt(a))

def tiempoMinutos(horaInicio, horaFin):
    """Calcula la diferencia en minutos entre dos timestamps"""
    if horaFin < horaInicio:
        horaFin += timedelta(days=1)
    return (horaFin - horaInicio).total_seconds() / 60.0


def processGrillaBuses(resolucion: int, horaRango: int):
    horaInicial = time.time()
    print(f"\n{'='*50}")
    print(f"Procesando hora {horaRango} con resolución H3 {resolucion}")
    print(f"{'='*50}")

    # Cargar geometría H3 de la grilla
    sufijo = f"r{resolucion}"
    try:
        with open(f'json/Hexagon_{sufijo}.json', 'r', encoding='utf-8') as f:
            hexData = json.load(f)

        nHexagonos = hexData['numCeldas']
        h3ToId = {c: i for i, c in enumerate(hexData['celdas'])}
        print(f"Geometría H3 cargada: {nHexagonos} celdas (resolución {resolucion})")
    except FileNotFoundError:
        print(f"Error: archivo de geometría no encontrado (json/Hexagon_{sufijo}.json)")
        raise

    # Iterador de segmentos por lotes (no materializa la hora completa).
    registros = leer_segmentos_buses(horaRango)

    # Inicializar matrices para hexágonos
    vectoresHexagonos = np.zeros((nHexagonos, 2), dtype=np.float64)
    pesosHexagonos = np.zeros(nHexagonos, dtype=np.float64)

    totalRegistros = 0
    registrosValidos = 0
    registrosInvalidos = 0
    totalCarga = 0.0

    for row in registros:
        if totalRegistros % 100000 == 0:
            print(f"Registro numero: {totalRegistros}")

        id, latIni, lonIni, latFin, lonFin, tIni, tFin, carga, horarango = row
        
        # Convertir a float
        latIni = float(latIni)
        lonIni = float(lonIni)
        latFin = float(latFin)
        lonFin = float(lonFin)
        carga = float(carga)

        totalRegistros += 1

        try:
            # Calcular tiempo en minutos
            tiempoMin = tiempoMinutos(tIni, tFin)
            
            # 1. Evitar división por cero
            if tiempoMin <= 0:
                registrosInvalidos += 1
                continue
                
            # 2. Filtrar outliers por velocidad
            distancia = haversine(latIni, lonIni, latFin, lonFin)
            velocidad_kmh = distancia / (tiempoMin / 60)  # km/h
            
            if velocidad_kmh > VELOCIDAD_MAX_KMH:  # descartar buses demasiado rápidos
                registrosInvalidos += 1
                continue
                
        except Exception as e:
            print(f"Error en registro {id}: {e}")
            registrosInvalidos += 1
            continue

        # Calcular vector unitario por minuto
        unitLon = (lonFin - lonIni) / tiempoMin
        unitLat = (latFin - latIni) / tiempoMin

        # Obtener las celdas H3 en la ruta
        try:
            hexIds = rutasHexagonos(latIni, lonIni, latFin, lonFin, resolucion, h3ToId)
        except Exception as e:
            print(f"Error en rutasHexagonos: {e}")
            registrosInvalidos += 1
            continue
        
        # Procesar cada hexágono en la ruta
        for hexId in hexIds:
            if 0 <= hexId < nHexagonos:
                vectoresHexagonos[hexId, 0] += unitLon * carga
                vectoresHexagonos[hexId, 1] += unitLat * carga
                pesosHexagonos[hexId] += carga
                totalCarga += carga
        
        registrosValidos += 1

    print(f"Total de registros procesados: {totalRegistros}")
    print(f"  - Registros válidos: {registrosValidos}")
    print(f"  - Registros descartados: {registrosInvalidos}")
    print(f"Total de contribuciones a la grilla: {totalCarga}")

    MAX_VECTOR_THRESHOLD = 3

    # Normalizar vectores
    for hexId in range(nHexagonos):
        peso = pesosHexagonos[hexId]
        if peso > 0.0:
            vectoresHexagonos[hexId, 0] /= peso
            vectoresHexagonos[hexId, 1] /= peso

            # Detección de anomalías
            magnitud = sqrt(vectoresHexagonos[hexId, 0]**2 + vectoresHexagonos[hexId, 1]**2)
            if magnitud > MAX_VECTOR_THRESHOLD:
                print(f"Anómalo en hexágono {hexId}: peso={peso:.8f}, "
                      f"vector=({vectoresHexagonos[hexId, 0]:.4f}, {vectoresHexagonos[hexId, 1]:.4f})")

    # Guardar resultados
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

    print(f"✅ Grillas para hora {horaRango} guardadas.")
    deltaTiempo = time.time() - horaInicial
    print(f"Tiempo: {deltaTiempo:.2f} segundos")

    # Devolver las rutas de los archivos generados
    return rutaVectores, rutaPesos
    
