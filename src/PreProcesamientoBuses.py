# Projection of segments onto the H3 grid. Given a leg origin -> destination
# (lat/lon), returns the local ids of the H3 cells it crosses, using the H3
# cell line between the origin cell and the destination cell. Replaces the
# axial rasterization of the previous custom grid.
import h3


def rutasHexagonos(latitudInicial, longitudInicial, latitudFinal, longitudFinal,
                   resolucion, h3ToId):
    """
    Local ids of the cells crossed by the origin -> destination segment.
    Input:
        start and end lat/lon of the leg, the H3 resolution, and h3ToId
        (map from H3 index to local grid id).
    Output: list of local ids (empty if the endpoints fall outside the grid).
    """
    origen = h3.latlng_to_cell(latitudInicial, longitudInicial, resolucion)
    destino = h3.latlng_to_cell(latitudFinal, longitudFinal, resolucion)

    if origen == destino:
        celdas = [origen]
    else:
        try:
            celdas = h3.grid_path_cells(origen, destino)
        except Exception:
            # grid_path_cells fails when the cells are too far apart; in that
            # case we record at least the endpoints.
            celdas = [origen, destino]

    return [h3ToId[c] for c in celdas if c in h3ToId]
