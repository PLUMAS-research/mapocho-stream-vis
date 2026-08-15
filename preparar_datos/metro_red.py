"""Red de Metro: grafo, ruteo y segmentación de etapas.

Reconstruye la ruta de una etapa de Metro (estación de subida -> estación de
bajada) como la secuencia de estaciones intermedias por la red, y la parte en
segmentos estación a estación con tiempos interpolados.

La topología (qué estaciones tiene cada línea, en qué orden) ya no vive aquí:
se deriva del feed GTFS (`gtfs_a_metro.py`, route_type 1) y se materializa en
`src/json/RedMetro.json`, que los consumidores cargan y pasan a
`construir_grafo`. Los nombres de estación van en mayúsculas sin acentos, como
en los datos DTPM (IRARRAZAVAL, NUNOA, BIO BIO, etc.).
"""

from collections import defaultdict
from datetime import datetime, timedelta

import networkx as nx

# Pesos del ruteo: un transbordo equivale a 6 tramos de viaje.
PESO_TRAMO = 1
PESO_TRANSBORDO = 6


def construir_grafo(lineas):
    """Arma el grafo de la red desde `lineas` ({linea: [estaciones en orden]}).
    Cada nodo es 'ESTACION_LINEA'; las aristas unen estaciones contiguas de una
    línea y conectan los nodos de una misma estación en distintas líneas
    (transbordo).

    El orden de iteración de `lineas` importa para la reproducibilidad: cuando
    dos rutas empatan en costo, Dijkstra desempata según el orden de inserción
    de nodos y aristas. `RedMetro.json` fija ese orden (ver gtfs_a_metro.py)."""
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
    """Camino más corto entre dos estaciones (por nombre). Devuelve la secuencia
    de estaciones intermedias, ya colapsando los nodos de transbordo. Devuelve
    lista vacía si alguna estación no existe o no hay camino."""
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
    """Parte una secuencia de estaciones en segmentos contiguos y reparte el
    tiempo de la etapa de forma uniforme entre ellos. `t_subida` y `t_bajada`
    son datetime. Devuelve tuplas (estIni, estFin, horaIni, horaFin) con horas
    como objetos time."""
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
