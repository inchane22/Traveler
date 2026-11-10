# Traveler

Calendario anual de fiestas y carnavales para ir a bailar y celebrar, por país, primero los que tienen más gente y a los que más se viaja desde otras ciudades o países. Las procesiones y otros actos solemnes no entran. Sitio estático (Vite y TypeScript sin framework) publicado en GitHub Pages, en español, inglés y portugués.

Toda América Latina está en el calendario sin que nadie la pida: la lista `coverage` de `config/pipeline.json` (AR, BO, BR, CL, CO, CR, CU, DO, EC, GT, HN, HT, MX, NI, PA, PE, PR, PY, SV, UY, VE) se construye sola, y un país que no llega a publicarse se vuelve a intentar. Cualquier otro país se puede construir a pedido: desde su página, «Construir <país>» abre un issue y el pipeline investiga sus fiestas, verifica cada fecha contra fuentes oficiales o la prensa nacional y lo publica cuando tiene al menos 3 fechas con fuente. Cada día el mismo pipeline revisa las fiestas que tocan según su cercanía y el presupuesto del mes, busca en cada país publicado (cada 60 días) las fiestas que todavía faltan y agrega las que tienen fecha y fuente, aplica los cambios que pasan los controles en código y los sube a `main`; lo dudoso queda retenido. El sitio se publica después de que CI pasa.

- Especificación: [PRD.md](PRD.md)
- Contratos entre módulos: [docs/architecture.md](docs/architecture.md)
- Reglas para agentes: [CLAUDE.md](CLAUDE.md)

## Inicio rápido

Requisitos: Node 22.18 o posterior (corre `.ts` sin compilar) y pnpm 10.

```bash
pnpm install
pnpm dev                               # sitio local, con borradores
pnpm test                              # Vitest: unitarias y pipeline con respuestas grabadas
pnpm exec playwright install chromium  # solo la primera vez
pnpm e2e                               # Playwright + axe contra el build
pnpm typecheck && pnpm build           # lo mismo que exige CI
```

`?today=2026-10-26` en la URL fija «hoy» para probar fechas.

## Pipeline de IA en local

El plan del día, sin ninguna llamada a la API (qué se verificaría, qué países se construirían, cuánto queda del mes):

```bash
pnpm pipeline -- --plan
pnpm pipeline -- --plan --request=JP     # como si alguien pidiera Japón
```

Con respuestas grabadas, sin API key ni gasto:

```bash
pnpm pipeline -- --today=2026-10-26 --fixtures=tests/fixtures/pipeline
pnpm refresh -- --dry-run --today=2026-10-26 --fixtures=tests/fixtures/<carpeta>
pnpm onboard -- --country=PE --dry-run --fixtures=tests/fixtures/<carpeta>
```

Con la API real. La key sale de 1Password y solo existe en el proceso hijo, nunca en un archivo:

```bash
op run --env-file=.env.op -- pnpm pipeline -- --request=JP        # construye Japón y hace el mantenimiento del día
op run --env-file=.env.op -- pnpm refresh -- --dry-run
op run --env-file=.env.op -- pnpm refresh -- --dry-run --only=carnaval-barranquilla
op run --env-file=.env.op -- pnpm onboard -- --country=PE --dry-run
op run --env-file=.env.op -- pnpm refresh -- --classify            # ¿es fiesta?, ¿viene gente de fuera? (las que no tienen clasificación)
op run --env-file=.env.op -- pnpm refresh -- --classify --only=feria-de-cali   # vuelve a preguntar por una ya clasificada
```

`--dry-run` escribe `proposals/AAAA-MM-DD.json` y `proposals/AAAA-MM-DD.md` (ignorados por git) y no toca `data/`. Toda llamada real, en ensayo o no, se anota en `data/state/ledger.jsonl`: gasta igual. Las variables están en [.env.example](.env.example); nunca crees un `.env` o `.env.local` con valores.

Barrido de noticias (R9) y chequeo de enlaces (R6, R13):

```bash
pnpm refresh -- --dry-run --sweep=news --fixtures=tests/fixtures/pipeline              # fiestas a 45 días o menos
pnpm refresh -- --dry-run --sweep=news --within=7 --fixtures=tests/fixtures/pipeline   # última semana
node scripts/check-links.ts                       # proposals/links-AAAA-MM-DD.md y .json; sale 1 solo si hay 404/410
LINKS_REPORT_PATH=proposals/links-2026-10-26.json pnpm refresh -- --dry-run --fixtures=tests/fixtures/pipeline
```

