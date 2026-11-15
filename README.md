# Zaldo

Asistente de saldo en WhatsApp. Le escribes o le mandas una nota de voz, confirma con un botón y cobra con CoDi por la API de Pey. El dinero cae en la cuenta ligada a la API key. Zaldo solo apunta y avisa cuando el webhook dice que ya se pagó.

Repo del equipo: https://github.com/LuisandovalU/Zaldo

## Qué hace

- Nota de voz o texto.
- Tarjeta con Confirmar y Cancelar antes de crear el cobro.
- Push CoDi al celular. Si pides QR, manda la imagen. Si pides link, manda la página de pago.
- «Ya cayó» cuando Pey avisa.
- Contactos, repetir un cobro, apuntes que no mueven dinero y «¿cómo va mi zaldo?».
- Tope diario. Otro celular, si hay lista, no crea cobros.

## Correrlo

```bash
npm install
copy .env.example .env
npm test
npm run dev
```

Las llaves van en `.env`. No se suben a git.

Pey y WhatsApp tienen que poder llegar al servidor por HTTPS:

- `https://TU_URL/webhooks/whatsapp`
- `https://TU_URL/webhooks/pey`

En Meta, el token de verificación es el mismo `WHATSAPP_VERIFY_TOKEN`. En el portal de Pey, el webhook es uno solo por API key: guarda el secreto en `PEY_WEBHOOK_SECRET`.

Mientras Banxico activa la cuenta (unos 5 días), la key de prueba apunta a la CLABE de pruebas. Cobra $0.01.

## Demo

Desde el número de prueba de WhatsApp:

1. Nota de voz: «Zaldo, cóbrame un centavo de prueba.»
2. Confirmar.
3. Pagar el push en la app del banco.
4. Zaldo contesta: «Ya cayó, $0.01 de ti · Prueba.»

## Panel administrador

En `/admin`. Vive en dos carpetas independientes: `src/auth/` es el login y no
sabe nada de cobros; `src/admin/` es el panel y solo lee. Ninguno crea cobros
ni manda WhatsApp, así que entrar al panel nunca mueve dinero.

### Encenderlo

```bash
npm run admin:hash -- tu-usuario
```

Pide la contraseña sin mostrarla y escupe las dos líneas que faltan en `.env`:

```
ADMIN_USERS=tu-usuario:scrypt$16384$8$1$...
ADMIN_SESSION_SECRET=...
```

Sin esas dos variables el panel queda apagado y Zaldo corre igual: `/admin`
responde 404. Varios admins van separados por comas.

### Qué muestra

| Pestaña | Qué hay |
|---|---|
| Resumen | Cobrado hoy contra el tope diario, pendiente, pagado, conversión, barras de 14 días |
| Cobros | Todos los cobros, con filtros por estado, método, dueño y texto, y descarga a CSV |
| Usuarios | Un renglón por celular que usa Zaldo, con sus cobros, contactos y apuntes |
| Conciliación | Lo que Pey dice que cobró, frente al libro de Zaldo |
| Ajustes | La configuración en vigor, sin las llaves |

### Conciliación

Lee `GET /transaction/api-key` de Pey, que devuelve las transacciones reales de
la API key, 80 por página. De ahí sale lo que el libro local no guarda: la
comisión que Pey descuenta (`amountBreakdown.fee`) y el neto que de verdad
llega a la cuenta. Las cruza por `metadata.chargeId`, que Zaldo ya manda al
crear cada CoDi y cada link, y señala cuatro descuadres:

- **Pagado en Pey, no en Zaldo** — se perdió el webhook. Tiene botón «Marcar
  pagado», que vuelve a preguntarle a Pey por esa transacción y solo corrige el
  libro si Pey la confirma `PAID` y pertenece a ese cobro.
- **Pagado en Zaldo, no en Pey** — revisar a mano.
- **Monto distinto** — Pey cobró algo diferente de lo que Zaldo esperaba.
- **Sin cobro local** — entró dinero por fuera de Zaldo con la misma API key.

Se consulta a Pey una vez por minuto como máximo; «Actualizar» fuerza la
lectura. Si Pey no responde, el panel lo dice y sigue mostrando lo local.

### Privacidad

Los celulares salen enmascarados (`52•••••111`) y las URL usan un
identificador opaco derivado del secreto de sesión, para que el número no
quede en el historial del navegador ni en los logs del proxy. Las llaves de
Pey, WhatsApp y OpenRouter no se muestran en ninguna pantalla.

### Seguridad

Contraseñas con scrypt y comparación en tiempo constante; un usuario que no
existe cuesta lo mismo que uno real, para no delatarlo por el tiempo de
respuesta. Sesión en cookie firmada con HMAC, `HttpOnly`, `Secure`,
`SameSite=Strict`. Token CSRF en los dos POST (entrar y reparar). Cinco
intentos fallidos por IP y por usuario frenan quince minutos. El panel solo
acepta `GET`, salvo el POST de reparar.

### Desplegarlo en un PaaS (ih0st, Railway y similares)

El puerto ya se toma de `PORT`, que es lo que inyecta la plataforma.

- `ADMIN_COOKIE_SECURE=true` — la plataforma sirve HTTPS.
- `ADMIN_TRUST_PROXY=true` — para contar la IP real detrás del proxy. Déjalo en
  `false` si nada hace de proxy, porque entonces cualquiera podría saltarse el
  límite mandando un `X-Forwarded-For` inventado.
- `PUBLIC_BASE_URL=https://tu-dominio` — hace falta para el link de pago.
- **`DATA_PATH` tiene que apuntar a un volumen persistente**, por ejemplo
  `/data/zaldo.json`. El disco de un contenedor se borra en cada redeploy: sin
  volumen se pierde el libro completo de cobros. La conciliación ayuda a
  recuperar el dinero desde Pey, pero no los contactos ni los apuntes.
