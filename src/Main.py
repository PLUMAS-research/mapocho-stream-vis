import os
import json
import multiprocessing
import time
import h3
from CalcularGrillaBuses import processGrillaBuses
from CalcularGrillaMetro import processGrillaMetro
from SuavizarMatriz import suavizarMatriz

def cargarVecinos(sufijo):
    """Deriva la lista de vecinos por celda desde la grilla H3 (los 6 adyacentes
    que caen dentro de la grilla, por id local), para el suavizado."""
    try:
        with open(f'json/Hexagon_{sufijo}.json', 'r', encoding='utf-8') as f:
            hexData = json.load(f)
        celdas = hexData["celdas"]
        h3ToId = {c: i for i, c in enumerate(celdas)}
        return [[h3ToId[n] for n in h3.grid_disk(c, 1) if n != c and n in h3ToId]
                for c in celdas]
    except FileNotFoundError as e:
        print(f"Error crítico: archivo de geometría no encontrado: {e}")
        raise

def procesarHora(resolucion, hora, vecesSuavizadoBuses, vecesSuavizadoMetro):
    """Procesa una hora específica para buses y metro, aplica suavizado y organiza archivos"""
    sufijo = f"r{resolucion}"

    try:
        vecinos = cargarVecinos(sufijo)
    except Exception as e:
        print(f"Error fatal en hora {hora}: {e}")
        return f"Hora {hora} falló"

    # Procesar buses y obtener rutas de archivos temporales
    print(f"\n{'='*50}")
    print(f"PROCESANDO BUSES - Hora: {hora}")
    print(f"{'='*50}")
    tempVectoresBuses, tempPesosBuses = processGrillaBuses(resolucion, hora)

    # Crear directorios para resultados finales
    os.makedirs(f'json/buses/{hora}', exist_ok=True)
    finalVectoresBuses = f'json/buses/{hora}/MatrizVectoresBuses_{sufijo}_{hora}.json'
    finalPesosBuses = f'json/buses/{hora}/MatrizPesosBuses_{sufijo}_{hora}.json'

    # Suavizado múltiple para buses
    if vecesSuavizadoBuses > 0:
        archivoVectoresEntradaBuses = tempVectoresBuses
        archivoPesosEntradaBuses = tempPesosBuses

        for i in range(vecesSuavizadoBuses):
            esUltimaIteracion = (i == vecesSuavizadoBuses - 1)

            archivoVectoresSalidaBuses = (
                finalVectoresBuses if esUltimaIteracion
                else f'{tempVectoresBuses}_temp_buses_{i}.json'
            )
            archivoPesosSalidaBuses = (
                finalPesosBuses if esUltimaIteracion
                else f'{tempPesosBuses}_temp_buses_{i}.json'
            )

            suavizarMatriz(
                archivoVectoresEntradaBuses,
                archivoPesosEntradaBuses,
                archivoVectoresSalidaBuses,
                archivoPesosSalidaBuses,
                vecinos
            )

            # Eliminar archivos temporales intermedios
            if archivoVectoresEntradaBuses != tempVectoresBuses:
                os.remove(archivoVectoresEntradaBuses)
                os.remove(archivoPesosEntradaBuses)

            archivoVectoresEntradaBuses = archivoVectoresSalidaBuses
            archivoPesosEntradaBuses = archivoPesosSalidaBuses
    else:
        # Si no hay suavizado, simplemente copiar los archivos
        os.rename(tempVectoresBuses, finalVectoresBuses)
        os.rename(tempPesosBuses, finalPesosBuses)

    # Eliminar temporales buses si existen
    if vecesSuavizadoBuses > 0 and os.path.exists(tempVectoresBuses):
        os.remove(tempVectoresBuses)
        os.remove(tempPesosBuses)

    # Procesar metro y obtener rutas de archivos temporales
    print(f"\n{'='*50}")
    print(f"PROCESANDO METRO - Hora: {hora}")
    print(f"{'='*50}")
    _, tempVectoresMetro, tempPesosMetro = processGrillaMetro(resolucion, hora)

    # Crear directorios para resultados finales
    os.makedirs(f'json/metro/{hora}', exist_ok=True)
    finalVectoresMetro = f'json/metro/{hora}/MatrizVectoresMetro_{sufijo}_{hora}.json'
    finalPesosMetro = f'json/metro/{hora}/MatrizPesosMetro_{sufijo}_{hora}.json'

    # Suavizado múltiple para metro
    if vecesSuavizadoMetro > 0:
        archivoVectoresEntradaMetro = tempVectoresMetro
        archivoPesosEntradaMetro = tempPesosMetro

        for i in range(vecesSuavizadoMetro):
            esUltimaIteracion = (i == vecesSuavizadoMetro - 1)

            archivoVectoresSalidaMetro = (
                finalVectoresMetro if esUltimaIteracion
                else f'{tempVectoresMetro}_temp_metro_{i}.json'
            )
            archivoPesosSalidaMetro = (
                finalPesosMetro if esUltimaIteracion
                else f'{tempPesosMetro}_temp_metro_{i}.json'
            )

            suavizarMatriz(
                archivoVectoresEntradaMetro,
                archivoPesosEntradaMetro,
                archivoVectoresSalidaMetro,
                archivoPesosSalidaMetro,
                vecinos
            )

            # Eliminar archivos temporales intermedios
            if archivoVectoresEntradaMetro != tempVectoresMetro:
                os.remove(archivoVectoresEntradaMetro)
                os.remove(archivoPesosEntradaMetro)

            archivoVectoresEntradaMetro = archivoVectoresSalidaMetro
            archivoPesosEntradaMetro = archivoPesosSalidaMetro
    else:
        # Si no hay suavizado, simplemente copiar los archivos
        os.rename(tempVectoresMetro, finalVectoresMetro)
        os.rename(tempPesosMetro, finalPesosMetro)

    # Eliminar temporales metro si existen
    if vecesSuavizadoMetro > 0 and os.path.exists(tempVectoresMetro):
        os.remove(tempVectoresMetro)
        os.remove(tempPesosMetro)

    return f"Hora {hora} completada"

