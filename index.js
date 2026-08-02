const express = require("express");
const fs = require("fs");
const cors = require("cors");
const lockfile = require("proper-lockfile");
const { utcToZonedTime, format: formatTz } = require('date-fns-tz');
const os = require('os');
const crypto = require('crypto');
const fetch = require("node-fetch");
exports.fetch = fetch;

const admin = require('firebase-admin');

// Inicializar con la variable de entorno de Render
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("ERROR CRÍTICO: La variable de entorno FIREBASE_SERVICE_ACCOUNT no está definida.");
    process.exit(1); // Detenemos el servidor para que el log sea claro y no arranque a medias
}

// Inicializar con la variable de entorno de Render
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// La URL de tu Realtime Database (Consola Firebase -> Realtime Database -> arriba de la tabla de datos).
// También puedes definirla como variable de entorno FIREBASE_DATABASE_URL en Render.
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://TU_PROYECTO-default-rtdb.firebaseio.com";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

// Referencia reutilizable a la Realtime Database desde el backend
const rtdb = admin.database();

const app = express();
exports.app = app;

// Servir archivos estáticos desde la carpeta public
app.use(express.static('public'));

// Array para almacenar los logs del servidor
const serverLogs = [];

// Variable para almacenar la fecha de inicio del servidor
const serverStartTime = new Date();

// Helper: obtener la hora actual en una timezone y formatearla YYYY-MM-DD HH:mm:ss
function nowInTimeZone(timeZone) {
    const now = new Date();
    const zonedDate = utcToZonedTime(now, timeZone);
    return formatTz(zonedDate, 'yyyy-MM-dd HH:mm:ss', { timeZone });
}

// Función para añadir logs y mantener un tamaño limitado
function addLog(message) {
    const timestamp = nowInTimeZone('America/Havana');
    serverLogs.push(`[${timestamp}] ${message}`);
    // Mantener solo los últimos 100 logs para evitar sobrecargar la memoria
    if (serverLogs.length > 100) {
        serverLogs.shift(); // Eliminar el log más antiguo
    }
}

// Configuración de CORS
const allowedOrigins = [
    "https://www.buquenqe.com",
    "https://hcorebeat.github.io",
    "https://backend-buquenque.onrender.com",
    "https://analytics-buquenque.onrender.com",
    "http://127.0.0.1:5500",
    "http://localhost:10000",
    'https://localhost',                      // Capacitor Android
    'capacitor://localhost',                  // Capacitor iOS
    'http://localhost',                       // Pruebas en navegador
    'http://localhost:8100',                   // Ionic Dev Server
    "http://localhost:5500"
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("No permitido por CORS"));
        }
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
}));

// Middleware para procesar JSON
app.use(express.json());

// Configuración de rutas y archivos
const path = require('path');
const directoryPath = path.join(__dirname, "data");
const filePath = path.join(directoryPath, "estadistica.json");
const fcmTokensFilePath = path.join(directoryPath, "fcm_tokens.json");
const comparisonFilePath = path.join(directoryPath, "comparison.json");
// Archivo donde se guardan los pedidos eliminados manualmente para que no vuelvan a aparecer
// aunque la comparación automática con los datos remotos los siga detectando como "nuevos".
const dismissedOrdersFilePath = path.join(directoryPath, "dismissed_orders.json");
// Archivo donde se guarda de forma persistente el listado de gestión de pedidos
// (independiente de new-orders): pedidos que el usuario decidió mover a la tabla
// de seguimiento de estados (aceptado, entregado, enviado a pagar, pagado, enviado al grupo).
const managedOrdersFilePath = path.join(directoryPath, "managed_orders.json");

// Función para asegurar que el archivo de estadísticas existe
async function ensureStatisticsFile() {
    try {
        // Crear directorio si no existe
        if (!fs.existsSync(directoryPath)) {
            await fs.promises.mkdir(directoryPath, { recursive: true });
            addLog(`Directorio creado: ${directoryPath}`);
        }

        // Crear archivo si no existe
        if (!fs.existsSync(filePath)) {
            await fs.promises.writeFile(filePath, JSON.stringify([], null, 2), 'utf8');
            addLog(`Archivo creado: ${filePath}`);
        }

        // Crear archivo de tokens FCM si no existe
        if (!fs.existsSync(fcmTokensFilePath)) {
            await fs.promises.writeFile(fcmTokensFilePath, JSON.stringify([], null, 2), 'utf8');
            addLog(`Archivo creado: ${fcmTokensFilePath}`);
        }

        // Crear archivo de comparación si no existe
        if (!fs.existsSync(comparisonFilePath)) {
            await fs.promises.writeFile(comparisonFilePath, JSON.stringify([], null, 2), 'utf8');
            addLog(`Archivo creado: ${comparisonFilePath}`);
        }

        // Crear archivo de pedidos descartados si no existe
        if (!fs.existsSync(dismissedOrdersFilePath)) {
            await fs.promises.writeFile(dismissedOrdersFilePath, JSON.stringify([], null, 2), 'utf8');
            addLog(`Archivo creado: ${dismissedOrdersFilePath}`);
        }

        // Crear archivo de pedidos gestionados si no existe
        if (!fs.existsSync(managedOrdersFilePath)) {
            await fs.promises.writeFile(managedOrdersFilePath, JSON.stringify([], null, 2), 'utf8');
            addLog(`Archivo creado: ${managedOrdersFilePath}`);
        }
    } catch (error) {
        addLog(`ERROR: No se pudo crear el archivo de estadísticas o tokens FCM: ${error.message}`);
        throw error;
    }
}

// Inicializar archivo de estadísticas al arrancar
ensureStatisticsFile().catch(error => {
    console.error('Error al inicializar archivo de estadísticas:', error);
});


