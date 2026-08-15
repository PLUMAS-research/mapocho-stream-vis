// CalcularParticulas.js (CommonJS)
const fs = require('fs');
const path = require('path');

// Configuración - cantidad de partículas a precalcular
const CANTIDAD_PARTICULAS = 4000;

// Sufijo de resolución H3 de las matrices de entrada (misma variable que el
// pipeline Python). Por defecto r9.
const SUFIJO = 'r' + (process.env.RESOLUCION_H3 || '9');

// Exponente de la asignación de semillas por hexágono. Con 1.0 la asignación
// es proporcional a la carga y las semillas se concentran en los corredores
// principales; con un exponente sublineal la densidad sigue ordenada por
// demanda pero cubre también corredores secundarios (misma lógica que el
// ancho de estela en raíz de la carga).
const EXPONENTE_ASIGNACION = 0.6;

// Carga mínima por hexágono para sembrar. Coincide con el umbral bajo el
// cual el visualizador no dibuja la estela; sembrar bajo él desperdicia
// partículas.
const UMBRAL_PESO = 10;

// Horas del día a procesar (0-23)
const HORAS = Array.from({ length: 24 }, (_, i) => i);

// Modos de transporte a procesar
const MODOS = ['buses', 'metro'];

// Función para cargar datos de una hora específica
function cargarDatosHora(hora, modo) {
  try {
    console.log(`Cargando datos para ${modo} a las ${hora}:00...`);
    
    // Para el directorio usamos dos dígitos
    const horaFormateada = hora.toString().padStart(2, '0');
    // Para el nombre del archivo usamos el número sin ceros a la izquierda
    const horaArchivo = hora.toString();
    const nombreModoCapitalizado = modo.charAt(0).toUpperCase() + modo.slice(1);
    
    // Construir la ruta correctamente
    const ruta = path.join(
      __dirname, 
      'json', 
      modo, 
      horaArchivo, 
      `MatrizPesos${nombreModoCapitalizado}_${SUFIJO}_${horaArchivo}.json`
    );
    
    console.log(`Buscando archivo en: ${ruta}`);
    
    // Resto del código sin cambios...
    if (!fs.existsSync(ruta)) {
      console.error(`Archivo no encontrado: ${ruta}`);
      return null;
    }
    
    const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    console.log(`Datos para ${modo} a las ${hora}:00 cargados exitosamente`);
    return datos;
  } catch (error) {
    console.error(`Error cargando datos para ${modo} hora ${hora}:`, error);
    return null;
  }
}

// Función para calcular la distribución de partículas y la suma acumulada
function calcularDistribucionParticulas(matrizPesos, cargaSistema, totalParticulas) {

  // Si la carga del sistema es 0, no hay partículas para distribuir
  if (cargaSistema === 0) {
    return null;
  }

  const nHexagonos = matrizPesos.length;
  const sumaAcumulada = new Array(nHexagonos);

  // Masa total de asignación: suma de peso^exponente sobre los hexágonos
  // sembrables (peso >= umbral).
  let masaTotal = 0;
  for (let i = 0; i < nHexagonos; i++) {
    if (matrizPesos[i] >= UMBRAL_PESO) {
      masaTotal += Math.pow(matrizPesos[i], EXPONENTE_ASIGNACION);
    }
  }
  if (masaTotal === 0) {
    return null;
  }

  // Precalcular números aleatorios para consistencia
  const numerosAleatorios = new Array(nHexagonos);
  for (let i = 0; i < nHexagonos; i++) {
    numerosAleatorios[i] = Math.random();
  }

  let sumaActual = 0;

  // Calcular distribución y suma acumulada en un solo paso
  for (let hexId = 0; hexId < nHexagonos; hexId++) {
    const peso = matrizPesos[hexId];

    if (peso < UMBRAL_PESO) {
      sumaAcumulada[hexId] = sumaActual;
      continue;
    }

    // Cantidad esperada de partículas para este hexágono (redondeo estocástico)
    const particulasFloat =
      (Math.pow(peso, EXPONENTE_ASIGNACION) * totalParticulas) / masaTotal;
    const parteEntera = Math.floor(particulasFloat);
    const fraccion = particulasFloat - parteEntera;
    const aleatorio = numerosAleatorios[hexId];
    const particulasEnteras = parteEntera + (aleatorio < fraccion ? 1 : 0);

    // Actualizar suma acumulada
    sumaActual += particulasEnteras;
    sumaAcumulada[hexId] = sumaActual;
  }

  return sumaAcumulada;
}

