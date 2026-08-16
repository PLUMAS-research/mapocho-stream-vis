import os
import json
import multiprocessing
import time
import h3
from CalcularGrillaBuses import processGrillaBuses
from CalcularGrillaMetro import processGrillaMetro
from SuavizarMatriz import suavizarMatriz

def cargarVecinos(sufijo):
    """Derives the neighbor list per cell from the H3 grid (the 6 adjacent
    cells that fall inside the grid, by local id), for the smoothing."""
    try:
        with open(f'json/Hexagon_{sufijo}.json', 'r', encoding='utf-8') as f:
            hexData = json.load(f)
        celdas = hexData["celdas"]
        h3ToId = {c: i for i, c in enumerate(celdas)}
        return [[h3ToId[n] for n in h3.grid_disk(c, 1) if n != c and n in h3ToId]
                for c in celdas]
    except FileNotFoundError as e:
        print(f"Critical error: geometry file not found: {e}")
        raise

def procesarHora(resolucion, hora, vecesSuavizadoBuses, vecesSuavizadoMetro):
    """Processes one hour for buses and Metro, applies smoothing, and organizes the files"""
    sufijo = f"r{resolucion}"

    try:
        vecinos = cargarVecinos(sufijo)
    except Exception as e:
        print(f"Fatal error at hour {hora}: {e}")
        return f"Hour {hora} failed"

    # Process buses and get the temporary file paths
    print(f"\n{'='*50}")
    print(f"PROCESSING BUSES - Hour: {hora}")
    print(f"{'='*50}")
    tempVectoresBuses, tempPesosBuses = processGrillaBuses(resolucion, hora)

    # Create the directories for the final results
    os.makedirs(f'json/buses/{hora}', exist_ok=True)
    finalVectoresBuses = f'json/buses/{hora}/MatrizVectoresBuses_{sufijo}_{hora}.json'
    finalPesosBuses = f'json/buses/{hora}/MatrizPesosBuses_{sufijo}_{hora}.json'

    # Multiple smoothing passes for buses
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

            # Remove intermediate temporary files
            if archivoVectoresEntradaBuses != tempVectoresBuses:
                os.remove(archivoVectoresEntradaBuses)
                os.remove(archivoPesosEntradaBuses)

            archivoVectoresEntradaBuses = archivoVectoresSalidaBuses
            archivoPesosEntradaBuses = archivoPesosSalidaBuses
    else:
        # With no smoothing, just move the files
        os.rename(tempVectoresBuses, finalVectoresBuses)
        os.rename(tempPesosBuses, finalPesosBuses)

    # Remove bus temporaries if they exist
    if vecesSuavizadoBuses > 0 and os.path.exists(tempVectoresBuses):
        os.remove(tempVectoresBuses)
        os.remove(tempPesosBuses)

    # Process Metro and get the temporary file paths
    print(f"\n{'='*50}")
    print(f"PROCESSING METRO - Hour: {hora}")
    print(f"{'='*50}")
    _, tempVectoresMetro, tempPesosMetro = processGrillaMetro(resolucion, hora)

    # Create the directories for the final results
    os.makedirs(f'json/metro/{hora}', exist_ok=True)
    finalVectoresMetro = f'json/metro/{hora}/MatrizVectoresMetro_{sufijo}_{hora}.json'
    finalPesosMetro = f'json/metro/{hora}/MatrizPesosMetro_{sufijo}_{hora}.json'

    # Multiple smoothing passes for Metro
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

            # Remove intermediate temporary files
            if archivoVectoresEntradaMetro != tempVectoresMetro:
                os.remove(archivoVectoresEntradaMetro)
                os.remove(archivoPesosEntradaMetro)

            archivoVectoresEntradaMetro = archivoVectoresSalidaMetro
            archivoPesosEntradaMetro = archivoPesosSalidaMetro
    else:
        # With no smoothing, just move the files
        os.rename(tempVectoresMetro, finalVectoresMetro)
        os.rename(tempPesosMetro, finalPesosMetro)

    # Remove Metro temporaries if they exist
    if vecesSuavizadoMetro > 0 and os.path.exists(tempVectoresMetro):
        os.remove(tempVectoresMetro)
        os.remove(tempPesosMetro)

    return f"Hour {hora} completed"

def main(resolucion, vecesSuavizadoBuses, vecesSuavizadoMetro):
    start_time = time.time()

    # Parallel processes (one per hour). Configurable with the PROCESOS
    # environment variable; default cores - 3. Memory per process is bounded
    # by the batched reads of FuenteDatos (see TAMANO_LOTE there); if the
    # machine still runs short, lower PROCESOS.
    nucleos = multiprocessing.cpu_count()
    procesos = max(1, int(os.environ.get("PROCESOS", nucleos - 3)))

    print(f"\n{'='*50}")
    print(f"STARTING PROCESSING - H3 resolution: {resolucion}")
    print(f"Available cores: {nucleos} | Using: {procesos} (set PROCESOS to change it)")
    print(f"Smoothing passes, buses: {vecesSuavizadoBuses} | Metro: {vecesSuavizadoMetro}")
    print(f"{'='*50}")

    # Process the hours in parallel
    with multiprocessing.Pool(procesos) as pool:
        resultados = pool.starmap(
            procesarHora,
            [(resolucion, hora, vecesSuavizadoBuses, vecesSuavizadoMetro) for hora in range(24)]
        )

    # Show the results
    print(f"\n{'='*50}")
    print("FINAL SUMMARY")
    for res in resultados:
        print(f"- {res}")
    print(f"Total time: {time.time() - start_time:.2f} seconds")
    print(f"{'='*50}")

if __name__ == "__main__":
    # Configurable H3 resolution (same variable as CreacionGrilla.py and the
    # rest of the pipeline). res 9 ~= 15,060 cells over Greater Santiago.
    resolucion = int(os.environ.get("RESOLUCION_H3", 9))

    # Number of smoothing passes.
    # Buses 3 / Metro 1: Metro concentrates its flow on few lines and
    # aggregates well without blurring (the configuration the paper documents).
    vecesSuavizadoBuses = 3
    vecesSuavizadoMetro = 1

    main(resolucion, vecesSuavizadoBuses, vecesSuavizadoMetro)
