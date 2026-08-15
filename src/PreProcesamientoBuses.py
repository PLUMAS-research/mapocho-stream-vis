# Proyección de segmentos sobre la grilla H3. Dado un tramo origen -> destino
# (lat/lon), devuelve los ids locales de las celdas H3 que atraviesa, usando la
# línea de celdas de H3 entre la celda de origen y la de destino. Reemplaza el
# rasterizado axial de la grilla custom anterior.
import h3


def rutasHexagonos(latitudInicial, longitudInicial, latitudFinal, longitudFinal,
                   resolucion, h3ToId):
    """
    Ids locales de las celdas por las que pasa el segmento origen -> destino.
    Entrada:
        lat/lon inicial y final del tramo, la resolución H3, y h3ToId
        (mapa índice H3 -> id local de la grilla).
    Salida: lista de ids locales (vacía si los extremos caen fuera de la grilla).
    """
    origen = h3.latlng_to_cell(latitudInicial, longitudInicial, resolucion)
    destino = h3.latlng_to_cell(latitudFinal, longitudFinal, resolucion)

    if origen == destino:
        celdas = [origen]
    else:
        try:
            celdas = h3.grid_path_cells(origen, destino)
        except Exception:
            # grid_path_cells falla si las celdas quedan demasiado lejos; en
            # ese caso registramos al menos los extremos.
            celdas = [origen, destino]

    return [h3ToId[c] for c in celdas if c in h3ToId]