`--sweep=news` solo procesa las fiestas que empiezan dentro de la ventana (las que están en curso también) y busca «cancelado», «aplazado» y «suspendido» en el idioma local más sus equivalentes en inglés (y portugués en los países de habla hispana o portuguesa). `LINKS_REPORT_PATH` apunta al `.json` de `check-links` (máximo 7 días de antigüedad): una edición cuyas fuentes dan todas 404 o 410 y no tienen copia archivada baja su confianza un nivel, una sola vez (R13). Sin esa variable, `refresh` no toca la confianza. Con ella, R13 recorre todos los archivos de país aunque la corrida use `--only` o `--country`.

## Estructura

```text
src/            app y lógica pura (schema, dates, score, festivals, ics), sin DOM ni fs en el núcleo
locales/        todo texto visible (es, en, pt)
data/           countries/<cc>.json, index.json (generado y versionado), changelog.json
data/state/     ledger.jsonl (gasto), requests.json (países pedidos), holds.json (cambios retenidos)
config/         pesos del puntaje, pipeline.json (presupuesto), regions.json, dominios oficiales y fuentes por país
scripts/        pipeline, build-data, build-calendars, refresh, onboard, check-secrets, check-links; lib/ del pipeline
tests/          unit/, e2e/ (Playwright + axe), fixtures/ (respuestas grabadas de la API)
.github/        workflows, formularios de issue, plantilla de PR, Dependabot
```

El detalle de cada módulo y quién lo puede tocar está en [docs/architecture.md](docs/architecture.md).

## Reglas de datos

- Toda fecha o cifra lleva una fuente https. Sin fuente, la fecha es «por anunciar» y la cifra «por medir».
- La IA propone y los controles en código aprueban (desde el 2026-11-09). Se retiene, sin aplicar: lo que validate.ts marca, mover una fecha confirmada o suspender una fiesta sin dos sitios distintos, y una corrida que cambia más de la mitad de las fechas de un país (`scripts/lib/autoapprove.ts`).
- Los borradores no se publican: `build-data` los deja fuera salvo con `INCLUDE_DRAFTS=1`, que solo usa `pnpm dev` (en Windows, sin shell POSIX: `set INCLUDE_DRAFTS=1 && pnpm run data && pnpm exec vite`).
- Un país pasa de `borrador` a `publicado` solo, en la corrida en que tiene al menos 3 fiestas con fecha y fuente A o B (R2) y pasa los controles de `build-data` (`scripts/lib/publish.ts`). No hay otro camino a `publicado`.
- Para deshacer una corrida: `git revert <sha>` del commit `chore(data): pipeline …`; su mensaje lista cada cambio y su fuente.
- Una fecha confirmada no vuelve a tentativa sin una fuente que lo diga, y ninguna fiesta se borra desde el pipeline.
- Una fiesta nueva entra a un país publicado solo por la búsqueda de fiestas nuevas (`selectNew` en `scripts/lib/discover-run.ts`): que no esté ya en el archivo con otro nombre, una fuente citada que diga que allí se va de fiesta, una fecha o regla de fecha citada en una fuente A o B, y los controles de `build-data`. Como mucho 3 por país y corrida; cada una deja una línea «nueva en el calendario» en el registro de cambios con sus fuentes.
- De terceros se guardan hechos y una frase propia con enlace; nunca párrafos copiados.

## Automatización

| Workflow | Cuándo | Permisos | Qué hace |
| --- | --- | --- | --- |
| `ci.yml` | cada PR, cada push a `main` y cuando lo dispara `pipeline.yml` | `contents: read` | typecheck, Vitest con cobertura, build, `check-secrets`, índice sin cambios, Playwright + axe, Lighthouse CI. Check requerido: `ci` |
| `pipeline.yml` | diario 11:00 UTC; un issue `build-country` del dueño (o la etiqueta puesta por el dueño); manual con `country` o `plan_only` | `contents: write`, `issues: write`, `actions: write` | `pnpm pipeline` (el lunes antes `check-links` para R13), valida con `build-data`, sube un commit a `main`, dispara `ci.yml`, responde en los issues de pedidos y actualiza el issue «Needs a look» |
| `links.yml` | domingo 10:00 UTC; manual | `contents: read` | `node scripts/check-links.ts` sobre `config/advisories.json` y las fuentes de `data/`; falla (la alerta de R6) solo con un 404 o 410; el reporte queda en el resumen de la corrida y en el artefacto |
| `deploy.yml` | un `ci.yml` en verde sobre `main` (push o disparado por el pipeline); manual solo desde `main` | build: `contents: read`, `pages: read`; deploy: `pages: write`, `id-token: write` | build con `BASE_PATH=/<repo>/` y publica en Pages |