def main(resolucion, vecesSuavizadoBuses, vecesSuavizadoMetro):
    start_time = time.time()

    # Procesos en paralelo (uno por hora). Configurable con la variable de
    # entorno PROCESOS; por defecto núcleos - 3. La memoria por proceso queda
    # acotada por la lectura por lotes de FuenteDatos (ver TAMANO_LOTE ahí);
    # si aún así la máquina se queda corta, bajar PROCESOS.
    nucleos = multiprocessing.cpu_count()
    procesos = max(1, int(os.environ.get("PROCESOS", nucleos - 3)))

    print(f"\n{'='*50}")
    print(f"INICIANDO PROCESAMIENTO - Resolución H3: {resolucion}")
    print(f"Núcleos disponibles: {nucleos} | Usando: {procesos} (PROCESOS para cambiarlo)")
    print(f"Veces suavizado buses: {vecesSuavizadoBuses} | Veces suavizado metro: {vecesSuavizadoMetro}")
    print(f"{'='*50}")

    # Procesar en paralelo por hora
    with multiprocessing.Pool(procesos) as pool:
        resultados = pool.starmap(
            procesarHora,
            [(resolucion, hora, vecesSuavizadoBuses, vecesSuavizadoMetro) for hora in range(24)]
        )

    # Mostrar resultados
    print(f"\n{'='*50}")
    print("RESUMEN FINAL")
    for res in resultados:
        print(f"- {res}")
    print(f"Tiempo total: {time.time() - start_time:.2f} segundos")
    print(f"{'='*50}")

if __name__ == "__main__":
    # Resolución H3 configurable (misma variable que CreacionGrilla.py y el resto
    # del pipeline). res 9 ~= 15.060 celdas sobre el Gran Santiago.
    resolucion = int(os.environ.get("RESOLUCION_H3", 9))

    # Variables para controlar la cantidad de suavizados
    # Buses 3 / Metro 1: el Metro concentra su flujo en pocas líneas y agrega
    # bien sin difuminar (misma configuración que documenta el paper, D-impl).
    vecesSuavizadoBuses = 3
    vecesSuavizadoMetro = 1

    main(resolucion, vecesSuavizadoBuses, vecesSuavizadoMetro)
