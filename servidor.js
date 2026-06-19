const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// CONFIGURACIÓN OFICIAL DE TU BASE DE DATOS EN LA NUBE
const pool = new Pool({
    connectionString: 'postgresql://postgres.fusembqgtennjzdvkxic:pollosW2026@://supabase.com',
    ssl: { rejectUnauthorized: false } 
});

// 1. TRAER LAS MESAS REALES
app.get('/api/mesas', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM mesas ORDER BY numero ASC');
        res.json(resultado.rows); 
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 2. CAMBIAR EL ESTADO DE UNA MESA
app.post('/api/mesas/cambiar-estado', async (req, res) => {
    try {
        const { numero, nuevoEstado } = req.body;
        await pool.query('UPDATE mesas SET estado = $1 WHERE numero = $2', [nuevoEstado, numero]);
        res.json({ mensaje: 'Listo' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});


// A. CREAR UNA MESA CONSECUTIVA
app.post('/api/mesas', async (req, res) => {
    try {
        const maxMesa = await pool.query('SELECT MAX(numero) as maximo FROM mesas');
        const siguienteNumero = (maxMesa.rows.maximo || 0) + 1;

        await pool.query("INSERT INTO mesas (numero, estado) VALUES ($1, 'libre')", [siguienteNumero]);
        res.json({ mensaje: 'Mesa creada con éxito', numero: siguienteNumero });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'No se pudo crear la mesa' });
    }
});
// B. ELIMINAR LA ÚLTIMA MESA DEL SALÓN
app.delete('/api/mesas/ultima', async (req, res) => {
    try {
        const maxMesa = await pool.query('SELECT MAX(numero) as maximo FROM mesas');
        const ultimoNumero = maxMesa.rows.maximo;

        if (!ultimoNumero) return res.status(400).json({ error: 'No hay mesas' });

        const estadoMesa = await pool.query('SELECT estado FROM mesas WHERE numero = $1', [ultimoNumero]);
        if (estadoMesa.rows.estado !== 'libre') {
            return res.status(400).json({ error: 'La mesa está ocupada' });
        }

        await pool.query('DELETE FROM mesas WHERE numero = $1', [ultimoNumero]);
        res.json({ mensaje: 'Mesa deleted', numero: ultimoNumero });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'No se pudo eliminar la mesa' });
    }
});