Todas las acciones de terceros están fijadas por SHA con la versión en un comentario; Dependabot las actualiza los martes. Para fijar una acción nueva, saca el SHA del tag con `gh api repos/<owner>/<acción>/git/ref/tags/<versión> --jq .object.sha` (así se fijó `actions/download-artifact` v8.0.2); nunca lo escribas de memoria. Las corridas de `pipeline.yml` usan el grupo de concurrencia `ai-pipeline`: nunca corren a la vez y una nueva espera, no cancela, a la que ya está gastando. Un issue `build-country` de otra persona no gasta: recibe una respuesta y espera a que el dueño le ponga la etiqueta.

**Qué entra en un commit del pipeline.** `data/countries/*.json`, `data/changelog.json`, `data/index.json` regenerado, `data/state/` (registro de gasto, pedidos y retenidos) y, para un país nuevo, `config/official-domains/<cc>.json` y `config/sources/<cc>.json`. El índice va incluido porque CI lo compara con el que genera `build-data`. Si `build-data` rechaza los datos, se descartan y solo se sube `data/state/ledger.jsonl` (el gasto no se pierde, R10), sin CI ni respuestas en los issues, y la corrida queda en rojo; lo demás está en el artefacto `pipeline-<run>`. El mensaje del commit sale de `proposals/commit-message.txt` y el resumen de la corrida va al resumen del job.

**Presupuesto y `data/state/ledger.jsonl` (decisión).** El tope duro es el límite de gasto del workspace en la Claude Console; `MONTHLY_BUDGET_USD` es el tope del script. Cada llamada a la API agrega una línea al registro con su día, su tarea (`onboard`, `policy`, `build`, `verify`, `followup`, `sweep`), la clave de la fiesta o del país, tokens, búsquedas y US$. El total del mes, lo que cuesta de verdad cada tarea y la última vez que se revisó cada fiesta salen de ahí. El registro viaja en el mismo commit que los datos, así que ya no hace falta el artefacto `usage` ni `usage-fallback.yml`. Reparto (`config/pipeline.json`): 30% del mes para países nuevos (`new_country_share`), el resto para mantener los publicados, repartido entre los días que quedan; en los últimos 7 días ambos comparten lo que queda, el mantenimiento primero. Si un pedido no cabe en lo que queda para países nuevos, espera al mes siguiente y el issue lo dice. Las alertas del 50% y el 80% y el corte al 100% siguen igual.

**CI y deploy después de un commit del pipeline.** El commit lo sube `GITHUB_TOKEN`, que no dispara otros workflows, así que `pipeline.yml` dispara `ci.yml` sobre `main` con `gh workflow run`; `deploy.yml` publica cuando ese CI termina en verde. Si `main` tiene un ruleset que exige PR, agrega GitHub Actions a la lista de bypass de ese ruleset o el push falla.

## Primera configuración en GitHub

