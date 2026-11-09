# PRD: Calendario anual de carnavales y fiestas del mundo con actualización por IA

Oct 26, 2026 · @Alexis Vega

## Resumen

Construir un sitio estático que muestre, para los próximos 12 meses y en cualquier país, solo las fiestas con mayor convocatoria y fiesta en la calle, y que se mantenga al día con un job semanal que usa la API de Claude para proponer cambios con fuente.

**Decisiones clave:**

- **El país es un dato, no una versión:** un solo esquema global con código de país ISO 3166, zona horaria IANA y nombres en varios idiomas. Se lanzó con un piloto (Colombia ya verificada y 4 países más); desde el 2026-11-09 cualquier país se construye a pedido, al elegirlo en el sitio, y se publica cuando pasa los controles en código.
- **Ranking dentro de cada país:** la vista global muestra solo el Nivel 1; al elegir un país siempre aparecen sus 5 fiestas con mejor puntaje, para que los países pequeños no desaparezcan detrás de Río u Oktoberfest.
- **La IA propone y los controles en código aprueban (2026-11-09; antes, una persona aprobaba cada PR):** un workflow diario de GitHub Actions consulta la API, valida en código, aplica lo que pasa los controles y lo sube a `main`; lo dudoso queda retenido. Cada corrida es un commit que se revierte con `git revert`. La API key vive solo en los secretos del repositorio.
- **La UX se mide con tareas:** el lanzamiento exige que 5 usuarios completen 5 tareas clave con 90% de éxito, Core Web Vitals en verde y WCAG 2.2 AA.

**Qué entrega Claude Code en el MVP:**

- Sitio mobile-first en español, inglés y portugués: inicio «Lo próximo», explorador con filtros por país, mes, tipo y fechas de viaje, ficha por fiesta y lista de guardadas.
- `data/countries/<cc>.json`, un archivo por país, con fiestas, puntaje y regla de fecha.
- Motor de fechas con pruebas: fijas, atadas a Pascua gregoriana u ortodoxa, n-ésimo día de la semana, relativas a otra fiesta, bienales y tablas de calendarios lunares.
- Pipeline diario (`pnpm pipeline`, `pipeline.yml`) que construye países a pedido y mantiene frescos los publicados dentro del presupuesto mensual.
- Calendario: descarga .ics y suscripción por país que se actualiza sola.

**Decisión del 2026-11-09 (construir el mundo a pedido):** el sitio ya no se limita a un piloto. Cualquier país de la lista se puede pedir desde su página («Construir <país>», que abre un issue con el formulario `build-country`); solo los issues del dueño del repo gastan. El pipeline redacta la política de fuentes del país, hace el onboarding, completa fechas y lo publica en cuanto tiene 3 fiestas con fecha y fuente A o B. Los cambios que pasan los controles se aplican sin revisión humana; los que mueven una fecha confirmada o suspenden una fiesta sin dos sitios independientes, y las corridas que cambian más de la mitad de las fechas de un país, quedan retenidos en `data/state/holds.json` y en un issue «Needs a look». La frecuencia de verificación depende de lo cerca que está cada fiesta y del presupuesto: 30% del mes para países nuevos, el resto repartido en los días que quedan. Detalle en «Actualización con IA» y en `docs/architecture.md`.

**Cómo usar este PRD:** exportarlo como Markdown, guardarlo como `PRD.md` en la raíz del repo y pedirle a Claude Code que ejecute los hitos de «Plan de entrega» en orden, cerrando cada uno con sus pruebas en verde.

## Problema, usuarios y objetivos

Las fechas de las grandes fiestas cambian cada año, siguen calendarios distintos según el país (gregoriano, lunar, atado a la Pascua) y pueden suspenderse por hechos como el sismo del 10 ago 2026 en Colombia. La información está repartida en sitios oficiales, en el idioma de cada país.

**Usuarios:** viajeros que planifican por temporadas y quieren estar donde hay más gente y más fiesta en la calle. Usuario piloto: 2 viajeros desde Lima.

**Trabajos por hacer:**

1. Saber qué fiestas grandes vienen en los próximos 12 meses, en el mundo o en los países que me interesan.
2. Ver qué fiestas caen dentro de mis fechas de viaje.
3. Distinguir qué fecha es oficial, cuál se deduce de años anteriores y cuál falta.
4. Llevar las fechas a mi calendario y que se actualicen solas.
5. Enterarme de un cambio sin buscarlo a mano.

**Objetivos medibles del MVP:**

- Responder «qué viene y cuándo» en menos de 10 segundos desde el teléfono, en cualquier país del piloto.
- Fechas de Nivel 1 revisadas contra fuente oficial cada 14 días cuando faltan menos de 120 días.
- Cada país del piloto con al menos 3 fiestas verificadas.
- Cero cambios sin fuente publicados.

## Alcance

El MVP cubre cualquier país a nivel de datos y lanza con 5 países piloto; los demás entran por onboarding sin tocar código.

