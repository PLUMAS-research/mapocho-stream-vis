import json


def suavizarMatriz(rutaVectoresEntrada, rutaPesosEntrada,
                   rutaVectoresSalida, rutaPesosSalida, vecinosPorCelda):
    """Smooths the field over each cell and its H3 neighbors (precomputed in
    the grid, field `vecinos`). The weight is averaged arithmetically and the
    vector is averaged weighted by load, as in the previous version; only the
    neighborhood lookup changed (it now comes directly from the H3 grid)."""
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
        # The current cell plus its H3 neighbors.
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

    print(f"Original load: {cargaTotalOriginal:.6f} | new: {nuevaCargaTotal:.6f} "
          f"| relative diff: {diferenciaRelativa:.4f}%")

    # Rounding on write to shrink the JSON with no visible effect: vectors are
    # ~1e-3 (8 decimals preserve the direction) and weights are expanded
    # passengers (2 decimals are enough).
    vectoresRed = [[round(x, 8), round(y, 8)] for x, y in nuevosVectores]
    pesosRed = [round(p, 2) for p in nuevosPesos]
    with open(rutaVectoresSalida, 'w') as f:
        json.dump(vectoresRed, f)

    with open(rutaPesosSalida, 'w') as f:
        json.dump({"CargaTotal": round(nuevaCargaTotal, 2), "MatrizPesos": pesosRed}, f)