// 3. TRAER EL MENÚ DE PRODUCTOS (Filtrado estricto para ocultar borrados lógicos)
app.get('/api/productos', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT id, nombre, precio_venta FROM productos WHERE activo = true ORDER BY nombre');
        res.json(resultado.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 4. VER CONSUMO DE LA MESA
app.get('/api/mesas/:numero/consumo', async (req, res) => {
    try {
        const { numero } = req.params;
        const pedidoObj = await pool.query(
            "SELECT id, total FROM pedidos WHERE mesa_id = (SELECT id FROM mesas WHERE numero = $1) AND estado = 'cocina' ORDER BY id DESC LIMIT 1",
            [numero]
        );

        if (pedidoObj.rows.length === 0) {
            return res.json({ pedido_id: null, total: 0, productos: [] });
        }

        const pedidoId = pedidoObj.rows.id;
        const totalPedido = pedidoObj.rows.total;

        const detalles = await pool.query(
            "SELECT pd.cantidad, prod.nombre, pd.subtotal FROM pedido_detalle pd JOIN productos prod ON pd.producto_id = prod.id WHERE pd.pedido_id = $1",
            [pedidoId]
        );

        res.json({ pedido_id: pedidoId, total: totalPedido, productos: detalles.rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 5. DAR DE ALTA UN PRODUCTO
app.post('/api/productos', async (req, res) => {
    try {
        const { nombre, precio } = req.body;
        await pool.query('INSERT INTO productos (categoria_id, nombre, precio_venta, activo) VALUES (1, $1, $2, true)', [nombre, precio]);
        res.json({ mensaje: 'Listo' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// C. NUEVA RUTA: BORRADO LÓGICO SEGURO PARA PRODUCTOS
app.delete('/api/productos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('UPDATE productos SET activo = false WHERE id = $1', [id]);
        res.json({ mensaje: 'Producto deshabilitado con éxito' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});
// 6. GUARDAR O SUMAR UN PEDIDO
app.post('/api/pedidos', async (req, res) => {
    try {
        const { mesa_id, productos, total, cliente_nombre, condicion_pago } = req.body;
        let pedidoId;

        const cajaActiva = await pool.query("SELECT id FROM cajas WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
        if (cajaActiva.rows.length === 0) {
            return res.status(400).json({ error: '🔒 Operación bloqueada: Debes abrir caja primero.' });
        }
        const cajaId = cajaActiva.rows.id;

        if (mesa_id === 'mostrador') {
            const estadoENUM = condicion_pago === 'pagado' ? 'pagado' : 'cocina';
            const fechaCierre = condicion_pago === 'pagado' ? 'NOW()' : null;

            let consultaSQL;
            let parametros;

            if (condicion_pago === 'pagado') {
                consultaSQL = `
                    INSERT INTO pedidos (mesa_id, usuario_id, tipo, estado, subtotal, total, fecha_cierre) 
                    VALUES ((SELECT id FROM mesas ORDER BY id ASC LIMIT 1), 1, 'mesa', $1, $2, $2, NOW()) RETURNING id
                `;
                parametros = [estadoENUM, total];
            } else {
                consultaSQL = `
                    INSERT INTO pedidos (mesa_id, usuario_id, tipo, estado, subtotal, total, fecha_cierre) 
                    VALUES ((SELECT id FROM mesas ORDER BY id ASC LIMIT 1), 1, 'mesa', $1, $2, $2, NULL) RETURNING id
                `;
                parametros = [estadoENUM, total];
            }

            const nuevoPedido = await pool.query(consultaSQL, parametros);
            pedidoId = nuevoPedido.rows.id;

            if (condicion_pago === 'pagado') {
                await pool.query(
                    "INSERT INTO movimientos_caja (caja_id, tipo, metodo_pago, monto, observacion) VALUES ($1, 'venta', 'efectivo', $2, $3)", 
                    [cajaId, total, `Mostrador: ${cliente_nombre}`]
                );
            } else {
                await pool.query(
                    "INSERT INTO movimientos_caja (caja_id, tipo, metodo_pago, monto, observacion) VALUES ($1, 'venta', 'efectivo', 0, $2)", 
                    [cajaId, `[Por Pagar $${total}] Mostrador: ${cliente_nombre}`]
                );
            }
        } else {
            const pedidoExistente = await pool.query(
                "SELECT id, total FROM pedidos WHERE mesa_id = (SELECT id FROM mesas WHERE numero = $1) AND estado = 'cocina' LIMIT 1",
                [mesa_id]
            );

            if (pedidoExistente.rows.length > 0) {
                pedidoId = pedidoExistente.rows.id;
                const nuevoTotal = Number(pedidoExistente.rows.total) + Number(total);
                await pool.query("UPDATE pedidos SET subtotal = $1, total = $2 WHERE id = $3", [nuevoTotal, nuevoTotal, pedidoId]);
            } else {
                const nuevoPedido = await pool.query(
                    "INSERT INTO pedidos (mesa_id, usuario_id, tipo, estado, subtotal, total) VALUES ((SELECT id FROM mesas WHERE numero = $1), 1, 'mesa', 'cocina', $2, $3) RETURNING id",
                    [mesa_id, total, total]
                );
                pedidoId = nuevoPedido.rows.id;
            }
            await pool.query("UPDATE mesas SET estado = 'ocupada' WHERE numero = $1", [mesa_id]);
        }

        for (const prod of productos) {
            const detalleExistente = await pool.query("SELECT id, cantidad FROM pedido_detalle WHERE pedido_id = $1 AND producto_id = $2", [pedidoId, prod.producto_id]);
            if (detalleExistente.rows.length > 0) {
                const nuevaCantidad = Number(detalleExistente.rows.cantidad) + Number(prod.cantidad);
                await pool.query("UPDATE pedido_detalle SET cantidad = $1, subtotal = precio_unitario * $1 WHERE id = $2", [nuevaCantidad, detalleExistente.rows.id]);
            } else {
                await pool.query("INSERT INTO pedido_detalle (pedido_id, producto_id, cantidad, precio_unitario, subtotal) VALUES ($1, $2, $3, $4::numeric, $4::numeric * $3::integer)", [pedidoId, prod.producto_id, prod.cantidad, prod.precio_unitario]);
            }
        }

        res.json({ mensaje: 'Listo', pedido_id: pedidoId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// PASAR PEDIDO DE MOSTRADOR A PAGADO
app.post('/api/mostrador/pagar', async (req, res) => {
    try {
        const { pedido_id, total, cliente } = req.body;
        const cajaActiva = await pool.query("SELECT id FROM cajas WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
        if (cajaActiva.rows.length === 0) return res.status(400).json({ error: 'Debes abrir caja' });
        const cajaId = cajaActiva.rows.id;

        await pool.query("DELETE FROM movimientos_caja WHERE caja_id = $1 AND observacion LIKE $2", [cajaId, `%Mostrador: ${cliente}`]);
        await pool.query("INSERT INTO movimientos_caja (caja_id, tipo, metodo_pago, monto, observacion) VALUES ($1, 'venta', 'efectivo', $2, $3)", [cajaId, total, `Mostrador: ${cliente}`]);
        await pool.query("UPDATE pedidos SET estado = 'pagado', fecha_cierre = NOW() WHERE id = $1", [pedido_id]);

        res.json({ mensaje: 'Listo' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});
// 7. PROCESAR PAGO SALÓN
app.post('/api/pedidos/pagar', async (req, res) => {
    try {
        const { pedido_id, metodo_pago } = req.body;
        const cajaActiva = await pool.query("SELECT id FROM cajas WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
        if (cajaActiva.rows.length === 0) return res.status(400).json({ error: 'Debes abrir caja' });
        const cajaId = cajaActiva.rows.id;

        const pedidoActualizado = await pool.query("UPDATE pedidos SET estado = 'pagado', fecha_cierre = NOW() WHERE id = $1 RETURNING total, mesa_id", [pedido_id]);
        const totalDinero = pedidoActualizado.rows.total;
        const mesaId = pedidoActualizado.rows.mesa_id;

        await pool.query("UPDATE mesas SET estado = 'libre' WHERE id = $1", [mesaId]);
        await pool.query("INSERT INTO movimientos_caja (caja_id, tipo, metodo_pago, monto, observacion) VALUES ($1, 'venta', $2, $3, 'Venta')", [cajaId, metodo_pago.toLowerCase(), totalDinero]);

        res.json({ mensaje: 'Listo' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 8. REVISAR ESTADO ACTUAL DE LA CAJA (VERSIÓN BLINDADA CONTRA TABLAS VACÍAS)
app.get('/api/caja/estado-actual', async (req, res) => {
    try {
        const resultado = await pool.query("SELECT id, apertura::INTEGER as apertura, estado, TO_CHAR(fecha_apertura, 'DD/MM/YYYY HH:24:MI') as fecha_f FROM cajas WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
        
        if (!resultado || resultado.rows.length === 0) {
            return res.json({ abierta: false, caja: null });
        }
        res.json({ abierta: true, caja: resultado.rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});


// BARRA DE GANANCIAS
app.get('/api/caja/reporte-diario', async (req, res) => {
    try {
        const cajaActiva = await pool.query("SELECT id, apertura FROM cajas WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
        if (cajaActiva.rows.length === 0) return res.json({ ingresos: 0, total_caja: 0 });
        
        const cajaId = cajaActiva.rows.id;
        const apertura = Number(cajaActiva.rows.apertura) || 0;

        const resultadoVentas = await pool.query("SELECT SUM(monto)::INTEGER as total FROM movimientos_caja WHERE caja_id = $1 AND tipo = 'venta'", [cajaId]);
        const ingresos = Number(resultadoVentas.rows.total) || 0;

        res.json({ ingresos: ingresos, total_caja: (apertura + ingresos) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 9. RUTA PARA ABRIR CAJA DESDE WEB
app.post('/api/caja/abrir', async (req, res) => {
    try {
        const { monto_apertura } = req.body;
        const resultado = await pool.query("INSERT INTO cajas (usuario_id, fecha, apertura, estado, fecha_apertura) VALUES (1, CURRENT_DATE, $1, 'abierta', NOW()) RETURNING id", [monto_apertura]);
        res.json({ mensaje: 'Listo', caja_id: resultado.rows.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 10. REALIZAR ARQUEO, CIERRE DE CAJA Y BALANCE DEL TURNO
app.post('/api/caja/cerrar', async (req, res) => {
    try {
        const cajaActiva = await pool.query("SELECT id, apertura FROM cajas WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
        if (cajaActiva.rows.length === 0) return res.status(400).json({ error: 'No hay caja abierta.' });
        
        const cajaId = cajaActiva.rows.id;
        const montoApertura = Number(cajaActiva.rows.apertura) || 0;

        const ventasMesasRes = await pool.query("SELECT COALESCE(SUM(monto), 0)::INTEGER as total FROM movimientos_caja WHERE caja_id = $1 AND observacion NOT LIKE 'Mostrador:%'", [cajaId]);
        const totalMesas = ventasMesasRes.rows.total;

        const ventasMostradorRes = await pool.query("SELECT COALESCE(SUM(monto), 0)::INTEGER as total FROM movimientos_caja WHERE caja_id = $1 AND observacion LIKE 'Mostrador:%'", [cajaId]);
        const totalMostrador = ventasMostradorRes.rows.total;

        const totalGanancias = totalMesas + totalMostrador;
        const totalCajaEntrega = montoApertura + totalGanancias;

        await pool.query("UPDATE cajas SET estado = 'cerrada', fecha_cierre = NOW() WHERE id = $1", [cajaId]);
        await pool.query("DELETE FROM pedido_detalle");
        await pool.query("DELETE FROM pedidos");

        res.json({
            mensaje: 'Listo',
            apertura: montoApertura,
            mesas: totalMesas,
            mostrador: totalMostrador,
            ganancias: totalGanancias,
            total_entrega: totalCajaEntrega
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 11. HISTORIAL DE MOSTRADOR COMPLETO
app.get('/api/mostrador/pedidos', async (req, res) => {
    try {
        const consulta = `
            SELECT p.id, p.total, p.estado,
            COALESCE(
                (SELECT REPLACE(mc.observacion, 'Mostrador: ', '') FROM movimientos_caja mc WHERE (mc.monto = p.total OR mc.observacion LIKE '%' || p.total || '%') AND (mc.observacion LIKE 'Mostrador:%' OR mc.observacion LIKE '[Por Pagar%') ORDER BY mc.id DESC LIMIT 1),
                'Cliente Mostrador'
            ) as cliente,
            STRING_AGG(pd.cantidad || 'x ' || prod.nombre, ', ') as detalle_productos
            FROM pedidos p
            LEFT JOIN pedido_detalle pd ON pd.pedido_id = p.id
            LEFT JOIN productos prod ON pd.producto_id = prod.id
            WHERE p.tipo = 'mesa' AND p.mesa_id = (SELECT id FROM mesas ORDER BY id ASC LIMIT 1)
            GROUP BY p.id, p.total, p.estado
            ORDER BY p.id DESC
        `;
        const resultado = await pool.query(consulta);
        res.json(resultado.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// CONFIGURACIÓN DE PUERTO UNIVERSAL PARA INTERNET
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor de Pollos W operando en internet en el puerto ${PORT}`);
});