| Dentro del MVP | Fuera del MVP |
| --- | --- |
| Esquema global y 5 países piloto | Cobertura completa de todos los países el día 1 |
| Inicio «Lo próximo» por país, región o en el mundo | Mapa interactivo (v2) |
| Explorador con filtros: país, mes, tipo de fiesta, nivel y mis fechas de viaje | Presupuesto, rutas y checklist de compras (existen en la [herramienta de decisión](https://claude.ai/artifact/DHppMLnw4ZnwrAPNCu1CNu)) |
| Ficha por fiesta con estado, confianza, fuentes y cómo vivirla en la calle | Venta o reserva de boletos, vuelos u hospedaje |
| Guardadas en el dispositivo y búsqueda por nombre o ciudad | Cuentas de usuario y sincronización entre dispositivos |
| Interfaz en español, inglés y portugués | Otros idiomas (se agregan con archivos de traducción) |
| Descarga .ics y suscripción a un calendario por país | Notificaciones por correo, push o WhatsApp |
| Pipeline diario: países a pedido y verificación según cercanía y presupuesto, con commit directo a `main` | Botón «actualizar ahora» desde la web (v2, requiere backend) |

## Criterios de priorización

Una fiesta entra a la vista global si suma 65 puntos o más sobre 100; dentro de cada país siempre se muestran sus 5 mejores, aunque no lleguen a 65.

Puntaje = Convocatoria + Fiesta en la calle + Reconocimiento + Conectividad + Gente local. Los pesos viven en `config/scoring.json` para ajustarlos sin tocar código. La escala es absoluta en todos los países, así una fiesta de Lima y una de Múnich se comparan con la misma regla.

| Criterio | Máx. | Cómo se mide | Escala |
| --- | --- | --- | --- |
| Convocatoria | 35 | Asistentes o visitantes del último balance oficial | 1 millón o más = 35; 250 mil a 1 millón = 26; 100 a 250 mil = 18; 25 a 100 mil = 10; menos = 4 |
| Fiesta en la calle | 25 | Parte de eventos gratuitos y abiertos, juego colectivo | Mayoría gratis y participativa = 25; mixta = 15; mayoría con boleta = 5 |
| Reconocimiento | 20 | Lista de Patrimonio Cultural Inmaterial de la UNESCO o declaratoria nacional | UNESCO = 20; patrimonio nacional = 12; ninguna = 0 |
| Conectividad | 10 | Aeropuerto en la ciudad | Con vuelos internacionales = 10; solo nacionales = 6; ninguno = 2 |
| Gente local | 10 | Tamaño del lugar | Pueblo = 10; ciudad intermedia = 6; gran ciudad = 3 |

**Qué se muestra:**

- **Vista global:** solo Nivel 1, 65 puntos o más.
- **Vista por país:** sus 5 mejores puntajes, más cualquier otra de Nivel 1.
- **Nivel 2,** de 45 a 64, con un interruptor en ambas vistas; menos de 45 no se muestra.
- **Sin dato:** el criterio vale 0, se marca «por medir» y el puntaje se muestra como rango.

**Piloto Colombia, con los datos verificados hoy:**

| Fiesta | Convocatoria | Calle | Reconoc. | Conect. | Local | Puntaje hoy | Nivel |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Carnaval de Barranquilla | 35 (más de 6 millones de asistentes, 2026) | 25 (380 de 500+ eventos gratis) | 20 (UNESCO) | 10 | 3 | 93 | 1 |
| Carnaval de Negros y Blancos, Pasto | 26 (\~250 mil turistas, 2026) | 25 | 20 (UNESCO) | 6 | 6 | 83 | 1 |
| Feria de Cali | 26 (más de 700 mil, fuente comercial débil) | 15 | por verificar | 10 | 3 | 54 a 74 | Provisional |
| Festival de la Leyenda Vallenata | 18 (137.672 turistas, edición 55) | 15 | por verificar | 6 | 6 | 45 a 65 | Provisional |
| Fiestas de San Pacho, Quibdó | por medir | 25 | 20 (UNESCO) | 6 | 6 | 57 a 92 | Provisional |
| Festival de Tambores, Palenque | por medir | 25 | 20 (UNESCO) | 2 | 10 | 57 a 92 | Provisional |
| Carnaval de Riosucio (años impares) | 10 (\~30 mil visitantes esperados, 2023) | 25 | 12 (prensa) | 2 | 10 | 59 | 2 |
| Fiestas de Independencia, Cartagena | por medir | 15 | por verificar | 10 | 3 | 28 a 83 | Provisional |
| Feria de las Flores, Medellín | por medir | por verificar | por verificar | 10 | 3 | 13 a 93 | Provisional |
| Festival Petronio Álvarez, Cali | por medir | por verificar | por verificar | 10 | 3 | 13 a 93 | Provisional |

**Candidatas para el primer onboarding** (sin verificar; el pipeline confirma fechas, asistencia y declaratorias antes de que aparezcan):

| País | Candidatas |
| --- | --- |
| Perú | Fiesta de la Virgen de la Candelaria en Puno; Inti Raymi en Cusco |
| Brasil | Carnaval de Río de Janeiro; Carnaval de Salvador |
| Bolivia | Carnaval de Oruro |
| México | Día de Muertos; Guelaguetza en Oaxaca |
| Fuera del piloto | Las Fallas y Sanfermines (España); Oktoberfest (Alemania); Notting Hill Carnival (Reino Unido); Carnaval de Trinidad y Tobago; Holi (India); Songkran (Tailandia) |

Con estos pesos, más gente pesa más que conocer locales: Riosucio queda en Nivel 2 aunque sea la mejor para conversar, pero igual aparece en la vista de Colombia por estar entre sus 5 mejores.

## Reglas de fechas y datos semilla

Las fechas se calculan con reglas deterministas en la zona horaria de cada fiesta y la IA solo confirma o corrige; una fecha confirmada por el organizador siempre gana sobre la regla.

**Tipos de regla que soporta el motor:**

- `fixed`: mismo día y mes cada año.
- `easter_offset`: días desde el Domingo de Pascua, con `calendar` en `gregorian` u `orthodox` (cómputo juliano convertido a fecha gregoriana).
- `nth_weekday`: n-ésimo o último día de la semana de un mes, por ejemplo primer viernes de enero o último lunes de agosto.
- `relative_to`: días antes o después de otra fiesta o evento clave, por ejemplo la Guacherna respecto del Carnaval de Barranquilla.
- `parity`: solo años pares o impares, combinable con las anteriores.
- `lunisolar_table`: fechas de calendarios lunares o lunisolares (hindú, chino, islámico, budista) tomadas de una tabla revisada con 5 años por delante; el motor nunca las calcula por su cuenta.
- `announced`: sin regla fiable; se guarda una ventana probable y se muestra «por anunciar» hasta tener fuente.

Cada fiesta guarda su zona horaria IANA. Las fechas son días locales sin hora, así no se corren al verlas desde otro país, y la interfaz las formatea según el idioma del usuario.

**Piloto Colombia:**

| Fiesta | Regla | Próxima edición | Estado hoy |
| --- | --- | --- | --- |
| Fiestas de Independencia, Cartagena | `fixed` ventana 10 a 16 nov, eje 11 nov | 10 al 16 nov 2026 | Oficial |
| Feria de Cali | `fixed` 25 a 30 dic | 25 al 30 dic 2026 | Oficial; programa diario pendiente |
| Carnaval de Riosucio | `parity` impar + `nth_weekday` primer viernes de enero, 6 días | 1 al 6 ene 2027 | Oficial |
| Carnaval de Negros y Blancos | `fixed` 2 a 7 ene; Negros 5 ene, Desfile Magno 6 ene | 2 al 7 ene 2027 | Oficial |
| Carnaval de Barranquilla | `easter_offset` gregoriana −50 a −47; Guacherna `relative_to` −8 días | 6 al 9 feb 2027; Guacherna 29 ene | Oficial |
| Festival de la Leyenda Vallenata | `announced`, ventana 25 abr a 5 may | 28 abr al 1 may 2027 | Oficial |
| Feria de las Flores | `announced`, ventana 25 jul a 15 ago | \~30 jul al 8 ago 2027 | Patrón |
| Festival Petronio Álvarez | `announced`, ventana agosto | Por anunciar | Sin fecha |
| Fiestas de San Pacho | `fixed` 20 sep a 5 oct | 20 sep al 5 oct 2027 | Patrón |
| Festival de Tambores, Palenque | `announced`, ventana mediados de octubre | Por anunciar | Patrón |

La regla de Riosucio sale de tres ediciones: 6 al 11 ene 2023, 3 al 8 ene 2025 y 1 al 6 ene 2027, todas desde el primer viernes de enero.

**Casos de prueba obligatorios (Vitest):**

- [ ] Pascua gregoriana 2027 = 2027-03-28 y 2028 = 2028-04-16; Pascua ortodoxa 2027 = 2027-05-02
- [ ] Barranquilla 2027 = 2027-02-06 a 2027-02-09; Barranquilla 2028 = 2028-02-26 a 2028-02-29
- [ ] Guacherna 2027 = 2027-01-29
- [ ] Riosucio 2023 = 2023-01-06 a 01-11; 2025 = 2025-01-03 a 01-08; 2027 = 2027-01-01 a 01-06; 2028 = sin edición
- [ ] Pasto 2027 = 2027-01-02 a 2027-01-07; Cali 2026 = 2026-12-25 a 2026-12-30
- [ ] Último lunes de agosto 2027 = 2027-08-30
- [ ] `lunisolar_table` sin fila para un año devuelve «por anunciar», nunca una fecha estimada
- [ ] Una fecha guardada para `Asia/Tokyo` se muestra el mismo día desde `America/Lima`
- [ ] Con hoy = 2026-10-26 y país = CO, la primera fiesta próxima es Cartagena
- [ ] Una fecha confirmada en los datos reemplaza a la calculada por la regla

## Requisitos funcionales

Diecinueve requisitos, cada uno con una prueba que Claude Code debe dejar pasando antes de cerrar el hito.

| ID | Requisito | Criterio de aceptación |
| --- | --- | --- |
| RF-01 | Inicio «Lo próximo»: las 3 fiestas siguientes del ámbito elegido (mundo, región o país) con cuenta regresiva | Visible sin scroll en un teléfono de 390 px; cambia al elegir otro país |
| RF-02 | Selector de país con búsqueda | Tolera tildes, mayúsculas y otros idiomas: «peru», «Perú» y «Peru» dan Perú, «brazil» da Brasil; los 3 últimos países usados aparecen arriba |
| RF-03 | Explorador con filtros: país, mes, tipo de fiesta, nivel y mis fechas de viaje | Cada filtro es un chip con el conteo de resultados; «Limpiar filtros» en un toque; el estado vive en la URL y se puede compartir |
| RF-04 | Mis fechas de viaje | Un rango muestra solo fiestas que se solapan con él: 2027-02-01 a 2027-02-10 en Colombia devuelve Barranquilla |
| RF-05 | Línea de tiempo de 12 meses móviles con lista equivalente | Cada barra tiene su fila en la lista; los lectores de pantalla reciben la lista |
| RF-06 | Ficha de fiesta | Nombre original y traducido, ciudad y país, fechas en el formato del idioma, estado, puntaje desglosado, eventos clave, cómo vivirla en la calle, fuentes con fecha de verificación, botones guardar y calendario |
| RF-07 | Estados: confirmada, tentativa, por anunciar, aplazada, cancelada | Se distinguen por texto y forma, no solo por color; una cancelada se muestra tachada con su fuente |
| RF-08 | Etiqueta de confianza por dato: oficial, prensa, patrón, estimación | Ningún dato se muestra sin etiqueta |
| RF-09 | Guardadas | Guardar con un toque; persiste en `localStorage` con try/catch; exportar todas a un .ics |
| RF-10 | Calendario | .ics por fiesta (RFC 5545, día completo, `DTEND` exclusivo, `UID` estable = slug + año) y suscripción webcal por país generada en el build; lo no confirmado lleva «\[Por confirmar\]» en el título; se importa en Google Calendar, Apple Calendar y Outlook |
| RF-11 | Idioma: español, inglés y portugués | Toma el idioma del navegador, se cambia en Ajustes y se recuerda |
| RF-12 | Enlaces directos | `#/pais/<cc>` y `#/fiesta/<slug>` abren esa vista al cargar |
| RF-13 | Aviso de datos viejos | Si los datos de un país tienen más de 30 días, aviso con la fecha |
| RF-14 | «Cerca de mí», opcional | Solo con permiso explícito; la ubicación no sale del dispositivo; sin permiso la app funciona igual |
| RF-15 | Verificación y construcción de países con IA | El pipeline diario aplica los cambios citados que pasan los controles y retiene el resto; ver «Actualización con IA» |
| RF-16 | Nada llega al sitio sin pasar los controles y CI | El deploy solo corre desde `main` y después de un CI en verde; cada cambio de datos llega por un commit del pipeline (validado por `build-data`) o por un PR |
| RF-17 | «Reportar un error» y «Reportar contenido» en cada ficha | Abren un formulario de issue de GitHub con la fiesta, el campo y la fuente ya llenos; se atienden en 48 h (R1, R5) |
| RF-18 | El .ics refleja el estado de la fiesta | STATUS en TENTATIVE, CONFIRMED o CANCELLED según el estado; cada cambio sube SEQUENCE; probado con una cancelación simulada (R9) |
| RF-19 | Fechas que dependen de la luna marcadas como estimadas | Muestran «estimada, puede variar un día» hasta que haya anuncio oficial (R4) |

## Actualización con IA

La IA propone y los controles en código aprueban (desde el 2026-11-09): cada día un workflow de GitHub Actions decide qué toca verificar según la cercanía de cada fiesta y el presupuesto, consulta la API de Claude con búsqueda web, valida la respuesta en código, aplica los cambios que pasan y los sube a `main` en un solo commit con cada cambio y su fuente.

&#91;embedded content: flujo semanal de actualización, 6 pasos y 2 decisiones\]

Si la validación falla o un cambio queda retenido, el sitio sigue mostrando el dato anterior.

**Disparadores:** una corrida diaria a las 11:00 UTC; un issue `build-country` del dueño del repo (lo construye en el acto si el presupuesto alcanza); y la ejecución manual (`workflow_dispatch`) con un país opcional o solo el plan.

**Qué fiestas se verifican (desde el 2026-11-09):** el planificador (`scripts/lib/plan.ts`) mira cuándo se revisó cada fiesta por última vez según el registro de gasto, así una revisión que no encontró nada tampoco se repite al día siguiente. Una edición sin confirmar se revisa cada 7 días en sus últimos 45, cada 14 hasta los 120, cada 30 hasta los 180 y cada 60 después; una confirmada o cancelada cada 30 días a menos de 120 y cada 90 después; el Nivel 2 y menores, la mitad de seguido fuera de los 45 días. Los barridos de noticias van cada 7 días en los últimos 45 y a diario (cada dos días para Nivel 2) en la última semana. Si el costo del mes a esa cadencia no cabe en la parte de mantenimiento, todo lo que está a más de 45 días se espacia hasta 4 veces. Cada día se gasta como mucho lo que queda de esa parte dividido por los días que faltan, de mayor a menor prioridad; lo que no entra sigue pendiente al día siguiente. Regla anterior, para la historia: una edición sin confirmar entra a la cola cada semana cuando empieza en menos de 180 días, y solo en la primera semana del mes cuando falta más; una confirmada entra cuando su `last_verified` tiene más de 30 días (14 cuando faltan menos de 120), porque los barridos de noticias (R9) ya vigilan sus últimos 45 días. Una cancelada sigue la misma regla que una confirmada y sale de los barridos: ya no le quedan fechas por buscar ni nada que cancelar (2026-11-08). Una corrida manual con `--country` incluye siempre las del mes. La cola se ordena por días hasta el inicio y luego por nivel, con tope `MAX_FESTIVALS_PER_RUN` (por defecto 40) y máximo 10 por país, para que ninguno se lleve todo el presupuesto. Esta cadencia (2026-11-08) reemplaza la verificación semanal de todo lo que empezaba en menos de 180 días: con la búsqueda directa cada fiesta cuesta unos US$0,25 por pasada y esa regla gastaba unos US$49 al mes contra un tope de US$20.

**Dos llamadas por fiesta:**

1. **Investigación.** Messages API con el modelo de `ANTHROPIC_MODEL` (por defecto `claude-sonnet-5-5`) y la herramienta `web_search_20250305` con `max_uses: 5` y `user_location` con el `country` y la `timezone` de la fiesta. El prompt busca en el idioma local y en inglés, prioriza organizadores, gobiernos y prensa del país, y obliga a responder «no encontrado» en vez de deducir. Si llega `stop_reason: "pause_turn"`, se reenvía el mensaje tal cual para continuar. La primera pasada se limita a fuentes A (R7); si cita páginas pero no da el inicio o el fin de una edición sin confirmar que empieza en menos de 120 días, una búsqueda de seguimiento abierta (solo con la lista de bloqueo) pide solo esos datos, con prensa nacional o regional y dos medios para las fechas. Sus propuestas pasan la misma validación contra sus propias citas y nunca reemplazan lo que dio la primera pasada. Solo en la corrida semanal, con tope `MAX_FOLLOWUPS_PER_RUN` (por defecto 6) y nunca desde el 80% del presupuesto.
2. **Extracción.** Segunda llamada sin herramientas, con salidas estructuradas (`output_config.format`, `type: "json_schema"`), que convierte el texto y las citas de la llamada 1 en un objeto `Proposal`. Separarlas mantiene las citas de la búsqueda y un JSON garantizado por esquema.

**Construir un país (onboarding):** si el país no tiene `config/sources/<cc>.json`, una llamada sin búsqueda redacta su política de fuentes (dominios oficiales, prensa nacional y bloqueados; el código siempre suma los dominios de gobierno y la UNESCO, y sin respuesta usa solo esos). Luego una llamada de investigación pide las 10 fiestas con más convocatoria del país, con asistencia, declaratorias, regla de fecha y fuentes; el script calcula el puntaje y crea `data/countries/<cc>.json` en estado «borrador». Después verifica hasta 5 fiestas sin fecha con fuente, de la más cercana a la más lejana, y el país se publica solo cuando tiene al menos 3 fiestas con fecha y fuente A o B. Si no llega, lo reintenta a los 30 días, hasta 3 veces.

**Validación en código antes de aplicar (zod):**

- El JSON cumple el esquema; si falla, un reintento y luego se descarta con registro.
- Cada campo cambiado trae al menos una URL https que aparece en las citas `web_search_result_location` de la llamada 1.
- `start` no es posterior a `end`, y la fecha cae dentro de la ventana de la regla con 30 días de margen; si no, el cambio va marcado «revisar».
- «Oficial» exige un dominio de `config/official-domains/<cc>.json`; si solo hay prensa, la confianza máxima es «prensa».
- La ciudad debe pertenecer al país de la fiesta.
- Nunca se borra una fiesta ni se pasa una fecha confirmada a tentativa sin fuente que lo diga.

**Controles del registro de riesgos que amplían esta validación:** cita literal exacta y segunda fuente para fechas de Nivel 1 (R1), parser de fechas por idioma (R3), primera búsqueda restringida a fuentes A y detector de instrucciones (R7), barrido de noticias (R9), degradación por presupuesto (R10) y copia archivada de cada fuente (R13). Donde este apartado y el registro difieran, manda el registro.

**El commit (desde el 2026-11-09):** un commit por corrida directo a `main`, después de que `build-data` valida todos los archivos, con `data/countries/`, `data/changelog.json`, `data/index.json`, `data/state/` y la configuración de fuentes de los países nuevos. El mensaje lista cada cambio con su fuente y el gasto del mes; `git revert` lo deshace. Sin cambios no hay commit. Lo retenido no se aplica: queda en `data/state/holds.json` y en el issue «Needs a look», y se aplica solo cuando una verificación posterior trae la segunda fuente.

**Costo y límites:** la búsqueda web cuesta US$10 por cada 1.000 búsquedas más los tokens. Con 40 fiestas, 5 búsquedas y 4 corridas al mes son 800 búsquedas, unos US$8 en búsquedas más tokens; cada onboarding de país suma entre 10 y 20 búsquedas \[estimación\]. El script corta al llegar a `MONTHLY_BUDGET_USD`, que lleva la cuenta en `data/state/ledger.jsonl` (una línea por llamada, con su tarea). Para corridas grandes conviene evaluar la Message Batches API, que admite la búsqueda web al mismo precio por búsqueda. La búsqueda web debe estar habilitada para la organización en la Claude Console.

## Seguridad de la API key y del pipeline

La API key nunca toca el navegador: una key en el HTML o en `localStorage` la puede copiar cualquiera que abra la página, así que vive solo en los secretos del repositorio. Los datos del usuario, como su ubicación o sus guardadas, nunca salen de su dispositivo.

- **Dónde vive la key:** secreto `ANTHROPIC_API_KEY` de GitHub Actions. `.env` en `.gitignore` para pruebas locales; `.env.example` sin valores.
- **Chequeo en CI:** el build falla si encuentra el prefijo `sk-ant-` en archivos versionados o en `dist/`. Activar secret scanning y push protection de GitHub.
- **Key dedicada:** una key solo para este proyecto, rotada cada 90 días o apenas se sospeche exposición; procedimiento en el README.
- **Permisos mínimos:** los jobs de verificación y onboarding solo tienen `contents: write` y `pull-requests: write`; el deploy es otro job, solo desde `main`.
- **Inyección de instrucciones:** el contenido web es dato, no instrucción. El script solo acepta campos del esquema, no ejecuta nada de lo que devuelve la IA, y la UI pinta todo con `textContent`, nunca con `innerHTML`.
- **Privacidad:** «Cerca de mí» pide permiso y calcula en el dispositivo; guardadas, idioma y país de origen viven en `localStorage`; sin cuentas ni datos personales en el servidor; analítica opcional y sin cookies.
- **Advertencias de viaje:** la ficha enlaza la página oficial de advertencias del país de origen que el usuario elige en Ajustes; la app no emite juicios propios de seguridad.
- **Enlaces externos:** solo `https`, con `rel="noopener noreferrer"`.
- **CSP del sitio:** `default-src 'self'`; el sitio no llama a la API, así que no necesita `connect-src` externo.
- **Contenido de terceros:** se guardan hechos (fechas, cifras) y una frase propia, con enlace a la fuente; nunca párrafos copiados.
- **v2, botón «actualizar ahora»:** solo mediante una función serverless con token de administrador y límite de llamadas; la key sigue fuera del cliente.

## Experiencia de usuario y requisitos no funcionales

La experiencia se acepta con datos, no con opiniones: 5 usuarios completan 5 tareas con 90% de éxito, Core Web Vitals en «bueno» a percentil 75 en móvil y cero fallas de WCAG 2.2 AA.

**Principios y cómo se comprueban:**

| Principio | Cómo se aplica | Criterio de aceptación |
| --- | --- | --- |
| La respuesta primero | Inicio abre en «Lo próximo» del ámbito elegido; sin pantallas de bienvenida | La próxima fiesta y su cuenta regresiva se ven sin scroll a 390 px |
| Reconocer antes que recordar | Países recientes arriba, chips de meses, búsqueda tolerante a tildes y a otros idiomas | «brazil» encuentra Brasil al primer intento |
| Filtros visibles y reversibles | Chips con conteo, «Limpiar filtros» siempre visible, estado en la URL | El botón atrás del navegador restaura los filtros |
| Estado del sistema a la vista | «Verificado hace 3 días», esqueletos de carga, aviso sin conexión | Ninguna pantalla queda en blanco más de 1 s |
| Prevenir errores costosos | Lo no confirmado lleva trama, texto y «\[Por confirmar\]» también en el .ics | Ningún evento tentativo se exporta sin esa marca |
| Confianza verificable | Fuente y fecha de verificación a un toque de cada dato; registro de cambios | Toda fecha abre su fuente en 1 toque |
| Vacíos que orientan | Sin resultados, sugerir meses vecinos, Nivel 2 o países cercanos | Ningún estado vacío queda sin una acción |
| Pulgar primero | En móvil, navegación inferior con Inicio, Explorar, Guardadas y Ajustes; acciones principales abajo | Objetivos táctiles de 44 × 44 px |
| El calendario donde ya vive el usuario | Suscripción por país y .ics con enlaces a Google, Apple y Outlook | Agregar una fiesta toma 2 toques o menos |
| Movimiento con propósito | Solo como respuesta a una acción del usuario; respeta `prefers-reduced-motion` | Sin animaciones automáticas al cargar |

**Requisitos no funcionales:**

| Área | Requisito |
| --- | --- |
| Rendimiento | Core Web Vitals «buenos» a percentil 75 en móvil: LCP de 2,5 s o menos, INP de 200 ms o menos, CLS de 0,1 o menos. Cada país en su propio JSON, así solo se carga lo elegido |
| Accesibilidad | WCAG 2.2 AA; objetivos de 44 × 44 px, por encima del mínimo AA de 24 × 24; foco visible; el color nunca es la única señal; la línea de tiempo tiene una lista equivalente |
| Internacionalización | Español, inglés y portugués; fechas y números con `Intl`; nombre original con traducción; propiedades CSS lógicas para sumar idiomas de derecha a izquierda más adelante |
| Dispositivos | Diseño base a 390 px; en escritorio, columna de hasta 760 px y navegación arriba |
| Tema | Claro y oscuro según el sistema, con colores como tokens CSS |
| Sin conexión | Service worker con el último JSON de cada país visitado |

**Lenguaje visual:**

- El color codifica el tipo de fiesta: carnaval, música, tradición religiosa, cosecha o temporada y fiesta nacional; máximo 5 tonos.
- Lo no confirmado lleva trama diagonal. La confianza se lee por forma: punto lleno oficial, anillo prensa, anillo discontinuo patrón, anillo punteado estimación.
- Una familia muy legible para datos y otra de display para títulos, con escala tipográfica fija.

**Pantallas:**

1. **Inicio:** selector de ámbito (mundo, región o país), «Lo próximo» y línea de tiempo de 12 meses.
2. **Explorar:** lista por mes con filtros en chips; mapa en v2.
3. **Ficha:** todo lo de RF-06, con «Guardar» y «Agregar al calendario» fijos abajo.
4. **Guardadas:** lista por fecha y exportación .ics.
5. **Ajustes:** idioma, país de origen para las advertencias de viaje y primer día de la semana.
6. **Sobre los datos:** cómo se calcula el puntaje, frescura por país y registro de cambios.

&#91;embedded content: boceto móvil de Inicio y Ficha\]

En Inicio, la próxima fiesta y su cuenta regresiva quedan arriba sin scroll; en la Ficha, «Agregar al calendario» queda fija abajo, en la zona del pulgar.

**Prueba de usabilidad antes del lanzamiento (5 usuarios, en teléfono):**

| Tarea | Éxito |
| --- | --- |
| ¿Cuál es la próxima fiesta grande en Brasil? | Respuesta correcta en menos de 10 s |
| ¿Qué fiestas hay en México del 1 al 15 de noviembre? | Usa «Mis fechas de viaje» sin ayuda |
| Agrega el Carnaval de Barranquilla a tu calendario | Evento creado con la fecha correcta |
| ¿La fecha del Inti Raymi está confirmada y de dónde sale? | Encuentra el estado y la fuente |
| Cambia el idioma a inglés y guarda dos fiestas | Ambas aparecen en Guardadas |

Meta: 90% de tareas completadas y facilidad media de 5,5 o más en la pregunta única de 1 a 7 después de cada tarea. Cada falla se corrige y se vuelve a probar.

**Decisiones de UX posteriores (auditoría, nov 2026):**

- **Filtros híbridos (RF-03):** en el teléfono, «Mis fechas de viaje», el conteo, «Filtros (n)» y «Limpiar filtros» quedan a la vista, y cada filtro activo es un chip que se quita con un toque; país, mes, tipo, Nivel 2 y orden se eligen en una hoja con conteos en vivo y se aplican con «Ver N fiestas», una sola entrada del historial. Desde 48rem los chips siguen en línea y se aplican al instante. Así la lista empieza sobre el pliegue a 390 px.
- **Una marca de confianza en las listas (RF-07, RF-08):** filas y portada muestran «■ Confirmada, fuente oficial» en lugar de dos insignias; la ficha conserva ambas. Ninguna fecha pierde su etiqueta. Vocabulario llano: «Por confirmar», «Años anteriores», «Estimada», «medianas (Nivel 2)»; la leyenda «Cómo leer las marcas» está a un toque de las listas.
- **Sin navegación inferior en la ficha («Pulgar primero»):** la ficha tiene «Volver» arriba a la izquierda y la barra «Guardar» / «Agregar al calendario» ocupa la zona del pulgar; las barras fijas suman 15 % o menos de la pantalla.
- **Cuenta regresiva honesta:** una fecha no confirmada dice «en unos N días».
- **Países a la vista:** la vista del mundo y la de región, en Inicio y en Explorar, dicen qué países están publicados (por nombre hasta 8, luego cuántos) y que cualquier otro se puede construir. Un país sin datos ofrece «Construir <país>»; uno pedido dice en qué va su construcción.

## Modelo de datos

Cada país vive en su propio archivo `data/countries/<cc>.json`, y `data/index.json` lista los países publicados, su fecha de verificación y las fiestas de Nivel 1 que alimentan la vista global.

**Valores permitidos:**

- `country`: código ISO 3166-1 alfa-2 (`CO`, `PE`, `BR`); `subdivision`: ISO 3166-2 (`CO-ATL`)
- `timezone`: zona IANA (`America/Bogota`)
- `type`: `carnaval`, `musica`, `tradicion_religiosa`, `cosecha_temporada`, `fiesta_nacional`
- `status`: `confirmada`, `tentativa`, `por_anunciar`, `aplazada`, `cancelada`
- `confidence`: `oficial`, `prensa`, `patron`, `estimacion`
- `rule.type`: `fixed`, `easter_offset`, `nth_weekday`, `relative_to`, `lunisolar_table`, `announced`, con `parity` opcional

**Archivo de un país (ejemplo real, recortado):**

```json
{
  "country": "CO",
  "status": "publicado",
  "generated_at": "2026-10-26",
  "festivals": [
    {
      "slug": "carnaval-barranquilla",
      "names": {
        "local": "Carnaval de Barranquilla",
        "es": "Carnaval de Barranquilla",
        "en": "Barranquilla Carnival",
        "pt": "Carnaval de Barranquilla"
      },
      "city": "Barranquilla",
      "subdivision": "CO-ATL",
      "timezone": "America/Bogota",
      "nearest_airport": "BAQ",
      "type": "carnaval",
      "rule": { "type": "easter_offset", "calendar": "gregorian", "start": -50, "end": -47 },
      "editions": {
        "2027": {
          "start": "2027-02-06",
          "end": "2027-02-09",
          "status": "confirmada",
          "confidence": "oficial",
          "key_events": [
            { "name": "Lectura del Bando", "date": "2027-01-16", "confidence": "oficial" },
            { "name": "Guacherna", "date": "2027-01-29", "confidence": "oficial" },
            { "name": "Batalla de Flores", "date": "2027-02-06", "confidence": "oficial" }
          ],
          "sources": [
            {
              "url": "https://carnavaldebarranquilla.org/carnaval-de-barranquilla-2027/",
              "publisher": "Carnaval de Barranquilla S.A.S.",
              "accessed": "2026-10-26"
            }
          ],
          "last_verified": "2026-10-26"
        }
      },
      "score": {
        "convocatoria": { "points": 35, "value": "más de 6 millones de asistentes (2026)" },
        "calle": { "points": 25, "value": "380 de más de 500 eventos gratuitos (2026)" },
        "reconocimiento": { "points": 20, "value": "UNESCO" },
        "conectividad": { "points": 10 },
        "local": { "points": 3 }
      },
      "street_tip": { "es": "Carnaval de la 44 y verbenas de barrio" },
      "tier": 1
    }
  ]
}
```

**Índice global:**

```json
{
  "generated_at": "2026-10-26",
  "countries": [
    { "code": "CO", "status": "publicado", "festivals": 10, "last_verified": "2026-10-26" }
  ],
  "tier1": ["CO/carnaval-barranquilla", "CO/negros-y-blancos"]
}
```

**Propuesta de la IA (lo que produce la llamada de extracción):**

```json
{
  "country": "CO",
  "slug": "carnaval-barranquilla",
  "edition": 2027,
  "changes": [
    {
      "field": "key_events.martes_de_carnaval",
      "old": null,
      "new": "2027-02-09",
      "source_urls": ["https://carnavaldebarranquilla.org/carnaval-de-barranquilla-2027/"],
      "confidence": "oficial",
      "note": "La web oficial lo marca como a confirmar"
    }
  ],
  "not_found": ["score.convocatoria"]
}
```

El esquema zod en `src/schema.ts` es la fuente de verdad: se exporta a JSON Schema para la llamada de extracción, así el contrato con la IA y la validación nunca se separan.

## Plan de entrega para Claude Code

Ocho hitos en orden; Claude Code no empieza uno hasta que el anterior tiene sus pruebas en verde.

**Stack:** Vite con TypeScript sin framework de UI, Vitest, Playwright con axe para pruebas de extremo a extremo y de accesibilidad, Lighthouse CI, zod, `@anthropic-ai/sdk`, Node LTS, GitHub Actions y GitHub Pages.

**Estructura del repositorio:**

```text
/
├── PRD.md
├── CLAUDE.md
├── index.html
├── src/        app.ts, router.ts, dates.ts, score.ts, ics.ts, i18n.ts, schema.ts, render/, styles/
├── locales/    es.json, en.json, pt.json
├── data/       index.json, countries/<cc>.json, changelog.json, usage.json
├── public/calendars/   <cc>.ics generados en el build
├── config/     scoring.json, official-domains/<cc>.json
├── scripts/    refresh.ts, onboard.ts, build-calendars.ts, prompts/
├── tests/      unitarias, e2e con Playwright y axe, refresh y onboarding con respuestas grabadas
└── .github/workflows/   ci.yml, refresh.yml, onboard.yml, deploy.yml
```

**Reglas para `CLAUDE.md`:**

- La API key nunca va en archivos del cliente ni en el repositorio.
- Toda fecha o cifra nueva lleva fuente; sin fuente, «por anunciar» o «por medir».
- Fechas siempre como día local con su zona IANA; nunca `new Date("AAAA-MM-DD")` sin zona, porque se interpreta en UTC y corre el día en América.
- Ningún texto visible fuera de `locales/`.
- Pruebas primero para `dates.ts` y `score.ts`; cada pantalla nueva con su prueba e2e y axe.
- Datos externos solo con `textContent`, nunca `innerHTML`.

**Hitos:**

1. **H0 Andamiaje.** Repo, Vite, Vitest, Playwright, axe, Lighthouse CI y el chequeo de `sk-ant-` en CI. Hecho cuando `npm test` y `npm run build` pasan en CI.
2. **H1 Datos y fechas.** Esquema global, motor de reglas con todos los tipos, puntaje, ranking por país y `data/countries/co.json` con las 10 fiestas del piloto. Hecho cuando pasan todos los casos de «Reglas de fechas» y los puntajes reproducen la tabla.
3. **H2 Interfaz núcleo.** Inicio, Explorar y Ficha: RF-01 a RF-08, RF-12 y RF-13. Hecho con las tareas 1, 3 y 4 de la prueba de usabilidad automatizadas en e2e, axe sin fallas y Lighthouse móvil de 90 o más en rendimiento y accesibilidad.
4. **H3 Guardadas, calendario e idiomas.** RF-09 a RF-11 y RF-14, con suscripción webcal por país. Hecho cuando el .ics se importa en Google Calendar, Apple Calendar y Outlook, y el idioma cambia sin recargar.
5. **H4 Verificación local.** `npm run refresh -- --dry-run` escribe `proposals/AAAA-MM-DD.json` y un resumen Markdown. Hecho cuando un test con respuestas grabadas acepta un cambio con fuente, rechaza uno sin fuente y marca uno fuera de ventana.
6. **H5 Onboarding de países.** `npm run onboard -- --country=PE --dry-run` crea un borrador con puntajes. Hecho cuando, con respuestas grabadas, el borrador marca todo lo no verificado como «por medir».
7. **H6 Workflows y piloto.** `pipeline.yml` (antes `refresh.yml` y `onboard.yml`) y `deploy.yml`. Hecho cuando una corrida real sube un commit legible que despliega tras CI, y cada país pedido se publica con al menos 3 fiestas con fuente (Brasil, Colombia y Perú ya lo están; Bolivia y México en cola).
8. **H7 Usabilidad y endurecimiento.** Prueba con 5 usuarios y sus correcciones; tope de presupuesto, CSP y rotación de la key documentada. Hecho con 90% de tareas completadas, facilidad media de 5,5 o más y una simulación del tope que detiene el job.

**Controles de riesgo por hito:** cada control del registro se construye en el hito indicado en su fila (H0: R8; H1: R4; H3: R5, R6; H4: R1, R3, R7, R13; H5: R2, R11; H6: R9, R10, R12; H7: conjunto de prueba de R1). Un hito no se cierra si la prueba de alguno de sus controles falla.

**Primer mensaje sugerido a Claude Code:** «Lee PRD.md completo. Crea CLAUDE.md con las reglas de la sección Plan de entrega y ejecuta H0. Detente al terminar H0 y muéstrame el resultado de las pruebas.»

## Métricas de éxito

El producto funciona si las fechas prioritarias son exactas y frescas en cada país publicado, y si cualquier viajero encuentra lo que busca sin ayuda.

| Métrica | Meta | Cómo se mide |
| --- | --- | --- |
| Exactitud de fechas de Nivel 1 | 100% | Auditoría después de cada edición contra la fuente oficial |
| Frescura | Toda fiesta de Nivel 1 a menos de 120 días verificada en los últimos 14 días | Campo `last_verified` |
| Cobertura | Cada país pedido, publicado con al menos 3 fiestas verificadas; de 3 a 5 países nuevos por mes con US$20 | `data/index.json` y `data/state/requests.json` |
| Cambios sin fuente publicados | 0 | Validador y auditoría mensual de 10 cambios |
| Cambios retenidos sin resolver más de 30 días | 10 o menos | `data/state/holds.json` |
| Costo mensual de la API | Por debajo de `MONTHLY_BUDGET_USD`, sugerido US$20 | `data/state/ledger.jsonl` |
| Éxito en tareas | 90% en la prueba con 5 usuarios | Prueba de usabilidad |
| Facilidad percibida | 5,5 o más de 7 | Pregunta única después de cada tarea |
| Core Web Vitals en móvil | LCP de 2,5 s o menos, INP de 200 ms o menos, CLS de 0,1 o menos, a percentil 75 | Lighthouse CI en el build y la librería web-vitals en producción |
| Accesibilidad | Cero fallas de WCAG 2.2 AA | axe en CI |
| Indicadores de riesgo | Ninguno en alerta más de 14 días seguidos | Revisión mensual del registro de riesgos |

## Riesgos y mitigaciones

Con controles verificables, los 13 riesgos terminan en zona baja: los 3 que empiezan altos (fecha inventada, revisión humana de sello y calendarios lunares) bajan de 15 a 20 puntos a 6 o menos. El más difícil de bajar es la revisión humana, porque casi todos los demás controles dependen de ella.

**Cómo se lee el registro:**

- **Puntaje** = probabilidad (1 raro a 5 casi seguro) × impacto (1 menor a 5 grave, como un vuelo comprado para una fecha equivocada o una key filtrada). Alto = 15 o más; medio = 8 a 14; bajo = 7 o menos.
- **Tres capas por riesgo:** prevenir, detectar y corregir. Un control sin prueba en CI no cuenta.
- **Indicador con umbral:** si un indicador pasa dos semanas en alerta, el riesgo se reabre.
- **Marco:** las funciones Gobernar, Mapear, Medir y Gestionar del NIST AI RMF 1.0; los riesgos de IA se cruzan con el OWASP Top 10 para aplicaciones LLM 2025 (LLM01 inyección, LLM05 manejo de la salida, LLM09 desinformación, LLM10 consumo sin límite, entre otros).
- **Dueño:** el responsable del producto; el registro se revisa una vez al mes.

&#91;embedded content: registro de riesgos de este PRD, 13 riesgos puntuados el 26 oct 2026\]

R1 se queda en 6 por los controles en código y la auditoría mensual. R12 se retiró el 2026-11-09 junto con la revisión humana que medía: sin revisor no hay sello que vigilar, y su lugar lo toman las retenciones de `scripts/lib/autoapprove.ts`.

**Registro de riesgos (ordenado por puntaje inherente):**

| Riesgo | Inherente | Prevenir | Detectar | Corregir | Indicador y umbral | Residual e hito |
| --- | --- | --- | --- | --- | --- | --- |
| **R1** La IA confunde ediciones o ciudades, o inventa una fecha (LLM09) | 4 × 5 = 20 | Cita literal obligatoria que debe aparecer tal cual en las citas de la búsqueda; dos fuentes independientes para fechas de Nivel 1 que no vengan del organizador; una fecha fuera de la ventana de la regla se bloquea; ciudad validada contra GeoNames | Conjunto de prueba de 50 fiestas con fecha conocida que corre en cada cambio de prompt o de modelo y exige 98% de aciertos; el PR resalta las fechas de Nivel 1 | «Reportar un error» en cada ficha; revert del PR; los calendarios suscritos reciben la corrección | Propuestas de fecha rechazadas en revisión: alerta sobre 10% al mes | 2 × 3 = 6; H4 y H7 |
| **R12** (retirado el 2026-11-09: ya no hay revisión humana de cada cambio; ver «Decisión del 2026-11-09») Revisión humana de sello, que aprueba sin mirar | 4 × 4 = 16 | PRs de 15 cambios como máximo, ordenados por riesgo; por cada fecha de Nivel 1 el revisor pega el fragmento que vio en la fuente | Una propuesta trampa al mes con un error sembrado, que el revisor debe rechazar; CI la bloquea aunque se apruebe, así nunca llega al sitio; auditoría mensual de 10 cambios aprobados al azar | Si se aprueba una trampa o la auditoría halla un error, segundo revisor obligatorio durante un mes | Trampas rechazadas: meta 100% | 2 × 3 = 6; H6 |
| **R4** Calendarios lunares mal calculados | 3 × 5 = 15 | Solo tablas de fuente oficial, como la conversión gregoriano-lunar del Observatorio de Hong Kong (1901 a 2100, también en CSV); nunca cálculo astronómico propio | Cruce con la lista oficial de feriados del país cuando la fiesta es feriado; alerta si falta la fila de los próximos 12 meses | Fechas que dependen del avistamiento de la luna, o de una luna nueva cerca de medianoche, se muestran como «estimada, puede variar un día» hasta el anuncio oficial | Fiestas lunares sin fila para los próximos 12 meses: alerta con 1 o más | 1 × 3 = 3; H1 |
| **R2** Calidad de fuentes muy desigual entre países | 4 × 3 = 12 | Jerarquía en `config/sources/<cc>.json`: A organizador o gobierno, B prensa nacional reconocida, C resto; Nivel 1 exige una A o dos B; dominios bloqueados (reventa, granjas de SEO) | Tablero de cobertura con el porcentaje de fechas con fuente A por país | Un país sin 3 fiestas con fuente A o B queda en borrador; bajo 60% de fuentes A, aviso «cobertura parcial» | Fechas con fuente A por país: alerta bajo 60% | 2 × 2 = 4; H5 |
| **R3** Fuentes en idiomas que el revisor no lee | 3 × 4 = 12 | El PR muestra cita original, traducción, idioma y la fecha ya normalizada; un parser de fechas por idioma compara la cita con lo que extrajo la IA | Si parser e IA no coinciden, el cambio se marca «revisar idioma» | Desde el 2026-11-09 el parser lee cualquier idioma con meses en CLDR, además de fechas 年月日 y años budistas; un cambio que no coincide queda retenido | Cambios marcados «revisar idioma»: alerta sobre 20% | 2 × 2 = 4; H4 |
| **R6** La seguridad del viajero cambia según país y nacionalidad | 3 × 4 = 12 | Ajustes pide el país de origen y la ficha enlaza su advertencia oficial, como travel.state.gov, gov.uk/foreign-travel-advice, travel.gc.ca o smartraveller.gov.au; si ese país no publica una, se enlaza su cancillería | Chequeo semanal de enlaces rotos | Aviso con fecha en la ficha cuando la fuente elegida cambie de nivel, si lo publica en formato legible por máquina; nunca se ocultan fiestas | Enlaces de advertencia rotos: alerta con 1 o más | 2 × 2 = 4; H3 |
| **R7** Una página web intenta dar instrucciones a la IA (LLM01, LLM05, LLM06) | 4 × 3 = 12 | La IA no tiene herramientas con efectos: solo búsqueda web, sin acceso al repo ni a secretos; primera búsqueda con `allowed_domains` limitado a fuentes A y abierta solo si no hay resultado o, con tope por corrida, si no dio las fechas de una edición sin confirmar; la extracción solo ve las citas; salida por esquema | Detector de frases de instrucción en las citas («ignora», «ignore previous», «system prompt»); rechazo de campos no pedidos | Revisión humana y revert | Cambios marcados por el detector: alerta con 1 o más | 2 × 2 = 4; H4 |
| **R9** Un hecho extraordinario suspende una fiesta, como el sismo que suspendió el Petronio en ago 2026 | 3 × 4 = 12 | No se puede prevenir | Barrido de noticias dos veces por semana para fiestas a 45 días o menos y diario en su última semana, con «cancelado», «aplazado» o «suspendido» en el idioma local | Estado «aplazada» o «cancelada» con fuente; el .ics publica `STATUS:CANCELLED` y sube `SEQUENCE`; aviso en la ficha | Horas entre el anuncio oficial y el cambio publicado: meta 72 o menos | 2 × 3 = 6; H6 |
| **R11** Sesgo hacia lo que tiene más cobertura en medios | 4 × 3 = 12 | Candidatas primero de fuentes no mediáticas: lista de Patrimonio Inmaterial de la UNESCO, calendario oficial de cultura o turismo y feriados del país | Alerta si las 5 mejores de un país están en la misma ciudad | «Sugerir una fiesta» en la app; peso «Gente local» ajustable; revisión trimestral del ranking | Candidatas de fuentes no mediáticas por onboarding: alerta bajo 50% | 2 × 2 = 4; H5 |
| **R8** Se filtra la API key (LLM02, LLM03) | 2 × 5 = 10 | Key en un workspace dedicado de la Claude Console con límite de gasto mensual y de tasa (el workspace Default no los admite); secreto de GitHub Actions; acciones de terceros fijadas por SHA; Dependabot | Secret scanning y push protection de GitHub, que reconocen las keys de Anthropic; aviso de gasto en la Console | Runbook de rotación en 15 minutos: revocar, crear, actualizar el secreto y reejecutar | Gasto diario sobre 3 veces el promedio de 7 días: alerta | 1 × 3 = 3; H0 |
| **R5** Fiestas religiosas o identitarias presentadas como simple parranda | 3 × 3 = 9 | Guía de estilo por tipo en `locales/`; campo `etiquette` con normas de respeto (vestimenta, fotos, momentos no abiertos a visitantes); texto propio aprobado por una persona | Términos sensibles por tipo que fuerzan revisión; reportes de usuarios | «Reportar contenido» y corrección en 48 h | Reportes sin atender por más de 48 h: alerta con 1 o más | 1 × 2 = 2; H3 |
| **R10** El costo sube con cada país nuevo (LLM10) | 3 × 3 = 9 | Límite de gasto del workspace; `max_uses`; cadencia de la cola (confirmadas solo al vencer su verificación, lejanas sin confirmar una vez al mes) y tope de búsquedas de seguimiento por corrida; caché del prompt de sistema; onboarding por Message Batches. El filtrado dinámico de la búsqueda queda apagado porque borra las citas (corrida del 2026-11-08) | `usage.json` por corrida; avisos al 50% y al 80% del tope | Al 80% solo se verifican fiestas de Nivel 1 a 60 días o menos; al 100% el job se detiene | Gasto del mes: alerta al 80% | 1 × 2 = 2; H6 |
| **R13** Las fuentes desaparecen o cambian (nuevo) | 4 × 2 = 8 | Cada fuente citada se archiva al verificarla con Save Page Now del Internet Archive y se guarda `archive_url` | Chequeo semanal de enlaces | Sin original ni copia archivada, la confianza baja un nivel | Fuentes de Nivel 1 sin copia archivada: alerta con 1 o más | 1 × 2 = 2; H4 |

**Reglas del registro:**

- Cada control se construye en el hito de su fila y su prueba entra a CI; un hito no se cierra si alguna falla.
- Archivar con la API autenticada del Internet Archive requiere claves de archive.org guardadas como secreto, y la API limita las capturas diarias por URL.
- Cada aplicación de calendario actualiza las suscripciones con su propia frecuencia, así que una cancelación puede tardar en verse allí; la ficha siempre muestra el dato vigente.

## Supuestos y preguntas abiertas

Seis supuestos sostienen el diseño; si uno no se cumple, cambia el plan de entrega.

**Supuestos:**

- &#91;supuesto: piloto con Colombia, Perú, Brasil, Bolivia y México\]
- &#91;supuesto: interfaz en español, inglés y portugués al lanzar\]
- &#91;supuesto: el código vive en GitHub y el sitio en GitHub Pages\]
- &#91;supuesto: una persona revisa los PRs una vez por semana\]
- &#91;supuesto: la cuenta de la API tiene la búsqueda web habilitada\]
- &#91;supuesto: `claude-sonnet-5-5` como modelo por defecto, configurable\]

**Preguntas abiertas:**

- [ ] ¿Qué 4 países acompañan a Colombia en el piloto?
- [ ] ¿Quién aprueba los PRs y qué día de la semana?
- [ ] ¿Inicio abre en la vista global o en el país de origen del usuario?
- [ ] ¿Se integran después el presupuesto y la checklist de la herramienta de decisión?
- [ ] ¿Hace falta aviso por correo o push cuando una fecha pasa a confirmada?
- [ ] ¿Hosting propio en lugar de GitHub Pages?
- [ ] ¿El mapa entra en v2 o antes?

## Fuentes

**API de Claude:**

- [Herramienta de búsqueda web: versiones, parámetros, precio y `pause_turn`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Salidas estructuradas con `output_config.format`](https://platform.claude.com/docs/build-with-claude/structured-outputs)

**Fechas y eventos:**

- [Carnaval de Barranquilla 2027, calendario oficial](https://carnavaldebarranquilla.org/carnaval-de-barranquilla-2027/)
- [Fechas del Carnaval de Barranquilla 2028 y regla de la Guacherna (Wikipedia)](https://es.wikipedia.org/wiki/Carnaval_de_Barranquilla)
- [Carnaval de Riosucio 2027 (La Patria)](https://www.lapatria.com/caldas/el-carnaval-de-riosucio-vuelve-sacar-los-cachos-fecha-y-hora-de-instalacion-de-la-republica)
- [Carnaval de Riosucio 2025 (La Patria)](https://www.lapatria.com/entretenimiento/riosucio-caldas-cuenta-los-dias-para-su-carnaval-2025)
- [Carnaval de Riosucio 2023 (Viaja por Colombia)](https://viajaporcolombia.com/noticias/carnaval-del-diablo-2023-en-riosucio-caldas_9543/)
- [Programa de Negros y Blancos 2026 (Canal Trece)](https://canaltrece.com.co/noticias/carnaval-de-negros-y-blancos-2026-en-pasto-tradicion-que-une-generaciones/)
- [Feria de Cali 2026 confirmada tras el sismo (La FM)](https://www.lafm.com.co/actualidad/feria-de-cali-si-se-realizara-pese-al-terremoto-alcalde-alejandro-eder-confirmo-el-evento-408792)
- [Petronio Álvarez reprogramado (Radio Nacional)](https://www.radionacional.co/cultura/el-sector-cultural-renace-festivales-aplazados-por-el-terremoto-cuentan-con-nuevas-fechas)
- [Festival de Tambores de Palenque 2026 (Radio Nacional)](https://radionacional.co/noticias-colombia/festivales-en-octubre-ferias-y-eventos-culturales-en-colombia)

**Convocatoria:**

- [Barranquilla 2026: más de 6 millones de asistentes (El Tiempo)](https://www.eltiempo.com/colombia/barranquilla/carnaval-de-barranquilla-2026-rompio-records-6-millones-de-asistentes-y-840-000-millones-movidos-en-los-cuatro-dias-de-fiesta-3533428)
- [Barranquilla 2026: ocupación y eventos gratuitos (Valora Analitik)](https://www.valoraanalitik.com/?p=555318)
- [Pasto 2026: cerca de 250 mil turistas (Diario del Sur)](https://www.diariodelsur.com.co/?p=468063)
- [Festival Vallenato edición 55: 137.672 turistas (Pulzo)](https://www.pulzo.com/nacion/cuantos-turistas-asistieron-festival-vallenato-55-PP1396134A)
- [Feria de Cali: más de 700 mil personas, fuente comercial (Faranda Hotels)](https://www.farandahotels.com/en/blog/descubre-la-feria-de-cali-2026-fechas-alojamiento)
- [Riosucio 2023: visitantes esperados (Gobernación de Caldas)](https://caldas.gov.co/noticias-gobernacion/14305-desde-el-13-de-julio-se-empezara-a-vivir-el-carnaval-de-riosucio-gobernacion-de-caldas-se-vinculara-con-actividades-y-recursos)

**Estándares de UX y rendimiento:**

- [WCAG 2.2, criterio 2.5.8: tamaño mínimo de objetivo de 24 × 24 px (W3C)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [Interaction to Next Paint (web.dev)](https://web.dev/articles/inp)
- [Cumulative Layout Shift (web.dev)](https://web.dev/articles/cls)
- [Umbrales de Core Web Vitals a percentil 75 (resumen con fuentes de web.dev)](https://specification.website/spec/performance/core-web-vitals/)

**Riesgos y controles:**

- [OWASP Top 10 para aplicaciones LLM 2025, resumen con la lista completa (HackerOne)](https://www.hackerone.com/ai/owasp-top-10-llms-2025)
- [NIST AI RMF 1.0: funciones Gobernar, Mapear, Medir y Gestionar (Cloud Security Alliance)](https://cloudsecurityalliance.org/articles/nist-releases-new-framework-for-organizations-associated-with-ai-technologies)
- [Workspaces de la Claude Console: keys por workspace, límites de gasto y de tasa](https://platform.claude.com/docs/en/manage-claude/workspaces)
- [Patrones de secret scanning de GitHub, incluida la API key de Anthropic](https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns?apiVersion=2022-11-28)
- [Tabla de conversión gregoriano-lunar del Observatorio de Hong Kong](https://www.weather.gov.hk/en/gts/time/conversion.htm)
- [GeoNames: archivos por país y licencia CC BY 4.0](https://android.googlesource.com/platform/external/geonames/+/7a853d30915d91f323de5649b130afbd00e609de/export/dump/readme.txt)
- [Valores de STATUS de un VEVENT en RFC 5545 (borrador IETF que los cita)](https://www.ietf.org/id/draft-ietf-calext-subscription-upgrade-09.html)
- [Save Page Now del Internet Archive y sus límites](https://wiki.archiveteam.org/index.php/SPN)

**Producto de referencia:** [herramienta de decisión publicada](https://claude.ai/artifact/DHppMLnw4ZnwrAPNCu1CNu)