1. Crea el repositorio y sube `main` (por ejemplo `gh repo create <owner>/traveler --private --source=. --push`). Pages en un repo privado exige un plan de pago [sin confirmar para tu cuenta].
2. Settings > Pages > Source: **GitHub Actions**. Si usas dominio propio, define las variables `BASE_PATH=/` y `SITE_URL=https://tu-dominio/`; `deploy.yml` falla con un mensaje claro si la ruta no coincide con la que sirve Pages.
3. Settings > Environments > `github-pages`: deployment branches solo `main`.
4. Settings > Actions > General > Workflow permissions: deja **Read repository contents**; `pipeline.yml` pide `contents: write`, `issues: write` y `actions: write` solo para su job.
5. Settings > Rules > Rulesets, opcional, para la rama por defecto (RF-16): bloquear force push y borrado. Si además exiges PR para los cambios de código, agrega GitHub Actions a la lista de bypass: el pipeline sube sus datos directo a `main`. `deploy.yml` solo publica cuando `ci.yml` pasó sobre `main`.
6. Settings > Code security: secret scanning, push protection, Dependabot alerts y security updates. GitHub reconoce las keys de Anthropic (API, admin y service account), bloquea el push y avisa a Anthropic.
7. Settings > General: **Automatically delete head branches** (para los PRs de código).
8. Secretos (Settings > Secrets and variables > Actions). `gh secret set` pide el valor por teclado, así no queda en el historial. Las keys de IA van en el environment `ai-pipeline` (Settings > Environments > ai-pipeline > Deployment branches: solo `main`), así ningún workflow de otra rama las lee (SEC-12):

   ```bash
   gh secret set ANTHROPIC_API_KEY --env ai-pipeline
   gh secret set ARCHIVE_ACCESS_KEY --env ai-pipeline   # opcional, R13 (archive.org)
   gh secret set ARCHIVE_SECRET_KEY --env ai-pipeline   # opcional, R13
   ```

   `TRAP_SECRET`, `TRAP_FINGERPRINTS` y `PR_APP_PRIVATE_KEY` ya no se usan (la trampa R12 se retiró con la revisión humana); si existen, bórralos.

9. Variables:

   ```bash
   gh variable set ANTHROPIC_MODEL --body claude-sonnet-5-5
   gh variable set MONTHLY_BUDGET_USD --body 20
   gh variable set MAX_FESTIVALS_PER_RUN --body 40
   gh variable set MAX_FOLLOWUPS_PER_RUN --body 6    # búsquedas amplias por corrida para fechas que los sitios oficiales no dan
   gh variable set SITE_URL --body https://<owner>.github.io/<repo>/   # opcional: el enlace que el bot deja en el issue de un país publicado
   ```

   Los países se piden con issues `build-country`; `ONBOARD_QUEUE` ya no se usa. El reparto del presupuesto está en `config/pipeline.json`.

10. Etiquetas:

    ```bash
    gh label create build-country  --color 1D76DB --description "Construir un país (pipeline.yml; solo el dueño gasta)"
    gh label create needs-a-look   --color FBCA04 --description "Cambios que el pipeline retuvo"
    gh label create error-de-datos --color D73A4A --description "Dato incorrecto reportado (RF-17, R1)"
    gh label create contenido      --color 5319E7 --description "Contenido o respeto (RF-17, R5)"
    gh label create sugerencia     --color 0E8A16 --description "Fiesta sugerida (R11)"
    ```