// Función para sanear JSON malformado
function sanitizeJSON(data) {
    try {
        return JSON.parse(data);
    } catch (error) {
        addLog(`WARN: El archivo JSON está malformado. Intentando corregirlo... Error: ${error.message}`);
        const sanitizedData = data
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
            .replace(/\\'/g, "'")
            .replace(/\\"/g, '"')
            .replace(/\\n/g, "")
            .replace(/\\t/g, "")
            .replace(/\\r/g, "");
        try {
            return JSON.parse(sanitizedData);
        } catch (finalError) {
            addLog(`ERROR: No se pudo corregir el JSON malformado: ${finalError.message}`);
            return [];
        }
    }
}

async function readJsonFile(filePath, defaultValue = []) {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        return content ? sanitizeJSON(content) : defaultValue;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return defaultValue;
        }
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Construye una clave única para identificar un pedido (mismo criterio que usa
// la comparación local vs remota: ip + fecha_hora_entrada).
function buildOrderKey(order) {
    return `${order && order.ip ? order.ip : ''}|${order && order.fecha_hora_entrada ? order.fecha_hora_entrada : ''}`;
}

// Obtiene la lista de claves de pedidos descartados manualmente
async function getDismissedOrders() {
    return await readJsonFile(dismissedOrdersFilePath, []);
}

// Marca un pedido como descartado para que no vuelva a aparecer como "nuevo"
async function addDismissedOrder(key) {
    const dismissed = await getDismissedOrders();
    if (!dismissed.includes(key)) {
        dismissed.push(key);
        await writeJsonFile(dismissedOrdersFilePath, dismissed);
    }
}

// Middleware para registro de solicitudes
app.use((req, res, next) => {
    addLog(`Solicitud: ${req.method} ${req.path}`);
    next();
});


// Usamos (.*) para indicar que el parámetro 'id' puede capturar cualquier carácter
// Usamos una expresión regular para capturar todo después de /p/
// El (.*) captura cualquier carácter y lo guarda en req.params[0]
app.get(/^\/p\/(.*)/, async (req, res) => {
    // 1. Captura del ID desde el array de params (índice 0 debido a la regex)
    let id = req.params[0] || "";

    // Limpieza: quitar barras finales y decodificar
    if (id.endsWith('/')) id = id.slice(0, -1);
    try { 
        id = decodeURIComponent(id); 
    } catch (e) {
        console.error("Error decodificando ID:", e);
    }

    console.log(`[Backend] Procesando producto: "${id}"`);

    try {
        const snapshot = await rtdb.ref("products").once("value");
        const productsObj = snapshot.val() || {};
        const productsArray = Object.values(productsObj);

        // Búsqueda en los productos
        const product = productsArray.find(p => {
            const prodId = String(p.id).trim();
            const prodNombreEscaped = _escapeHtml(p.nombre).trim();
            const searchId = String(id).trim();
            return prodId === searchId || prodNombreEscaped === searchId;
        });

        if (!product) {
            console.log(`[Backend] Producto "${id}" no encontrado.`);
            return res.send(`<!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta property="og:title" content="Producto no encontrado - Buquenqe" />

            <link rel="icon" href="https://www.buquenqe.com/Images/favicon.ico" type="image/x-icon" />
            <link rel="shortcut icon" href="https://www.buquenqe.com/Images/favicon.ico" />

            <meta property="og:image" content="https://www.buquenqe.com/Images/social-share-banner.jpg" />
        </head>
        <body><script>window.location.href = "https://www.buquenqe.com/index.html";</script></body>
        </html>`);
        }

        // =====================
        // CÁLCULO DE PRECIOS
        // =====================
        let precioActual = product.precio;
        let precioAntes = null;

        if (product.oferta === true && product.descuento > 0) {
            precioAntes = product.precio;
            precioActual = (
                product.precio - (product.precio * (product.descuento / 100))
            ).toFixed(2);
        }

        // Datos para Meta Tags
        const nombre = product.nombre || "Producto";
        const descripcion = product.descripcion || "Disponible en Buquenqe";
        const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "TU_CLOUD_NAME";
        const imagen = (product.imagenes && product.imagenes.length)
            ? `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/f_auto,q_auto/products/${encodeURIComponent(product.imagenes[0])}`
            : "https://www.buquenqe.com/Images/social-share-banner.jpg";

        // IMPORTANTE: URL absoluta para WhatsApp
        const canonicalUrl = `https://www.buquenqe.com/p/${encodeURIComponent(id)}`;

        res.send(`<!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <title>${_escapeHtml(nombre)}</title>

            <link rel="icon" href="https://www.buquenqe.com/Images/favicon.ico" type="image/x-icon" />
            <link rel="shortcut icon" href="https://www.buquenqe.com/Images/favicon.ico" />

            <meta property="og:site_name" content="Buquenque Shop" />

            <meta property="og:title" content="${_escapeHtml(nombre)}" />
            <meta property="og:description" content="${_escapeHtml(descripcion)}" />
            <meta property="og:image" content="${imagen}" />
            <meta property="og:url" content="${canonicalUrl}" />
            <meta name="twitter:card" content="summary_large_image" />


            <meta property="product:price:amount" content="${precioActual}" />
            <meta property="product:price:currency" content="Zelle" />

            ${precioAntes !== null ? `
            <meta property="product:original_price:amount" content="${precioAntes}" />
            <meta property="product:original_price:currency" content="Zelle" />
            ` : ""}
        </head>
        <body>
            <script>
                // Redirigir al index usando el hash que lee tu script.js
                window.location.href = "https://www.buquenqe.com/index.html#" + encodeURIComponent("${id}");
            </script>
        </body>
        </html>`);
    } catch (err) {
        console.error("Error en /p/:", err);
        res.status(500).send("Error interno");
    }
});

// Asegúrate de tener esta función definida arriba en tu index.js
function _escapeHtml(unsafe) {
    if (!unsafe) return "";
    return unsafe.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Ruta para guardar estadísticas
app.post("/guardar-estadistica", async (req, res) => {
    let release; // Declare release outside try to ensure it's accessible in finally
    try {
        const nuevaEstadistica = req.body;
        addLog(`Recibida nueva estadística: ${JSON.stringify(nuevaEstadistica)}`);

        if (!nuevaEstadistica.ip || !nuevaEstadistica.pais || !nuevaEstadistica.origen) {
            addLog("ERROR: Faltan campos obligatorios en la estadística.");
            return res.status(400).json({ error: "Faltan campos obligatorios" });
        }

        release = await lockfile.lock(filePath); // Assign release here
        addLog(`Archivo bloqueado: ${filePath}`);

        fs.readFile(filePath, "utf8", (err, data) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    fs.writeFileSync(filePath, JSON.stringify([]));
                    data = '[]';
                    addLog(`Archivo no encontrado, inicializando: ${filePath}`);
                } else {
                    addLog(`ERROR: Error leyendo el archivo: ${err.message}`);
                    if (release) release(); // Ensure unlock on error
                    return res.status(500).json({ error: "Error leyendo el archivo" });
                }
            }

            const estadisticas = data ? sanitizeJSON(data) : [];
            const usuarioExistente = estadisticas.find(est => est.ip === nuevaEstadistica.ip);

            const fechaHoraCuba = nowInTimeZone('America/Havana');

            estadisticas.push({
                ip: nuevaEstadistica.ip,
                pais: nuevaEstadistica.pais,
                fecha_hora_entrada: fechaHoraCuba,
                origen: nuevaEstadistica.origen,
                afiliado: nuevaEstadistica.afiliado || "Ninguno",
                duracion_sesion_segundos: nuevaEstadistica.duracion_sesion_segundos || 0,
                tiempo_carga_pagina_ms: nuevaEstadistica.tiempo_carga_pagina_ms || 0,
                nombre_comprador: nuevaEstadistica.nombre_comprador || "N/A",
                telefono_comprador: nuevaEstadistica.telefono_comprador || "N/A",
                nombre_persona_entrega: nuevaEstadistica.nombre_persona_entrega || "N/A",
                telefono_persona_entrega: nuevaEstadistica.telefono_persona_entrega || "N/A",
                correo_comprador: nuevaEstadistica.correo_comprador || "N/A",
                direccion_envio: nuevaEstadistica.direccion_envio || "N/A",
                compras: nuevaEstadistica.compras || [],
                precio_compra_total: nuevaEstadistica.precio_compra_total || 0,
                navegador: nuevaEstadistica.navegador || "Desconocido",
                sistema_operativo: nuevaEstadistica.sistema_operativo || "Desconocido",
                tipo_usuario: usuarioExistente ? "Recurrente" : "Único",
                tiempo_promedio_pagina: nuevaEstadistica.tiempo_promedio_pagina || 0,
                fuente_trafico: nuevaEstadistica.fuente_trafico || "Desconocido",
            });

            fs.writeFile(filePath, JSON.stringify(estadisticas, null, 2), (err) => {
                if (err) {
                    addLog(`ERROR: Error guardando el archivo: ${err.message}`);
                    if (release) release(); // Ensure unlock on error
                    return res.status(500).json({ error: "Error guardando el archivo" });
                }
                addLog("Estadística guardada correctamente.");
                if (release) release(); // Unlock on success
                res.json({ message: "Estadística guardada correctamente" });
            });
        });
    } catch (error) {
        addLog(`ERROR: Error en /guardar-estadistica: ${error.message}`);
        if (release) release(); // Ensure unlock on error
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

// Ruta para obtener estadísticas
app.get("/obtener-estadisticas", async (req, res) => {
    let release; // Declare release outside try
    try {
        addLog("Solicitud para obtener estadísticas.");
        release = await lockfile.lock(filePath); // Assign release here
        addLog(`Archivo bloqueado para lectura: ${filePath}`);

        fs.readFile(filePath, "utf8", (err, data) => {
            if (err && err.code !== "ENOENT") {
                addLog(`ERROR: Error leyendo el archivo de estadísticas: ${err.message}`);
                if (release) release(); // Ensure unlock on error
                return res.status(500).json({ error: "Error leyendo el archivo" });
            }

            const estadisticas = data ? sanitizeJSON(data) : [];
            addLog(`Estadísticas enviadas: ${estadisticas.length} registros.`);
            if (release) release(); // Unlock on success
            res.json(estadisticas);
        });
    } catch (error) {
        addLog(`ERROR: Error en /obtener-estadisticas: ${error.message}`);
        if (release) release(); // Ensure unlock on error
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

// ** IMPORTANTE: REEMPLAZA ESTA URL CON LA URL DE TU APLICACIÓN WEB DE APPS SCRIPT **
// Esta es la URL que obtuviste al publicar tu script de Google Apps Script como Web App.
const GOOGLE_APPS_SCRIPT_SHEETS_URL = "https://script.google.com/macros/s/AKfycbzcX8GDu-6sMegdKKAn5DgLMp9E8BzcM6C3j6WttFiAwiU1RhA42eDzAxIgql-Eat2xhA/exec";

const GOOGLE_APPS_SCRIPT_CORREO_URL = "https://script.google.com/macros/s/AKfycbytMcaOnCRpVJ2STIlXNXj5vs2G_BwSccYPcsHBXDyfJ_6yjUy_8X8ARm3bhC9eAqAB/exec";

// Ruta POST para recibir los datos del pedido desde el frontend
// Ruta POST para recibir los datos del pedido desde el frontend
app.post('/send-pedido', async (req, res) => {
    console.log('📦 Recibida solicitud de pedido desde el frontend.');
    const orderData = req.body;

    if (!orderData) {
        console.error('Error: Datos de pedido vacíos.');
        return res.status(400).json({ success: false, message: 'Datos de pedido no proporcionados.' });
    }

    try {
        // 1. Enviar los datos al primer script (Web App)
        console.log('Enviando datos a Google Apps Script (Principal)...');
        const response = await fetch(GOOGLE_APPS_SCRIPT_CORREO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData),
        });

        // 2. Enviar los datos al segundo script (Sheets)
        console.log('Enviando datos a Google Apps Script (Sheets)...');
        const responseSheets = await fetch(GOOGLE_APPS_SCRIPT_SHEETS_URL,{
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData),
        });

        // 3. Procesar las respuestas de texto a JSON de forma segura
        const textResponse1 = await response.text();
        const textResponse2 = await responseSheets.text();
        
        let gasResponse, gasResponseSheets;

        try {
            gasResponse = JSON.parse(textResponse1);
        } catch (e) {
            console.warn('Respuesta 1 no es JSON válido:', textResponse1);
            gasResponse = { status: "error", message: "Respuesta no válida del script principal", raw: textResponse1 };
        }

        try {
            gasResponseSheets = JSON.parse(textResponse2);
        } catch (e) {
            console.warn('Respuesta 2 no es JSON válido:', textResponse2);
            gasResponseSheets = { status: "error", message: "Respuesta no válida del script sheets", raw: textResponse2 };
        }

        console.log('Respuestas recibidas de Google. Actualizando local...');

        // 4. Ejecutar la función local para actualizar la comparación
        try {
            await compareLocalAndRemoteData();
            console.log('Comparación de pedidos actualizada tras nuevo pedido.');
        } catch (updateError) {
            console.error('Error al actualizar comparación tras pedido:', updateError);
        }

        // =================================================================
        // 🔥 ENVIAR NOTIFICACIÓN PUSH TRAS COMPROBAR ÉXITO DE GOOGLE
        // =================================================================
        const mainSuccess = response.ok && gasResponse.status === "success";
        const sheetsSuccess = responseSheets.ok && gasResponseSheets.status === "success";

        if (mainSuccess && sheetsSuccess) {
            
            // Construimos la estructura de la notificación push orientada a un canal (Topic)
            const nombreComprador = orderData.nombre_comprador || "Cliente Nuevo";
            const totalPedido = orderData.precio_compra_total || "0.00";

            const message = {
                notification: {
                    title: '¡Nuevo Pedido Recibido! 📦',
                    body: `${nombreComprador} ha comprado un total de $${totalPedido}.`
                },
                data: {
                    origen: String(orderData.origen || 'web'),
                    click_action: 'FLUTTER_NOTIFICATION_CLICK' 
                },
                topic: 'pedidos' // Canal al que va dirigida la notificación
            };

            // Enviar la notificación de manera asíncrona (no bloquea la respuesta del cliente)
            admin.messaging().send(message)
                .then((responsePush) => {
                    addLog(`Push enviado con éxito: ${responsePush}`);
                    console.log('Push enviado con éxito:', responsePush);
                })
                .catch((errorPush) => {
                    addLog(`ERROR enviando Push: ${errorPush.message}`);
                    console.error('Error enviando notificación Push:', errorPush);
                });

            // Caso ideal: Ambos funcionaron
            return res.status(200).json({
                success: true,
                message: 'Pedido enviado correctamente y notificación push procesada.',
                gasResponse: gasResponse,
                gasResponseSheets: gasResponseSheets
            });
        } else {
            console.error('Hubo un error en uno de los servicios externos.');
            return res.status(502).json({ 
                success: false,
                message: 'El pedido se procesó parcialmente o hubo un error en los servicios de Google.',
                details: {
                    principal: { success: mainSuccess, response: gasResponse },
                    sheets: { success: sheetsSuccess, response: gasResponseSheets }
                }
            });
        }

    } catch (error) {
        console.error('❌ Error CRÍTICO en el backend al procesar el pedido:', error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: 'Error interno del servidor al procesar el pedido.',
                error: error.message
            });
        }
    }
});


app.post('/delete-order', async (req, res) => {
    const { rows } = req.body;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ success: false, message: "Debes enviar un array de filas" });
    }

    try {
        const response = await fetch(GOOGLE_APPS_SCRIPT_SHEETS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: "deleteMultipleRows",
                rows: rows
            })
        });

        const result = await response.json();

        if (result.status === "success") {
            return res.json({ success: true, message: "Pedido eliminado correctamente" });
        } else {
            return res.status(500).json({ success: false, message: result.message });
        }

    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});


