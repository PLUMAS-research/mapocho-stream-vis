import json


def suavizarMatriz(rutaVectoresEntrada, rutaPesosEntrada,
                   rutaVectoresSalida, rutaPesosSalida, vecinosPorCelda):
    """Suaviza el campo sobre cada celda y sus vecinos H3 (precalculados en la
    grilla, campo `vecinos`). El peso se promedia aritméticamente y el vector se
    promedia ponderado por peso, igual que la versión anterior; solo cambia la
    forma de obtener la vecindad (ahora es directa desde la grilla H3)."""
    with open(rutaVectoresEntrada, 'r') as f:
        matrizVectores = json.load(f)

    with open(rutaPesosEntrada, 'r') as f:
        datosPesos = json.load(f)
        matrizPesos = datosPesos["MatrizPesos"]
        cargaTotalOriginal = datosPesos["CargaTotal"]

    numCeldas = len(vecinosPorCelda)
    nuevosVectores = [[0.0, 0.0] for _ in range(numCeldas)]
    nuevosPesos = [0.0] * numCeldas

    for idx in range(numCeldas):
        # La celda actual más sus vecinos H3.
        indices = vecinosPorCelda[idx] + [idx]

        sumaPesos = sum(matrizPesos[i] for i in indices)
        nuevosPesos[idx] = sumaPesos / len(indices)

        sumaVectorX = 0.0
        sumaVectorY = 0.0
        for i in indices:
            peso = matrizPesos[i]
            sumaVectorX += peso * matrizVectores[i][0]
            sumaVectorY += peso * matrizVectores[i][1]

        if sumaPesos > 0:
            nuevosVectores[idx][0] = sumaVectorX / sumaPesos
            nuevosVectores[idx][1] = sumaVectorY / sumaPesos
        else:
            nuevosVectores[idx] = matrizVectores[idx][:]

    nuevaCargaTotal = sum(nuevosPesos)
    if cargaTotalOriginal != 0:
        diferenciaRelativa = abs(nuevaCargaTotal - cargaTotalOriginal) / cargaTotalOriginal * 100
    else:
        diferenciaRelativa = 0 if nuevaCargaTotal == 0 else 100

    print(f"Carga original: {cargaTotalOriginal:.6f} | nueva: {nuevaCargaTotal:.6f} "
          f"| dif. relativa: {diferenciaRelativa:.4f}%")

    # Redondeo al escribir para achicar los JSON sin efecto visible: los vectores
    # son ~1e-3 (8 decimales preservan la dirección) y los pesos son pasajeros
    # expandidos (2 decimales bastan).
    vectoresRed = [[round(x, 8), round(y, 8)] for x, y in nuevosVectores]
    pesosRed = [round(p, 2) for p in nuevosPesos]
    with open(rutaVectoresSalida, 'w') as f:
        json.dump(vectoresRed, f)

    with open(rutaPesosSalida, 'w') as f:
        json.dump({"CargaTotal": round(nuevaCargaTotal, 2), "MatrizPesos": pesosRed}, f)