11. (Ya no hace falta una GitHub App: el pipeline no abre PRs.)
12. Claude Console: crea el workspace y la key según la política de abajo. La búsqueda web viene activada salvo que un admin la haya apagado en [Settings > Capabilities](https://platform.claude.com/settings/capabilities), donde también se restringen dominios; confírmalo.
13. Primera corrida sin gasto: `gh workflow run pipeline.yml -f plan_only=true` y `gh run watch`; el resumen del job muestra el plan. Después, `gh workflow run pipeline.yml` hace la corrida del día, o abre un issue «Construir un país» para pedir uno.

## API key: política

- Una key solo para este proyecto, en un workspace propio de la Claude Console (por ejemplo `traveler`), con límite de gasto mensual y límites de tasa. El workspace Default no admite límite de gasto ([docs](https://platform.claude.com/docs/en/manage-claude/workspaces)), por eso el workspace aparte. Los límites del workspace pueden ser menores que los de la organización, nunca mayores.
- Límite sugerido: US$25 al mes, algo por encima de `MONTHLY_BUDGET_USD=20` para que el tope del script corte primero, con alertas al 50% y al 80%. Límites de tasa bajos, suficientes para 40 fiestas por corrida.
- Mejor una key de service account limitada a ese workspace que una personal: las keys personales se archivan si su usuario sale de la organización. [sin confirmar: nombres exactos de los menús de la Console para crearla]
- Vive en dos lugares: el secreto `ANTHROPIC_API_KEY` de GitHub Actions y el ítem `Dev/traveler` de 1Password. Nunca en un archivo, en el HTML ni en `localStorage`. `check-secrets` hace fallar el build si encuentra una key en archivos versionados o en `dist/`.
- Rotación cada 90 días (pon un recordatorio) o apenas sospeches una fuga.

### Rotación en 15 minutos

Con sospecha de fuga, el paso 1 va primero y sin esperar. En una rotación programada, haz el paso 1 al final, cuando la key nueva ya funcione.

| Min | Paso |
| --- | --- |
| 0-2 | Console, workspace `traveler`, API keys: desactiva o borra la key actual. |
| 2-4 | Crea una key nueva en el mismo workspace, con nombre `traveler-ci-AAAA-MM`. |
| 4-6 | `gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>` y pega la key cuando la pida. |
| 6-8 | 1Password: ítem `Dev/traveler`, campo `ANTHROPIC_API_KEY`, pega el valor nuevo desde la app. Limpia el portapapeles. |
| 8-13 | En local: `op run --env-file=.env.op -- pnpm refresh -- --dry-run --only=carnaval-barranquilla` debe responder. En GitHub, la corrida diaria de `pipeline.yml` (o `gh workflow run pipeline.yml`) debe pasar el paso «Run the pipeline». |
| 13-15 | En la Console, el uso nuevo cae en la key nueva y la vieja no registra uso. Anota la fecha abajo. |

Con sospecha de fuga, además: revisa el gasto del workspace de los últimos días, cierra la alerta de secret scanning como revocada y busca la key en el historial sin imprimirla: `git log --all --oneline -E -G 'sk-ant-[A-Za-z0-9_-]{20,}'` (solo lista commits). Rotar la key es la corrección; reescribir el historial es opcional.

| Fecha | Motivo | Key nueva | Verificado |
| --- | --- | --- | --- |
|  |  |  |  |

## Revisión mensual de riesgos

El día 1, unos 30 minutos. Un indicador que pasa dos semanas en alerta reabre su riesgo (PRD, «Riesgos y mitigaciones»).

| Riesgo | Indicador | Alerta | Dónde mirarlo |
| --- | --- | --- | --- |
| R1 | Errores hallados en la auditoría de 10 cambios | 1 o más | auditoría de abajo |
| R2 | Fechas con fuente A por país | menos de 60% | `share_a` en `data/index.json` |
| R3 | Cambios retenidos por «revisar idioma» | más de 20% | issue «Needs a look» y `data/state/holds.json` |
| R4 | Fiestas lunares sin fila para los próximos 12 meses | 1 o más | reglas `lunisolar_table` en `data/countries/` |
| R5 | Reportes de contenido sin atender más de 48 h | 1 o más | issues con `contenido` |
| R6 | Enlaces de advertencias de viaje rotos | 1 o más | corrida de `links.yml` en rojo; su resumen lista los rotos y los «sin verificar» |
| R7 | Cambios retenidos por el detector de instrucciones | 1 o más | issue «Needs a look» |
| R8 | Gasto diario sobre 3 veces el promedio de 7 días | cualquier día | uso del workspace en la Console |
| R9 | Horas entre el anuncio oficial y el cambio publicado | más de 72 | `data/changelog.json` contra la fuente |
| R10 | Gasto del mes | 80% del tope | `data/state/ledger.jsonl`, resumen de cada corrida y Console |
| R11 | Candidatas de fuentes no mediáticas por onboarding; las 5 mejores de un país en la misma ciudad | menos de 50%; sí | `proposals/onboard-<cc>-*.md` en el artefacto de la corrida |
| R13 | Fuentes de Nivel 1 sin copia archivada | 1 o más | `archive_url` en `data/countries/`; bajas de confianza en el resumen de la corrida del lunes |
| Retenidos | Cambios retenidos con más de 30 días | más de 10 | `data/state/holds.json` |

**Auditoría de 10 cambios aprobados al azar.** Abre la fuente de cada uno y comprueba que dice lo publicado (si ya no existe, usa la copia archivada):

```bash
node -e 'const c=require("./data/changelog.json");const p=c.filter(e=>e.date.startsWith(process.argv[1]));for(let i=p.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[p[i],p[j]]=[p[j],p[i]]}console.log(JSON.stringify(p.slice(0,10),null,1))' 2026-10
```

Un error encontrado se corrige con `git revert` del commit del pipeline o con un PR, y suma al indicador de R1. Sin revisión humana de cada cambio, esta auditoría es el control que queda: no la saltes. Cada trimestre, revisa además el ranking por país (R11).

## Costos

- Búsqueda web: US$10 por cada 1.000 búsquedas, más los tokens del contenido que traen, que se cobran como entrada. Una búsqueda con error no se cobra ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)).
- Modelo por defecto `claude-sonnet-5-5`: US$2 por millón de tokens de entrada y US$10 por millón de salida [tabla de modelos de Anthropic al 2026-10-06; confírmalo en la [página de precios](https://platform.claude.com/docs/en/about-claude/pricing)].
- Medido el 2026-11-08 (BR, 5 fiestas, búsqueda directa): unos US$0,24 por fiesta y pasada, búsqueda más extracción; la mayor parte son los tokens de los resultados, no las búsquedas. Ensayo del mismo día, 6 fiestas de BR con seguimiento: `claude-sonnet-5-5` US$2,49 (unos US$0,21 por pasada), `claude-haiku-5-5` US$0,51 (unos US$0,05), pero Haiku sacó las fechas de Recife de un calendario de feriados de Río y la validación tuvo que marcarlas; por eso el modelo sigue siendo Sonnet. Cada onboarding suma de 10 a 20 búsquedas más tokens [estimación del PRD].
- Con la regla anterior (todo lo que empezaba en menos de 180 días, cada semana) los 30 días desde el 2026-11-09 costaban unos US$49. La cadencia actual (ver PRD, «Qué fiestas se verifican») y el arreglo del barrido para fiestas aplazadas sin fecha la bajan a unos US$28 en un mes con 5 lunes [simulación sobre la cola, sin medir]; el resto lo corta la degradación del 80%. Las búsquedas de seguimiento suman como mucho `MAX_FOLLOWUPS_PER_RUN` fiestas por lunes y nunca desde el 80%.
- Barridos de noticias (R9): cada fiesta que entra cuesta lo mismo que en la verificación semanal (búsqueda más extracción). Cuentan contra `MONTHLY_BUDGET_USD` y la degradación del 80% también los limita.
- Búsqueda de fiestas nuevas (2026-11-10): una por país publicado cada 60 días (`discover_every_days`), como mucho 2 por día, unos US$0,70 cada una [estimación, `default_job_usd.discover`; el registro la reemplaza por el promedio real]. Con los 21 países de América Latina publicados son unos US$7 al mes de la parte de mantenimiento; el planificador la pone después de los controles de los próximos 45 días y la corta desde el 80% del mes. Los países de `coverage` que faltan se construyen con la parte de países nuevos (unos US$3,3 cada uno desde cero: 1 o 2 por mes con US$20).
- Cadencia según presupuesto (2026-11-09): con los costos por defecto de `config/pipeline.json`, mantener un país con 10 fiestas a cadencia completa cuesta unos US$2 a US$3 al mes, y la parte de mantenimiento de US$20 (US$14) alcanza para unos 5 países así; con más países el planificador espacia hasta 4 veces lo que está a más de 45 días (`pnpm pipeline -- --plan` muestra la proyección). Construir un país cuesta unos US$2,7 (política, onboarding y hasta 5 verificaciones), así que la parte de países nuevos (US$6) alcanza para 2 o 3 por mes [estimaciones; el registro reemplaza los valores por defecto por promedios reales cuando hay 3 tareas de cada tipo].
- Corte: el script lleva la cuenta en `data/state/ledger.jsonl` contra `MONTHLY_BUDGET_USD` (20 por defecto). Avisa al 50% y al 80%; desde el 80% solo verifica fiestas de Nivel 1 a 60 días o menos; al 100% se detiene (R10). El límite del workspace en la Console es el tope duro.
- La búsqueda va con `allowed_callers: ["direct"]`, sin filtrado dinámico: con filtrado dinámico la búsqueda corre dentro de code execution y la respuesta no trae citas `web_search_result_location`, así que toda propuesta caía como `no_citations` (corrida del 2026-11-08). La Message Batches API cobra la búsqueda al mismo precio.

## Sin confirmar

- Nombres exactos de los menús de la Console para keys de service account y para revocar una key.
- Si el workspace Default admite límites de tasa: la documentación solo dice que no admite límite de gasto.
- Si Pages en repo privado está incluido en tu plan.
- `pipeline.yml` no se ha corrido todavía en GitHub: el push directo a `main`, el disparo de `ci.yml` con `GITHUB_TOKEN` y las respuestas en los issues se validaron con pruebas del contrato del workflow y con corridas locales del script, no con una corrida real.
- Si el evento `issues: opened` de un formulario trae ya la etiqueta `build-country` en todas las cuentas; si no, poner la etiqueta a mano dispara la corrida igual (evento `labeled`).