app.get('/api/pedidos-sheets', async (req, res) => {
    try {
        const response = await fetch(GOOGLE_APPS_SCRIPT_SHEETS_URL);
        const data = await response.json();

        if (data.status !== "success") {
            return res.status(500).json({ success: false, message: "Error desde Apps Script" });
        }

        const filas = data.data;

        // Agrupar por ip + fecha_hora_entrada
        const pedidosAgrupados = {};

        filas.forEach(fila => {
            const key = fila.ip + "_" + fila.fecha_hora_entrada;

            if (!pedidosAgrupados[key]) {
                pedidosAgrupados[key] = {
                    ip: fila.ip,
                    pais: fila.pais,
                    fecha_hora_entrada: fila.fecha_hora_entrada,
                    origen: fila.origen,
                    afiliado: fila.afiliado,
                    duracion_sesion_segundos: fila.duracion_sesion_segundos,
                    tiempo_carga_pagina_ms: fila.tiempo_carga_pagina_ms,
                    nombre_comprador: fila.nombre_comprador,
                    telefono_comprador: fila.telefono_comprador,
                    nombre_persona_entrega: fila.nombre_persona_entrega,
                    telefono_persona_entrega: fila.telefono_persona_entrega,
                    correo_comprador: fila.correo_comprador,
                    direccion_envio: fila.direccion_envio,
                    compras: [],
                    precio_compra_total: fila.precio_compra_total_pedido,
                    navegador: fila.navegador,
                    sistema_operativo: fila.sistema_operativo,
                    tipo_usuario: fila.tipo_usuario,
                    tiempo_promedio_pagina: fila.tiempo_promedio_pagina,
                    fuente_trafico: fila.fuente_trafico
                };
            }

            pedidosAgrupados[key].compras.push({
                id: fila.id || null,
                name: fila.producto_name,
                quantity: fila.producto_quantity,
                unitPrice: fila.producto_unitPrice,
                discount: fila.producto_discount,
                rowNumber: fila.rowNumber
            });
        });

        res.json({
            success: true,
            pedidos: Object.values(pedidosAgrupados)
        });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});



// Nueva ruta API para obtener el estado del servidor
app.get("/api/server-status", async (req, res) => {
    addLog("Solicitud de estado del servidor recibida");

    try {
        // Memoria (bytes)
        const memory = process.memoryUsage();

        // Calcular uso de CPU del proceso muestreando durante 100ms
        const startUsage = process.cpuUsage();
        const startHrTime = process.hrtime();
        await new Promise(resolve => setTimeout(resolve, 100));
        const elapHr = process.hrtime(startHrTime);
        const elapMicros = (elapHr[0] * 1e6) + (elapHr[1] / 1e3);
        const elapUsage = process.cpuUsage(startUsage);
        const cpuCount = os.cpus().length || 1;
        const cpuPercent = ((elapUsage.user + elapUsage.system) / elapMicros) * 100 / cpuCount;

        res.json({
            status: "running",
            startTime: serverStartTime.toISOString(),
            logs: serverLogs,
            memory: {
                rss: memory.rss,
                heapTotal: memory.heapTotal,
                heapUsed: memory.heapUsed,
                external: memory.external
            },
            cpu: {
                percent: Number(cpuPercent.toFixed(2)),
                cores: cpuCount,
                sampleMs: 100
            }
        });
    } catch (err) {
        addLog(`ERROR: No se pudo calcular uso de CPU/memoria: ${err.message}`);
        res.status(500).json({ error: 'Error obteniendo estadísticas del servidor' });
    }
});

// Modificar la función para guardar automáticamente en comparison.json
async function compareLocalAndRemoteData() {
    const remoteUrl = "https://raw.githubusercontent.com/HCoreBeat/Analytics-Buquenque/refs/heads/main/Json/my_data.json";
    let newOrders = [];
    let release;

    try {
        // Leer datos locales
        const localData = JSON.parse(await fs.promises.readFile(filePath, "utf8"));

        // Obtener datos remotos
        const response = await fetch(remoteUrl);
        if (!response.ok) {
            throw new Error(`Error al obtener datos remotos: ${response.statusText}`);
        }
        const remoteData = await response.json();

        // Filtrar pedidos nuevos
        newOrders = localData.filter(localItem => {
            const isOrder = Array.isArray(localItem.compras) && localItem.compras.length > 0;
            if (!isOrder) return false;

            return !remoteData.some(remoteItem => (
                Array.isArray(remoteItem.compras) && remoteItem.compras.length > 0 &&
                remoteItem.ip === localItem.ip &&
                remoteItem.fecha_hora_entrada === localItem.fecha_hora_entrada
            ));
        });

        // Excluir los pedidos que fueron eliminados manualmente desde el panel,
        // para que no reaparezcan en la próxima comparación automática.
        const dismissedOrders = await getDismissedOrders();
        if (dismissedOrders.length > 0) {
            newOrders = newOrders.filter(order => !dismissedOrders.includes(buildOrderKey(order)));

            // PODA: un pedido descartado ya no necesita seguir en la lista si
            // dejó de existir en los datos locales (por ejemplo, tras usar
            // "Limpiar Estadísticas"). Así el archivo no crece indefinidamente:
            // solo conserva las claves que todavía podrían volver a aparecer.
            const localOrderKeys = new Set(
                localData
                    .filter(item => Array.isArray(item.compras) && item.compras.length > 0)
                    .map(buildOrderKey)
            );
            const prunedDismissed = dismissedOrders.filter(key => localOrderKeys.has(key));
            if (prunedDismissed.length !== dismissedOrders.length) {
                await writeJsonFile(dismissedOrdersFilePath, prunedDismissed);
                addLog(`Lista de pedidos descartados depurada: ${dismissedOrders.length} -> ${prunedDismissed.length}`);
            }
        }

        addLog(`Pedidos nuevos encontrados: ${newOrders.length}`);

        // Guardar los nuevos pedidos en comparison.json
        release = await lockfile.lock(comparisonFilePath);
        addLog(`Archivo comparison.json bloqueado para escritura: ${comparisonFilePath}`);

        await fs.promises.writeFile(
            comparisonFilePath,
            JSON.stringify(newOrders, null, 2),
            "utf8"
        );
        addLog(`Datos de comparación guardados en: ${comparisonFilePath}`);

        return newOrders;
    } catch (error) {
        addLog(`ERROR: No se pudo comparar datos locales y remotos: ${error.message}`);
        throw error;
    } finally {
        if (release) release(); // Liberar el bloqueo del archivo
    }
}

// Ruta para actualizar la comparación de datos y guardar en comparison.json
app.post("/api/update-comparison", async (req, res) => {

    let release;

    try {
        const newOrders = await compareLocalAndRemoteData();

        // Bloquear el archivo comparison.json
        release = await lockfile.lock(comparisonFilePath);
        addLog(`Archivo bloqueado para escritura: ${comparisonFilePath}`);

        // Guardar los nuevos pedidos en comparison.json
        await fs.promises.writeFile(
            comparisonFilePath,
            JSON.stringify(newOrders, null, 2),
            "utf8"
        );
        addLog(`Datos de comparación guardados en: ${comparisonFilePath}`);

        // Responder con los nuevos pedidos
        res.json({ success: true, newOrders });
    } catch (error) {
        addLog(`ERROR: No se pudo actualizar la comparación: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (release) release(); // Liberar el bloqueo del archivo
    }
});

// Nueva ruta para limpiar estadísticas usando promesas
app.post("/api/clear-statistics", async (req, res) => {
    try {
        addLog("Solicitud para limpiar estadísticas recibida");

        // Asegurar que el directorio existe
        if (!fs.existsSync(directoryPath)) {
            addLog("Directorio no encontrado. Creando directorio...");
            await fs.promises.mkdir(directoryPath, { recursive: true });
            addLog(`Directorio creado: ${directoryPath}`);
        }

        // Intentar borrar el archivo si existe
        if (fs.existsSync(filePath)) {
            addLog("Archivo de estadísticas encontrado. Eliminando archivo...");
            await fs.promises.unlink(filePath);
            addLog("Archivo de estadísticas eliminado");
        } else {
            addLog("Archivo de estadísticas no encontrado. Se creará uno nuevo.");
        }

        // Crear nuevo archivo con array vacío
        addLog("Creando nuevo archivo de estadísticas...");
        await fs.promises.writeFile(filePath, "[]", { 
            encoding: 'utf8',
            mode: 0o666 // Permisos de lectura y escritura para todos
        });
        addLog("Nuevo archivo de estadísticas creado correctamente");

        // Como se borraron todos los pedidos locales, la lista de pedidos
        // descartados manualmente ya no tiene ninguna referencia válida:
        // se vacía para que el archivo no siga creciendo sin necesidad.
        await writeJsonFile(dismissedOrdersFilePath, []);
        addLog("Lista de pedidos descartados reiniciada tras limpiar estadísticas");

        // Comparar datos locales y remotos después de limpiar estadísticas
        const newOrders = await compareLocalAndRemoteData();

        res.json({ 
            success: true, 
            message: "Estadísticas limpiadas correctamente", 
            newOrders 
        });

    } catch (error) {
        const errorMessage = `Error al limpiar estadísticas: ${error.message}`;
        addLog(`ERROR: ${errorMessage}`);
        console.error(errorMessage);
        res.status(500).json({ 
            success: false, 
            error: errorMessage 
        });
    }
});

// Ruta para obtener los datos actuales de comparison.json
app.get("/api/get-comparison", async (req, res) => {


    try {
        // Leer los datos de comparison.json
        const data = await fs.promises.readFile(comparisonFilePath, "utf8");
        const comparisonData = JSON.parse(data);

        res.json({ success: true, comparisonData });
    } catch (error) {
        addLog(`ERROR: No se pudo leer comparison.json: ${error.message}`);
        res.status(500).json({ success: false, error: "Error al obtener los datos de comparación" });
    }
});

// Endpoint para obtener los pedidos nuevos desde comparison.json
app.get('/api/new-orders', async (req, res) => {

    try {
        if (!fs.existsSync(comparisonFilePath)) {
            return res.json({ success: true, newOrders: [] });
        }
        const data = await fs.promises.readFile(comparisonFilePath, 'utf8');
        const newOrders = JSON.parse(data);
        res.json({ success: true, newOrders });
    } catch (error) {
        console.error('Error al leer comparison.json:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint para eliminar (descartar) un único pedido nuevo sin guardar.
// Se identifica el pedido por su combinación única ip + fecha_hora_entrada.
// El pedido se elimina de comparison.json y además se guarda en una lista de
// "descartados" para que la verificación automática (cada 10-30s) no lo
// vuelva a mostrar como pedido nuevo.
app.delete('/api/new-orders', async (req, res) => {
    let release;
    try {
        const { ip, fecha_hora_entrada } = req.body || {};

        if (!ip || !fecha_hora_entrada) {
            return res.status(400).json({
                success: false,
                message: 'Se requieren los campos "ip" y "fecha_hora_entrada" para identificar el pedido a eliminar.'
            });
        }

        const key = buildOrderKey({ ip, fecha_hora_entrada });

        // Asegurar que el archivo de comparación existe antes de bloquearlo
        if (!fs.existsSync(comparisonFilePath)) {
            await fs.promises.writeFile(comparisonFilePath, JSON.stringify([], null, 2), 'utf8');
        }

        release = await lockfile.lock(comparisonFilePath);

        const currentOrders = await readJsonFile(comparisonFilePath, []);
        const existiaPedido = currentOrders.some(order => buildOrderKey(order) === key);
        const updatedOrders = currentOrders.filter(order => buildOrderKey(order) !== key);

        await writeJsonFile(comparisonFilePath, updatedOrders);

        // Registrar el pedido como descartado de forma permanente
        await addDismissedOrder(key);

        addLog(`Pedido eliminado manualmente desde el panel (ip: ${ip}, fecha_hora_entrada: ${fecha_hora_entrada}).`);

        return res.json({
            success: true,
            message: existiaPedido ? 'Pedido eliminado correctamente.' : 'El pedido ya no estaba en la lista, pero fue marcado como descartado.',
            newOrders: updatedOrders
        });
    } catch (error) {
        addLog(`ERROR: No se pudo eliminar el pedido: ${error.message}`);
        console.error('Error al eliminar pedido:', error);
        return res.status(500).json({ success: false, message: 'Error interno al eliminar el pedido.', error: error.message });
    } finally {
        if (release) release();
    }
});

// =====================================================
// 📋 GESTIÓN DE PEDIDOS (listado persistente independiente de /api/new-orders)
// =====================================================
// Estructura de cada pedido gestionado:
// {
//   id, nombre_cliente, pais, telefono, precio_total,
//   aceptado, entregado, enviado_a_pagar, pagado, enviado_grupo_pagos,
//   origen: "new-order" | "manual",
//   source_key: "ip|fecha_hora_entrada" (solo si origen === "new-order"),
//   fecha_creacion, fecha_actualizacion
// }

// GET /api/managed-orders → obtener el listado completo de gestión
app.get('/api/managed-orders', async (req, res) => {
    try {
        const managedOrders = await readJsonFile(managedOrdersFilePath, []);
        res.json({ success: true, managedOrders });
    } catch (error) {
        addLog(`ERROR: No se pudo leer managed_orders.json: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error al obtener el listado de gestión', error: error.message });
    }
});

// POST /api/managed-orders → agregar un pedido al listado de gestión.
// Puede venir de un pedido nuevo (origen: "new-order", con sourceKey { ip, fecha_hora_entrada })
// o ser creado manualmente (origen: "manual").
app.post('/api/managed-orders', async (req, res) => {
    let release;
    try {
        const {
            nombre_cliente,
            pais,
            telefono,
            precio_total,
            origen,
            sourceKey
        } = req.body || {};

        if (!nombre_cliente || !telefono) {
            return res.status(400).json({
                success: false,
                message: 'Los campos "nombre_cliente" y "telefono" son obligatorios.'
            });
        }

        if (!fs.existsSync(managedOrdersFilePath)) {
            await fs.promises.writeFile(managedOrdersFilePath, JSON.stringify([], null, 2), 'utf8');
        }

        release = await lockfile.lock(managedOrdersFilePath);

        const managedOrders = await readJsonFile(managedOrdersFilePath, []);

        const fechaActual = nowInTimeZone('America/Havana');

        const nuevoPedidoGestionado = {
            id: crypto.randomUUID(),
            nombre_cliente: String(nombre_cliente),
            pais: pais ? String(pais) : "N/A",
            telefono: String(telefono),
            precio_total: precio_total !== undefined && precio_total !== null && precio_total !== "" ? Number(precio_total) : 0,
            aceptado: false,
            entregado: false,
            enviado_a_pagar: false,
            pagado: false,
            enviado_grupo_pagos: false,
            origen: origen === "new-order" ? "new-order" : "manual",
            source_key: origen === "new-order" && sourceKey ? buildOrderKey(sourceKey) : null,
            fecha_creacion: fechaActual,
            fecha_actualizacion: fechaActual
        };

        managedOrders.push(nuevoPedidoGestionado);
        await writeJsonFile(managedOrdersFilePath, managedOrders);

        addLog(`Pedido agregado al listado de gestión: ${nuevoPedidoGestionado.nombre_cliente} (id: ${nuevoPedidoGestionado.id})`);

        // Si el pedido proviene de la lista de pedidos nuevos, lo eliminamos de comparison.json
        // para que no aparezca como pedido nuevo mientras está en seguimiento.
        if (origen === "new-order" && sourceKey && sourceKey.ip && sourceKey.fecha_hora_entrada) {
            try {
                const key = buildOrderKey(sourceKey);
                let releaseComparison;
                if (!fs.existsSync(comparisonFilePath)) {
                    await fs.promises.writeFile(comparisonFilePath, JSON.stringify([], null, 2), 'utf8');
                }
                releaseComparison = await lockfile.lock(comparisonFilePath);
                try {
                    const currentOrders = await readJsonFile(comparisonFilePath, []);
                    const updatedOrders = currentOrders.filter(order => buildOrderKey(order) !== key);
                    await writeJsonFile(comparisonFilePath, updatedOrders);
                } finally {
                    if (releaseComparison) releaseComparison();
                }
            } catch (dismissError) {
                addLog(`WARN: No se pudo actualizar comparison.json tras agregar el pedido a gestión: ${dismissError.message}`);
            }
        }

        res.json({ success: true, managedOrder: nuevoPedidoGestionado, managedOrders });
    } catch (error) {
        addLog(`ERROR: No se pudo agregar el pedido al listado de gestión: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error al agregar el pedido de gestión', error: error.message });
    } finally {
        if (release) release();
    }
});

// PATCH /api/managed-orders/:id → actualizar campos de un pedido gestionado
// (datos del cliente y/o estados: aceptado, entregado, enviado_a_pagar, pagado, enviado_grupo_pagos)
app.patch('/api/managed-orders/:id', async (req, res) => {
    let release;
    try {
        const { id } = req.params;
        const camposPermitidos = [
            'nombre_cliente', 'pais', 'telefono', 'precio_total',
            'aceptado', 'entregado', 'enviado_a_pagar', 'pagado', 'enviado_grupo_pagos'
        ];

        const cambios = {};
        for (const campo of camposPermitidos) {
            if (Object.prototype.hasOwnProperty.call(req.body || {}, campo)) {
                cambios[campo] = req.body[campo];
            }
        }

        if (Object.keys(cambios).length === 0) {
            return res.status(400).json({ success: false, message: 'No se proporcionaron campos válidos para actualizar.' });
        }

        release = await lockfile.lock(managedOrdersFilePath);

        const managedOrders = await readJsonFile(managedOrdersFilePath, []);
        const index = managedOrders.findIndex(order => order.id === id);

        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Pedido gestionado no encontrado.' });
        }

        // Normalizar tipos: booleanos para los estados, número para el precio
        if ('precio_total' in cambios) cambios.precio_total = Number(cambios.precio_total) || 0;
        for (const flag of ['aceptado', 'entregado', 'enviado_a_pagar', 'pagado', 'enviado_grupo_pagos']) {
            if (flag in cambios) cambios[flag] = Boolean(cambios[flag]);
        }

        managedOrders[index] = {
            ...managedOrders[index],
            ...cambios,
            fecha_actualizacion: nowInTimeZone('America/Havana')
        };

        await writeJsonFile(managedOrdersFilePath, managedOrders);

        addLog(`Pedido gestionado actualizado (id: ${id}): ${JSON.stringify(cambios)}`);

        res.json({ success: true, managedOrder: managedOrders[index] });
    } catch (error) {
        addLog(`ERROR: No se pudo actualizar el pedido gestionado: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error al actualizar el pedido gestionado', error: error.message });
    } finally {
        if (release) release();
    }
});

// DELETE /api/managed-orders/:id → eliminar permanentemente un pedido del listado de gestión
app.delete('/api/managed-orders/:id', async (req, res) => {
    let release;
    try {
        const { id } = req.params;

        release = await lockfile.lock(managedOrdersFilePath);

        const managedOrders = await readJsonFile(managedOrdersFilePath, []);
        const orderToRemove = managedOrders.find(order => order.id === id);
        const updatedOrders = managedOrders.filter(order => order.id !== id);

        await writeJsonFile(managedOrdersFilePath, updatedOrders);

        addLog(`Pedido eliminado del listado de gestión (id: ${id}).`);

        if (orderToRemove && orderToRemove.source_key) {
            try {
                await compareLocalAndRemoteData();
            } catch (updateError) {
                addLog(`WARN: No se pudo regenerar new orders tras eliminar pedido gestionado: ${updateError.message}`);
            }
        }

        const existed = Boolean(orderToRemove);
        res.json({
            success: true,
            message: existed ? 'Pedido eliminado correctamente.' : 'El pedido ya no existía en el listado.',
            managedOrders: updatedOrders
        });
    } catch (error) {
        addLog(`ERROR: No se pudo eliminar el pedido gestionado: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error al eliminar el pedido gestionado', error: error.message });
    } finally {
        if (release) release();
    }
});

// Modificar la ruta principal para verificar pedidos nuevos al cargar la página
app.get("/", async (req, res) => {
    addLog("Página principal solicitada");

    try {
        // Verificar si hay pedidos nuevos
        const newOrders = await compareLocalAndRemoteData();

        // Si hay nuevos pedidos, guardar estadísticas y mostrar el botón
        if (newOrders.length > 0) {
            addLog(`Se encontraron ${newOrders.length} nuevos pedidos al cargar la página.`);

            // Guardar estadísticas de los nuevos pedidos
            const estadisticas = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
            newOrders.forEach(order => {
                estadisticas.push(order);
            });
            await fs.promises.writeFile(filePath, JSON.stringify(estadisticas, null, 2), "utf8");
            addLog("Estadísticas de nuevos pedidos guardadas correctamente.");
        }

        // Enviar el archivo HTML con información sobre nuevos pedidos
        res.sendFile(__dirname + '/public/index.html', {
            headers: {
                'X-New-Orders': newOrders.length > 0 ? 'true' : 'false'
            }
        });
    } catch (error) {
        addLog(`ERROR: No se pudo verificar pedidos nuevos al cargar la página: ${error.message}`);
        res.status(500).send("Error interno del servidor");
    }
});

// Manejo de errores
app.use((err, req, res, next) => {
    addLog(`ERROR GLOBAL: ${err.message}`);
    console.error("Error global:", err);
    res.status(500).json({ error: "Error interno del servidor" });
});

// Puerto de escucha
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    addLog(`Servidor corriendo en el puerto ${PORT}`);
    addLog(`Entorno: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Servidor corriendo en el puerto ${PORT}`);
    console.log(`Entorno: ${process.env.NODE_ENV || 'development'}`);
});

// Verificar nuevos pedidos cada 30 segundos
setInterval(async () => {
    try {
        const newOrders = await compareLocalAndRemoteData();

        if (newOrders.length > 0) {
            addLog(`Se encontraron ${newOrders.length} nuevos pedidos en la verificación periódica.`);
        } else {
            addLog("No se encontraron nuevos pedidos en la verificación periódica.");
        }
    } catch (error) {
        addLog(`ERROR: Error en la verificación periódica de nuevos pedidos: ${error.message}`);
    }
}, 30000); // 30 segundos



// ----------------------------segmento del inventario-------------------------------
const INVENTORY_SHEETS_URL = "https://script.google.com/macros/s/AKfycby1C0toV0DRiBmxWu6T9JRgamatsGkSAHoOGm6Fx-BhiIXqMNeZbYuAtA5APlw8EWa5Zw/exec";

// GET /inventario/:id → un solo producto
app.get("/inventario/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const response = await fetch(`${INVENTORY_SHEETS_URL}?id=${encodeURIComponent(id)}`);
        const data = await response.json();

        if (data.status === "not_found") {
            return res.status(404).json({ status: "not_found", id });
        }

        if (data.status === "error") {
            return res.status(500).json(data);
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// GET /inventario → todos o subset por ?ids=id1,id2
app.get("/inventario", async (req, res) => {
    try {
        const ids = req.query.ids;
        let url = INVENTORY_SHEETS_URL;

        if (ids) {
            url += `?ids=${encodeURIComponent(ids)}`;
        }

        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok || data.status === "error") {
            return res.status(500).json({ status: "error", message: data.message || "Error desde Apps Script" });
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// POST /inventario/:id → upsert de inventario
app.post("/inventario/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const body = { ...req.body, product_id: id };

        const response = await fetch(INVENTORY_SHEETS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!response.ok || data.status === "error") {
            return res.status(500).json({ status: "error", message: data.message || "Error guardando inventario" });
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// DELETE /inventario/:id → eliminar fila del inventario por product_id
app.delete("/inventario/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const response = await fetch(INVENTORY_SHEETS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                action: "delete",
                product_id: id
            })
        });

        const data = await response.json();

        if (data.status === "not_found") {
            return res.status(404).json({ status: "not_found", id });
        }

        if (!response.ok || data.status === "error") {
            return res.status(500).json({
                status: "error",
                message: data.message || "Error eliminando inventario"
            });
        }

        res.json({ status: "success", deleted: id });

    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});


const APP_SHEET_RATINGS_URL = "https://script.google.com/macros/s/AKfycbxzzSXAsaRZJJh3eMmEtFnlKjdAjBG-BJ2JCgEfw2W-2Ehz-qaq4FyFe7i2nqpxyIh9/exec";

// POST /rate-product
app.post("/rate-product", async (req, res) => {
  try {
    const { productId, rating, userHash } = req.body;
    if (!productId || userHash === undefined || rating === undefined) {
      return res.status(400).json({ success: false, message: "Faltan campos: productId, rating o userHash" });
    }

    // Validaciones básicas
    const numericRating = Number(rating);
    if (isNaN(numericRating) || numericRating < 0 || numericRating > 5) {
      return res.status(400).json({ success: false, message: "Rating inválido" });
    }

    // Enviar a Apps Script
    const payload = {
      action: "addOrUpdateRating",
      productId: String(productId),
      userHash: String(userHash),
      rating: numericRating
    };

    const response = await fetch(APP_SHEET_RATINGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      // Si Apps Script devolvió texto, encapsulamos
      return res.status(502).json({ success: false, message: "Respuesta no válida desde Apps Script", raw: text });
    }

    if (json.status === "success") {
      // Devolver al frontend la info necesaria
      return res.json({
        success: true,
        row: json.row,
        productId: json.productId,
        userHash: json.userHash,
        rating: json.rating,
        avgRating: json.avgRating,
        totalVotes: json.totalVotes,
        action: json.action
      });
    } else {
      return res.status(500).json({ success: false, message: json.message || "Error en Apps Script", raw: json });
    }
  } catch (err) {
    console.error("Error /rate-product:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /product-ratings?productId=...
app.get("/product-ratings", async (req, res) => {
  try {
    const productId = req.query.productId;
    if (!productId) return res.status(400).json({ success: false, message: "productId requerido" });

    const payload = { action: "getProductRatings", productId: String(productId) };
    const response = await fetch(APP_SHEET_RATINGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({ success: false, message: "Respuesta no válida desde Apps Script", raw: text });
    }

    if (json.status === "success") {
      return res.json({
        success: true,
        productId: json.productId,
        avgRating: json.avgRating,
        totalVotes: json.totalVotes,
        votes: json.votes // opcional
      });
    } else {
      return res.status(500).json({ success: false, message: json.message || "Error en Apps Script" });
    }
  } catch (err) {
    console.error("Error /product-ratings:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// 🔥 ENDPOINT PARA ENVIAR NOTIFICACIONES DE PRUEBA
// =====================================================
app.post("/api/send-test-notification", async (req, res) => {
  try {
    const { titulo, mensaje, tipoNotificacion } = req.body;

    addLog(`Enviando notificación de prueba: ${titulo} - ${mensaje}`);

    const message = {
      notification: {
        title: titulo || "🧪 Notificación de Prueba",
        body: mensaje || "Esta es una notificación de prueba desde el servidor Buquenque."
      },
      data: {
        tipo: tipoNotificacion || "test",
        timestamp: new Date().toISOString(),
        click_action: "FLUTTER_NOTIFICATION_CLICK"
      },
      topic: "pedidos" // Enviando al mismo topic que los pedidos reales
    };

    // Enviar la notificación
    const responsePush = await admin.messaging().send(message);
    
    addLog(`✅ Notificación de prueba enviada correctamente: ${responsePush}`);
    console.log("✅ Notificación de prueba enviada con éxito:", responsePush);

    return res.status(200).json({
      success: true,
      message: "Notificación de prueba enviada correctamente",
      messageId: responsePush
    });

  } catch (error) {
    const errorMsg = `❌ Error enviando notificación de prueba: ${error.message}`;
    addLog(errorMsg);
    console.error(errorMsg);

    return res.status(500).json({
      success: false,
      message: "Error al enviar la notificación de prueba",
      error: error.message
    });
  }
});

// API para listar tokens FCM suscritos al topic pedidos
app.get('/api/fcm-tokens', async (req, res) => {
  try {
    const tokens = await readJsonFile(fcmTokensFilePath, []);
    return res.json({ success: true, tokens });
  } catch (error) {
    const errorMsg = `ERROR al obtener tokens FCM: ${error.message}`;
    addLog(errorMsg);
    console.error(errorMsg);
    return res.status(500).json({ success: false, message: 'Error al obtener tokens FCM', error: error.message });
  }
});

app.post('/api/suscribir-pedidos', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).json({ success: false, message: 'El campo token es obligatorio' });
    }

    addLog(`Solicitud de suscripción recibida para token: ${token}`);

    const sanitizedToken = token.trim();
    await admin.messaging().subscribeToTopic(sanitizedToken, 'pedidos');

    const tokens = await readJsonFile(fcmTokensFilePath, []);
    if (!tokens.includes(sanitizedToken)) {
      tokens.push(sanitizedToken);
      await writeJsonFile(fcmTokensFilePath, tokens);
      addLog(`Token almacenado: ${sanitizedToken}`);
    }

    return res.json({ success: true, message: 'Token suscrito al topic pedidos', token: sanitizedToken });
  } catch (error) {
    const errorMsg = `ERROR suscribiendo token FCM al topic pedidos: ${error.message}`;
    addLog(errorMsg);
    console.error(errorMsg);
    return res.status(500).json({ success: false, message: 'Error al suscribir al topic pedidos', error: error.message });
  }
});