// Función principal para precalcular todas las partículas
function precalcularParticulas() {
  console.log('Iniciando preprocesamiento de partículas...');
  
  // Almacenar distribuciones acumuladas por modo y hora
  const distribucionesAcumuladas = {
    buses: {},
    metro: {}
  };

  // Procesar cada modo y hora para calcular distribuciones acumuladas
  for (const modo of MODOS) {
    console.log(`\nProcesando modo: ${modo}`);
    
    for (const hora of HORAS) {
      console.log(`Procesando hora: ${hora}:00`);
      
      const datos = cargarDatosHora(hora, modo);
      if (datos) {
        const distribucion = calcularDistribucionParticulas(
          datos.MatrizPesos, datos.CargaTotal, CANTIDAD_PARTICULAS
        );
        distribucionesAcumuladas[modo][hora] = distribucion === null ? undefined : distribucion;
      }
      
      console.log(`Hora ${hora}:00 procesada para modo ${modo}`);
    }
    
    console.log(`Modo ${modo} completado`);
  }

  console.log('\nCalculando asignación de hexágonos por partícula...');
  
  // Calcular las partículas con sus hexágonos iniciales por hora
  const particulasPrecalculadas = {
    buses: [],
    metro: []
  };

  // Procesar cada modo para asignar hexágonos a las partículas
  for (const modo of MODOS) {
    console.log(`\nAsignando hexágonos para modo: ${modo}`);
    
    // Inicializar índices de búsqueda por hora para optimización
    const indicesActualesPorHora = {};
    for (const hora of HORAS) {
      indicesActualesPorHora[hora] = 0;
    }

    // Crear las partículas para este modo
    for (let idParticula = 0; idParticula < CANTIDAD_PARTICULAS; idParticula++) {
      const hexIdInicialesPorHora = new Array(24);
      
      // Para cada hora, encontrar el hexágono correspondiente a esta partícula
      for (const hora of HORAS) {
        if (!distribucionesAcumuladas[modo][hora]) {
          hexIdInicialesPorHora[hora] = 0; // Valor por defecto
          continue;
        }
        
        const sumaAcumulada = distribucionesAcumuladas[modo][hora];
        let indiceActual = indicesActualesPorHora[hora];
        
        // Optimización: comenzar desde el índice actual en lugar de desde 0
        while (indiceActual < sumaAcumulada.length && idParticula >= sumaAcumulada[indiceActual]) {
          indiceActual++;
        }
        
        // Guardar el índice actual para la próxima partícula
        indicesActualesPorHora[hora] = indiceActual;
        
        // Asegurarse de que no exceda los límites
        hexIdInicialesPorHora[hora] = Math.min(indiceActual, sumaAcumulada.length - 1);
      }
      
      // Agregar la partícula precalculada
      particulasPrecalculadas[modo].push({
        id: idParticula,
        hexIdIniciales: hexIdInicialesPorHora,
        tipo: modo
      });
    }
    
    console.log(`Modo ${modo}: ${CANTIDAD_PARTICULAS} partículas procesadas`);
  }

  console.log('\nPreprocesamiento de partículas completado');
  return particulasPrecalculadas;
}

// Función para guardar los datos precalculados en un formato optimizado
function guardarParticulasPrecalculadas(nombreArchivo = 'particulasPrecalculadas.json') {
  try {
    console.log('Iniciando guardado de partículas precalculadas...');
    
    const particulas = precalcularParticulas();
    
    // Verificar que las partículas no estén vacías
    if (!particulas || Object.keys(particulas).length === 0) {
      throw new Error('No se generaron partículas. Verifica los datos de entrada.');
    }
    
    // Verificar que hay partículas para cada modo
    for (const modo of MODOS) {
      if (!particulas[modo] || particulas[modo].length === 0) {
        console.warn(`No se generaron partículas para el modo ${modo}`);
      } else {
        console.log(`Modo ${modo}: ${particulas[modo].length} partículas generadas`);
      }
    }
    
    // Estructura optimizada para acceso rápido
    const datosOptimizados = {
      cantidadParticulas: CANTIDAD_PARTICULAS,
      particulas: particulas
    };
    
    // Guardar el archivo con indentación de 2 espacios
    fs.writeFileSync(nombreArchivo, JSON.stringify(datosOptimizados, null, 2));
    
    console.log(`Partículas precalculadas guardadas en ${nombreArchivo}`);
    return datosOptimizados;
  } catch (error) {
    console.error('Error guardando partículas precalculadas:', error);
    throw error;
  }
}

// Ejecutar la función principal si este archivo es ejecutado directamente
if (require.main === module) {
  guardarParticulasPrecalculadas();
}

// Exportar funciones para uso externo
module.exports = {
  precalcularParticulas,
  guardarParticulasPrecalculadas,
  CANTIDAD_PARTICULAS
};