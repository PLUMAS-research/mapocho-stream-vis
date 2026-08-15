class ContadorPesos {
    constructor() {
        this.datos = {
            'buses': Array.from({length: 24}, () => []),
            'metro': Array.from({length: 24}, () => [])
        };
        this.completo = {
            'buses': Array(24).fill(false),
            'metro': Array(24).fill(false)
        };
        this.todosCompletos = false;
    }

    agregarPeso(tipo, hora, peso) {
        // Descartar pesos con valor 0
        if (peso === 0) {
            return false;
        }

        // Validar parámetros
        if (!['buses', 'metro'].includes(tipo)) {
            console.error(`Tipo ${tipo} no válido. Debe ser 'buses' o 'metro'.`);
            return false;
        }

        if (hora < 0 || hora > 23) {
            console.error(`Hora ${hora} no válida. Debe estar entre 0 y 23.`);
            return false;
        }

        // No procesar si ya está completo
        if (this.completo[tipo][hora]) {
            return false;
        }

        // Agregar peso
        this.datos[tipo][hora].push(peso);

        // Verificar si se completó esta hora
        if (this.datos[tipo][hora].length >= 1000) {
            this.completo[tipo][hora] = true;
            console.log(`¡Completado! ${tipo} - Hora ${hora}: 1000 datos recolectados`);
            
            // Verificar si todos están completos
            this.verificarCompletitud();
        }

        return true;
    }

    verificarCompletitud() {
        // Verificar buses (todas las horas)
        const busesCompleto = this.completo['buses'].every(completo => completo);
        
        // Verificar metro (solo horas 6-23)
        const metroCompleto = this.completo['metro'].slice(6, 24).every(completo => completo);
        
        if (busesCompleto && metroCompleto) {
            this.todosCompletos = true;
            console.log('¡Todos los datos han sido recolectados! Generando reporte...');
            this.guardarDatos();
        }
    }

    calcularDesviacionEstandar(datos) {
        const n = datos.length;
        const media = datos.reduce((a, b) => a + b, 0) / n;
        return Math.sqrt(datos.map(x => Math.pow(x - media, 2)).reduce((a, b) => a + b, 0) / n);
    }

    generarReporte() {
        const reporte = {
            'buses': {},
            'metro': {}
        };

        ['buses', 'metro'].forEach(tipo => {
            for (let hora = 0; hora < 24; hora++) {
                const pesos = this.datos[tipo][hora];
                
                // Solo generar reporte si hay datos
                if (pesos.length > 0) {
                    const sorted = [...pesos].sort((a, b) => a - b);
                    const suma = pesos.reduce((a, b) => a + b, 0);
                    const media = suma / pesos.length;
                    const desviacion = this.calcularDesviacionEstandar(pesos);
                    
                    reporte[tipo][hora] = {
                        'cantidad': pesos.length,
                        'minimo': Math.min(...pesos),
                        'maximo': Math.max(...pesos),
                        'suma': suma,
                        'media': media,
                        'mediana': this.calcularPercentil(sorted, 50),
                        'desviacionEstandar': desviacion,
                        'coeficienteVariacion': (desviacion / media) * 100,
                        'percentiles': {
                            '5': this.calcularPercentil(sorted, 5),
                            '10': this.calcularPercentil(sorted, 10),
                            '25': this.calcularPercentil(sorted, 25),
                            '50': this.calcularPercentil(sorted, 50),
                            '75': this.calcularPercentil(sorted, 75),
                            '90': this.calcularPercentil(sorted, 90),
                            '95': this.calcularPercentil(sorted, 95)
                        },
                        'rangoIntercuartil': this.calcularPercentil(sorted, 75) - this.calcularPercentil(sorted, 25)
                    };
                }
            }
        });

        return reporte;
    }

    calcularPercentil(datosOrdenados, percentil) {
        const index = Math.ceil((percentil / 100) * datosOrdenados.length) - 1;
        return datosOrdenados[Math.max(0, index)];
    }

    guardarDatos() {
        // Solo generar y descargar el reporte, no los datos crudos
        const reporte = JSON.stringify(this.generarReporte(), null, 2);
        
        // Crear blob para descargar
        const blobReporte = new Blob([reporte], { type: 'application/json' });
        
        // Crear enlace de descarga
        this.descargarArchivo(blobReporte, 'reporte_estadisticas_pesos.json');
        
        console.log('Reporte estadístico generado y disponible para descarga');
    }

    descargarArchivo(blob, nombreArchivo) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nombreArchivo;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// Instancia global del contador
const contadorPesos = new ContadorPesos();
export default contadorPesos;