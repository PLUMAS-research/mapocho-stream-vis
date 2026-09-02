# Mapocho

Flujos de transporte público en el Gran Santiago. El nombre viene del río que cruza la ciudad. Parte de Proyecto **Learning Origin-destination Inference through Cross-Source Analytics (LOICA)**, ANID Fondecyt Regular 1261835.

Visualización de la demanda de buses Red y Metro como campos vectoriales por hora sobre una grilla hexagonal (H3, celdas de unos 115 m de ancho). Las estelas animadas muestran dirección y carga del flujo (la velocidad sigue la magnitud local del campo), los glifos de vector entregan dirección y magnitud por celda, y el mapa de calor la densidad de demanda.

**DATOS**: Tablas de viajes de DTPM estimadas con la metodología ADATRAP a partir de transacciones bip! y GPS de buses; extracto de 10 días laborales (abril y agosto de 2023), expresado como día laboral promedio. La geometría de la red proviene del GTFS de DTPM. 

**CRÉDITOS**: **Alonso Almendras Troncoso** y **Eduardo Graells-Garrido**, Departamento de Ciencias de la Computación, Universidad de Chile. La ilustración de la loica es obra de **Sarai Collilef**. Construida con React, deck.gl y MapLibre GL; basemap © OpenStreetMap contributors, © CARTO.
