// CalcularParticulas.js (CommonJS)
const fs = require('fs');
const path = require('path');

// Configuration - number of particles to precompute
const CANTIDAD_PARTICULAS = 4000;

// H3 resolution suffix of the input matrices (same variable as the Python
// pipeline). Default r9.
const SUFIJO = 'r' + (process.env.RESOLUCION_H3 || '9');

// Exponent of the seed allocation per hexagon. With 1.0 the allocation is
// proportional to the load and the seeds concentrate on the main corridors;
// with a sublinear exponent the density stays ordered by demand but also
// covers secondary corridors (same logic as the square-root streamlet width).
const EXPONENTE_ASIGNACION = 0.6;

// Minimum load per hexagon to seed. It matches the threshold below which the
// visualizer does not draw the streamlet; seeding below it wastes particles.
const UMBRAL_PESO = 10;

// Hours of the day to process (0-23)
const HORAS = Array.from({ length: 24 }, (_, i) => i);

// Transport modes to process
const MODOS = ['buses', 'metro'];

// Loads the data of one specific hour
function cargarDatosHora(hora, modo) {
  try {
    console.log(`Loading data for ${modo} at ${hora}:00...`);

    // Two digits for the directory
    const horaFormateada = hora.toString().padStart(2, '0');
    // The file name uses the number without leading zeros
    const horaArchivo = hora.toString();
    const nombreModoCapitalizado = modo.charAt(0).toUpperCase() + modo.slice(1);

    // Build the path
    const ruta = path.join(
      __dirname,
      'json',
      modo,
      horaArchivo,
      `MatrizPesos${nombreModoCapitalizado}_${SUFIJO}_${horaArchivo}.json`
    );

    console.log(`Looking for file at: ${ruta}`);

    if (!fs.existsSync(ruta)) {
      console.error(`File not found: ${ruta}`);
      return null;
    }

    const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    console.log(`Data for ${modo} at ${hora}:00 loaded successfully`);
    return datos;
  } catch (error) {
    console.error(`Error loading data for ${modo} hour ${hora}:`, error);
    return null;
  }
}

// Computes the particle distribution and the cumulative sum
function calcularDistribucionParticulas(matrizPesos, cargaSistema, totalParticulas) {

  // With zero system load there are no particles to distribute
  if (cargaSistema === 0) {
    return null;
  }

  const nHexagonos = matrizPesos.length;
  const sumaAcumulada = new Array(nHexagonos);

  // Total allocation mass: sum of weight^exponent over the seedable hexagons
  // (weight >= threshold).
  let masaTotal = 0;
  for (let i = 0; i < nHexagonos; i++) {
    if (matrizPesos[i] >= UMBRAL_PESO) {
      masaTotal += Math.pow(matrizPesos[i], EXPONENTE_ASIGNACION);
    }
  }
  if (masaTotal === 0) {
    return null;
  }

  // Precompute random numbers for consistency
  const numerosAleatorios = new Array(nHexagonos);
  for (let i = 0; i < nHexagonos; i++) {
    numerosAleatorios[i] = Math.random();
  }

  let sumaActual = 0;

  // Compute the distribution and the cumulative sum in one pass
  for (let hexId = 0; hexId < nHexagonos; hexId++) {
    const peso = matrizPesos[hexId];

    if (peso < UMBRAL_PESO) {
      sumaAcumulada[hexId] = sumaActual;
      continue;
    }

    // Expected number of particles for this hexagon (stochastic rounding)
    const particulasFloat =
      (Math.pow(peso, EXPONENTE_ASIGNACION) * totalParticulas) / masaTotal;
    const parteEntera = Math.floor(particulasFloat);
    const fraccion = particulasFloat - parteEntera;
    const aleatorio = numerosAleatorios[hexId];
    const particulasEnteras = parteEntera + (aleatorio < fraccion ? 1 : 0);

    // Update the cumulative sum
    sumaActual += particulasEnteras;
    sumaAcumulada[hexId] = sumaActual;
  }

  return sumaAcumulada;
}

