import json
import numpy as np
from FuenteDatos import leer_segmentos_metro
from math import radians, cos, sin, asin, sqrt
from datetime import datetime, timedelta
import time
import multiprocessing
import os


def tiempoMinutos(horaInicio, horaFin):
    """Calcula la diferencia en minutos entre dos timestamps"""

    fecha_ref = datetime(2023, 8, 8)
    dtInicio = datetime.combine(fecha_ref.date(), horaInicio)
    dtFin = datetime.combine(fecha_ref.date(), horaFin)
  
    if dtFin < dtInicio:
        dtFin += timedelta(days=1)
    
    return (dtFin - dtInicio).total_seconds() / 60.0

def processGrillaMetro(resolucion: int, horaRango: int):
    """Procesa una hora específica del día"""
    print(f"\n{'='*50}")
    print(f"Comenzando procesamiento para hora {horaRango} - Resolución H3: {resolucion}")
    print(f"{'='*50}")

    horaInicial = time.time()
    sufijo = f"r{resolucion}"
    
    # Carga de rutas precalculadas
    try:
        with open(f'json/HexMetro_{sufijo}.json', 'r', encoding='utf-8') as f:
            rutas = json.load(f)
        print(f"[DEBUG] Rutas precalculadas cargadas ({len(rutas)} entradas)")
    except FileNotFoundError:
        print(f"Error: archivo de rutas de metro no encontrado (json/HexMetro_{sufijo}.json)")
        raise

    # Cargar geometría H3 de la grilla
    try:
        with open(f'json/Hexagon_{sufijo}.json', 'r', encoding='utf-8') as f:
            hexData = json.load(f)
        nHexagonos = hexData['numCeldas']
        print(f"[DEBUG] Geometría H3 cargada: {nHexagonos} celdas")
    except FileNotFoundError:
        print(f"Error: archivo de geometría no encontrado (json/Hexagon_{sufijo}.json)")
        raise
    
    # Iterador de segmentos por lotes (no materializa la hora completa).
    registros = leer_segmentos_metro(horaRango)

    # Inicializar matrices
    vectoresHexagonos = np.zeros((nHexagonos, 2), dtype=np.float64)
    pesosHexagonos = np.zeros(nHexagonos, dtype=np.float64)
    totalVectores = 0
    registrosInvalidos = 0
    totalCarga = 0

    for row in registros:
        estInicial, estFinal, latInicial, lonInicial, latFinal, lonFinal, tiempoinicial, tiempofinal, peso = row
        totalVectores += 1
        
        # Construir clave y buscar hexágonos
        key1 = f"{estInicial}->{estFinal}"
        key2 = f"{estFinal}->{estInicial}"
        hexIds = rutas.get(key1) or rutas.get(key2)

        if not hexIds:
            registrosInvalidos += 1
            if registrosInvalidos <= 5:
                print(f"Ruta no encontrada: {key1} (o {key2})")
            continue
            

        # Calcular vector (por hora completa)
        tiempoMin = tiempoMinutos(tiempoinicial, tiempofinal)
        # Evitar división por cero y tiempos inválidos
        if tiempoMin <= 0:
            registrosInvalidos += 1
            continue
        vectorLon = (lonFinal - lonInicial) / tiempoMin  
        vectorLat = (latFinal - latInicial) / tiempoMin

        # Para cada hexágono, sumar peso y vector ponderado. El vector se
        # multiplica por peso para que la normalización (division por la suma
        # de pesos) sea una media ponderada, igual que en buses. Con el peso
        # historico de 1.0 ambas formas coincidian; con factor_expansion no.
        for hexId in hexIds:
            if 0 <= hexId < nHexagonos:
                pesosHexagonos[hexId] += peso
                vectoresHexagonos[hexId, 0] += vectorLon * peso
                vectoresHexagonos[hexId, 1] += vectorLat * peso
                totalCarga += peso

    print(f"[DEBUG] Total registros: {totalVectores}")
    print(f"[DEBUG] Rutas faltantes: {registrosInvalidos}")

    # Normalizar vectores por peso
    for hexId in range(nHexagonos):
        peso = pesosHexagonos[hexId]
        if peso > 0:
            vectoresHexagonos[hexId, 0] /= peso
            vectoresHexagonos[hexId, 1] /= peso

    # Al final de la función processGrillaMetro:

    # Guardar resultados
    archivoVectores = f"json/MatrizVectoresMetro_{sufijo}_{horaRango}.json"
    with open(archivoVectores, "w") as f:
        json.dump(vectoresHexagonos.tolist(), f, indent=2)

    archivoPesos = f"json/MatrizPesosMetro_{sufijo}_{horaRango}.json"
    with open(archivoPesos, "w") as f:
        json.dump({
            "CargaTotal": totalCarga,
            "MatrizPesos": pesosHexagonos.tolist()
        }, f, indent=2)

    print(f"Grillas para hora {horaRango} guardadas.")
    deltaTiempo = time.time() - horaInicial
    print(f"Tiempo: {deltaTiempo:.2f} segundos")
    
    # Retornar nombres de archivos generados
    return totalVectores, archivoVectores, archivoPesos