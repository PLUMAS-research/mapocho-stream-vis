# Contrato de datos del pipeline

La pipeline de agregación lee dos conjuntos tabulares de segmentos de viaje desde `src/json/segmentos/{buses,metro}.parquet`. Este documento describe qué columnas debe entregar esa fuente para que el pipeline corra sin modificar la lógica de agregación.

Este es el contrato de **nivel segmentos**, el más bajo de los dos que tiene el sistema. El contrato de **nivel viajes + GTFS** (etapas de viaje referidas a un feed GTFS, pensado para que otra ciudad corra el flujo completo de conversión) está en `preparar_datos/README.md`, sección "Contrato de entrada genérico".

Importante: no hay base de datos. El frontend lee JSON precalculados en `src/json/`. Los parquet de segmentos solo se necesitan para **regenerar** esos JSON con datos nuevos, y los produce el flujo DTPM.

> **Para generar datos desde los viajes DTPM**, no sigas este documento a mano: usa el flujo automatizado en `preparar_datos/` (ver `preparar_datos/README.md`). Convierte los viajes DTPM en los dos parquet de segmentos descritos abajo y corre todo el pipeline. Este documento describe el contrato de bajo nivel, útil si traes datos de otra fuente.

## Punto único de conexión

Todo el acceso a datos pasa por `src/FuenteDatos.py`, que expone `leer_segmentos_buses(hora)` y `leer_segmentos_metro(hora)` y lee los parquet. `CalcularGrillaBuses.py` y `CalcularGrillaMetro.py` solo llaman a esas funciones. Cada lector devuelve, por hora, un iterador de filas (tuplas) en el orden de columnas que espera la agregación; la lectura es por lotes, así que la memoria no depende del tamaño del archivo.

El esquema de los parquet está en la sección "Esquema intermedio" de `preparar_datos/README.md`. Para traer datos de otra fuente (CSV, DuckDB, etc.), basta hacer que `FuenteDatos.py` devuelva las mismas tuplas; el resto del pipeline opera sobre tuplas en memoria.

> Las tablas SQL que se describen abajo (`vectoresbuses*`, `vectoresmetro*`) son referencia histórica del esquema de columnas y de la semántica de los campos. El pipeline ya no usa PostgreSQL.

## Tabla de buses

Nombre actual: `vectoresbuses082023` (el sufijo `082023` indica agosto 2023). La consulta en `CalcularGrillaBuses.py` es:

```sql
SELECT id, latinicial, loninicial, latfinal, lonfinal,
       tiempoinicial, tiempofinal, carga, horarango
FROM vectoresbuses082023
WHERE carga > 0 AND horarango = %s
  AND latinicial IS NOT NULL AND loninicial IS NOT NULL
  AND latfinal  IS NOT NULL AND lonfinal  IS NOT NULL
  AND tiempoinicial IS NOT NULL AND tiempofinal IS NOT NULL
  AND carga IS NOT NULL
```

Cada fila es un segmento dirigido entre dos paraderos consecutivos de un bus.

| Columna | Tipo | Significado |
|---|---|---|
| `id` | entero | Identificador del segmento. |
| `latinicial`, `loninicial` | float (WGS84) | Coordenada del paradero de origen. |
| `latfinal`, `lonfinal` | float (WGS84) | Coordenada del paradero de destino. |
| `tiempoinicial`, `tiempofinal` | timestamp | Hora de salida y de llegada del segmento. |
| `carga` | número | Pasajeros a bordo al iniciar el segmento. Es el peso del segmento. |
| `horarango` | entero 0–23 | Hora del día a la que pertenece el segmento. Particiona el procesamiento. |

Filtros que el pipeline asume: `carga > 0` y todas las columnas no nulas. Si la fuente nueva no garantiza esto, hay que filtrarlo antes de entregar las filas.

## Tabla de Metro

Nombre actual: `vectoresmetro112023` (el sufijo `112023` indica noviembre 2023). La consulta en `CalcularGrillaMetro.py` es:

```sql
SELECT estacioninicial, estacionfinal,
       latinicial, loninicial, latfinal, lonfinal,
       tiempoinicial, tiempofinal
FROM vectoresmetro112023
WHERE tipodia = 'LABORAL' AND horarango = %s
  AND latinicial IS NOT NULL AND loninicial IS NOT NULL
  AND latfinal  IS NOT NULL AND lonfinal  IS NOT NULL
  AND tiempoinicial IS NOT NULL AND tiempofinal IS NOT NULL
```

Cada fila es un segmento estación a estación de una ruta reconstruida. El Metro no expone GPS, así que la ruta se reconstruye antes (grafo de la red + Dijkstra) y se materializa en esta tabla.

| Columna | Tipo | Significado |
|---|---|---|
| `estacioninicial`, `estacionfinal` | texto | Estaciones de origen y destino del segmento. |
| `latinicial`, `loninicial` | float (WGS84) | Coordenada de la estación de origen. |
| `latfinal`, `lonfinal` | float (WGS84) | Coordenada de la estación de destino. |
| `tiempoinicial`, `tiempofinal` | timestamp | Hora de entrada y de salida del segmento. |
| `horarango` | entero 0–23 | Hora del día. Se usa en el `WHERE`. |
| `tipodia` | texto | Tipo de día. El pipeline filtra `'LABORAL'`. |

A diferencia de los buses, esta tabla histórica no traía `carga`, y el pipeline le asignaba peso 1 a cada segmento de Metro (pesos no comparables entre modos). En el flujo vigente eso ya no aplica: el parquet de Metro trae `peso` = `factor_expansion`, el mismo peso de demanda expandida que usan los buses (ver `preparar_datos/README.md`).

## Notas

- El sufijo del nombre de tabla codifica el mes y año del extracto (`082023` = agosto 2023, `112023` = noviembre 2023). Si cambias la ventana temporal, cambia el nombre de tabla en las dos consultas o usa el mismo nombre y reemplaza el contenido.
- `horarango` particiona todo el procesamiento. `Main.py` corre las 24 horas en paralelo, una por proceso.
- Las coordenadas deben estar en WGS84 (latitud/longitud en grados), porque el cálculo de distancias usa Haversine y la malla hexagonal asume ese sistema.
- Construcción de estas tablas a partir de datos crudos ADATRAP (tablas `Profiles`, `paraderos`, `Etapas`, metadatos de estaciones): ver el diccionario de datos en `thesis/proposal.tex`. Esa etapa es previa al pipeline y queda fuera de este contrato.