// Main function to precompute every particle
function precalcularParticulas() {
  console.log('Starting particle preprocessing...');

  // Cumulative distributions per mode and hour
  const distribucionesAcumuladas = {
    buses: {},
    metro: {}
  };

  // Process each mode and hour to compute the cumulative distributions
  for (const modo of MODOS) {
    console.log(`\nProcessing mode: ${modo}`);

    for (const hora of HORAS) {
      console.log(`Processing hour: ${hora}:00`);

      const datos = cargarDatosHora(hora, modo);
      if (datos) {
        const distribucion = calcularDistribucionParticulas(
          datos.MatrizPesos, datos.CargaTotal, CANTIDAD_PARTICULAS
        );
        distribucionesAcumuladas[modo][hora] = distribucion === null ? undefined : distribucion;
      }

      console.log(`Hour ${hora}:00 processed for mode ${modo}`);
    }

    console.log(`Mode ${modo} complete`);
  }

  console.log('\nComputing the hexagon assignment per particle...');

  // Particles with their initial hexagons per hour
  const particulasPrecalculadas = {
    buses: [],
    metro: []
  };

  // Process each mode to assign hexagons to the particles
  for (const modo of MODOS) {
    console.log(`\nAssigning hexagons for mode: ${modo}`);

    // Initialize search indices per hour, as an optimization
    const indicesActualesPorHora = {};
    for (const hora of HORAS) {
      indicesActualesPorHora[hora] = 0;
    }

    // Create the particles for this mode
    for (let idParticula = 0; idParticula < CANTIDAD_PARTICULAS; idParticula++) {
      const hexIdInicialesPorHora = new Array(24);

      // For each hour, find the hexagon of this particle
      for (const hora of HORAS) {
        if (!distribucionesAcumuladas[modo][hora]) {
          hexIdInicialesPorHora[hora] = 0; // Default value
          continue;
        }

        const sumaAcumulada = distribucionesAcumuladas[modo][hora];
        let indiceActual = indicesActualesPorHora[hora];

        // Optimization: start from the current index instead of 0
        while (indiceActual < sumaAcumulada.length && idParticula >= sumaAcumulada[indiceActual]) {
          indiceActual++;
        }

        // Keep the current index for the next particle
        indicesActualesPorHora[hora] = indiceActual;

        // Stay within bounds
        hexIdInicialesPorHora[hora] = Math.min(indiceActual, sumaAcumulada.length - 1);
      }

      // Add the precomputed particle
      particulasPrecalculadas[modo].push({
        id: idParticula,
        hexIdIniciales: hexIdInicialesPorHora,
        tipo: modo
      });
    }

    console.log(`Mode ${modo}: ${CANTIDAD_PARTICULAS} particles processed`);
  }

  console.log('\nParticle preprocessing complete');
  return particulasPrecalculadas;
}

// Saves the precomputed data in an optimized format
function guardarParticulasPrecalculadas(nombreArchivo = 'particulasPrecalculadas.json') {
  try {
    console.log('Saving precomputed particles...');

    const particulas = precalcularParticulas();

    // Check that the particles are not empty
    if (!particulas || Object.keys(particulas).length === 0) {
      throw new Error('No particles were generated. Check the input data.');
    }

    // Check that each mode has particles
    for (const modo of MODOS) {
      if (!particulas[modo] || particulas[modo].length === 0) {
        console.warn(`No particles generated for mode ${modo}`);
      } else {
        console.log(`Mode ${modo}: ${particulas[modo].length} particles generated`);
      }
    }

    // Structure optimized for fast access
    const datosOptimizados = {
      cantidadParticulas: CANTIDAD_PARTICULAS,
      particulas: particulas
    };

    // Save the file with 2-space indentation
    fs.writeFileSync(nombreArchivo, JSON.stringify(datosOptimizados, null, 2));

    console.log(`Precomputed particles saved to ${nombreArchivo}`);
    return datosOptimizados;
  } catch (error) {
    console.error('Error saving precomputed particles:', error);
    throw error;
  }
}

// Run the main function when this file is executed directly
if (require.main === module) {
  guardarParticulasPrecalculadas();
}

// Export functions for external use
module.exports = {
  precalcularParticulas,
  guardarParticulasPrecalculadas,
  CANTIDAD_PARTICULAS
};
