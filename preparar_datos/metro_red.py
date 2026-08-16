"""Metro network: graph, routing, and stage segmentation.

Reconstructs the route of a Metro stage (boarding station -> alighting
station) as the sequence of intermediate stations over the network, and
splits it into station-to-station segments with interpolated times.

The topology (which stations each line has, in which order) no longer lives
here: it is derived from the GTFS feed (`gtfs_a_metro.py`, route_type 1) and
materialized in `src/json/RedMetro.json`, which consumers load and pass to
`construir_grafo`. Station names are uppercase without accents, as in the
DTPM data (IRARRAZAVAL, NUNOA, BIO BIO, etc.).
"""

from collections import defaultdict
from datetime import datetime, timedelta

import networkx as nx

# Routing weights: one transfer is equivalent to 6 travel legs.
PESO_TRAMO = 1
PESO_TRANSBORDO = 6


def construir_grafo(lineas):
    """Builds the network graph from `lineas` ({line: [stations in order]}).
    Each node is 'STATION_LINE'; edges join contiguous stations of a line and
    connect the nodes of the same station on different lines (transfer).

    The iteration order of `lineas` matters for reproducibility: when two
    routes tie in cost, Dijkstra breaks the tie according to the insertion
    order of nodes and edges. `RedMetro.json` fixes that order (see
    gtfs_a_metro.py)."""
    G = nx.Graph()
    nombre_a_nodos = defaultdict(list)
    for linea, estaciones in lineas.items():
        for i, estacion in enumerate(estaciones):
            nodo = f"{estacion}_{linea}"
            G.add_node(nodo, label=estacion, line=linea)
            nombre_a_nodos[estacion].append(nodo)
            if i > 0:
                G.add_edge(f"{estaciones[i-1]}_{linea}", nodo, weight=PESO_TRAMO)
    for nodos in nombre_a_nodos.values():
        for i in range(len(nodos)):
            for j in range(i + 1, len(nodos)):
                G.add_edge(nodos[i], nodos[j], weight=PESO_TRANSBORDO)
    return G


def camino_estaciones(grafo, inicio, fin):
    """Shortest path between two stations (by name). Returns the sequence of
    intermediate stations, collapsing the transfer nodes. Returns an empty
    list if a station does not exist or there is no path."""
    nodos_ini = [n for n in grafo.nodes if grafo.nodes[n]["label"] == inicio]
    nodos_fin = [n for n in grafo.nodes if grafo.nodes[n]["label"] == fin]
    if not nodos_ini or not nodos_fin:
        return []

    mejor, menor = None, float("inf")
    for ni in nodos_ini:
        for nf in nodos_fin:
            try:
                largo = nx.shortest_path_length(grafo, ni, nf, weight="weight")
                if largo < menor:
                    camino = nx.shortest_path(grafo, ni, nf, weight="weight")
                    menor, mejor = largo, camino
            except nx.NetworkXNoPath:
                continue
    if mejor is None:
        return []

    estaciones = []
    ultima = None
    for nodo in mejor:
        est = grafo.nodes[nodo]["label"]
        if est != ultima:
            estaciones.append(est)
            ultima = est
    return estaciones


def segmentos_con_tiempo(estaciones, t_subida, t_bajada):
    """Splits a station sequence into contiguous segments and divides the
    stage time uniformly among them. `t_subida` and `t_bajada` are datetime.
    Returns tuples (estIni, estFin, horaIni, horaFin) with hours as time
    objects."""
    if len(estaciones) < 2:
        return []
    total = (t_bajada - t_subida).total_seconds()
    if total <= 0:
        return []

    n = len(estaciones) - 1
    dur = total / n
    out = []
    actual = t_subida
    for i in range(n):
        siguiente = actual + timedelta(seconds=dur)
        out.append((estaciones[i], estaciones[i + 1], actual.time(), siguiente.time()))
        actual = siguiente
    return out
