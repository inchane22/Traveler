# Traveler

Calendario anual de las fiestas con más gente y más calle, por país. Sitio estático (Vite y TypeScript sin framework) publicado en GitHub Pages, en español, inglés y portugués.

Cada lunes un workflow consulta la API de Claude con búsqueda web, valida la respuesta en código y abre un pull request con cada cambio y su fuente. Una persona lo revisa y lo aprueba. Nada llega al sitio sin ese PR aprobado.

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

Con respuestas grabadas, sin API key ni gasto:

```bash
pnpm refresh -- --dry-run --today=2026-10-26 --fixtures=tests/fixtures/<carpeta>
pnpm onboard -- --country=PE --dry-run --fixtures=tests/fixtures/<carpeta>
```

Con la API real. La key sale de 1Password y solo existe en el proceso hijo, nunca en un archivo:

```bash
op run --env-file=.env.op -- pnpm refresh -- --dry-run
op run --env-file=.env.op -- pnpm refresh -- --dry-run --only=carnaval-barranquilla
op run --env-file=.env.op -- pnpm onboard -- --country=PE --dry-run
```

`--dry-run` escribe `proposals/AAAA-MM-DD.json` y `proposals/AAAA-MM-DD.md` (ignorados por git) y no toca `data/`. Las variables están en [.env.example](.env.example); nunca crees un `.env` o `.env.local` con valores.

Barrido de noticias (R9) y chequeo de enlaces (R6, R13):

```bash
pnpm refresh -- --dry-run --sweep=news --fixtures=tests/fixtures/pipeline              # fiestas a 45 días o menos
pnpm refresh -- --dry-run --sweep=news --within=7 --fixtures=tests/fixtures/pipeline   # última semana
node scripts/check-links.ts                       # proposals/links-AAAA-MM-DD.md y .json; sale 1 solo si hay 404/410
LINKS_REPORT_PATH=proposals/links-2026-10-26.json pnpm refresh -- --dry-run --fixtures=tests/fixtures/pipeline
```

`--sweep=news` solo procesa las fiestas que empiezan dentro de la ventana (las que están en curso también) y busca «cancelado», «aplazado» y «suspendido» en el idioma local más sus equivalentes en inglés y portugués. Nunca lleva la propuesta trampa (R12) ni cuenta como la corrida semanal del mes. `LINKS_REPORT_PATH` apunta al `.json` de `check-links` (máximo 7 días de antigüedad): una edición cuyas fuentes dan todas 404 o 410 y no tienen copia archivada baja su confianza un nivel, una sola vez (R13). Sin esa variable, `refresh` no toca la confianza. Con ella, R13 recorre todos los archivos de país aunque la corrida use `--only` o `--country`, así que un PR de una sola fiesta puede traer también bajas de confianza. `USAGE_FALLBACK_PATH` apunta a un `usage.json` de otra corrida; se usa el total más alto de cada mes (ver «Presupuesto»).

## Estructura

```text
src/            app y lógica pura (schema, dates, score, festivals, ics), sin DOM ni fs en el núcleo
locales/        todo texto visible (es, en, pt)
data/           countries/<cc>.json, index.json (generado y versionado), changelog.json, usage.json
config/         pesos del puntaje, dominios oficiales y jerarquía de fuentes por país
scripts/        build-data, build-calendars, refresh, onboard, check-secrets, check-trap, check-links; lib/ del pipeline
tests/          unit/, e2e/ (Playwright + axe), fixtures/ (respuestas grabadas de la API)
.github/        workflows, formularios de issue, plantilla de PR, Dependabot
```

El detalle de cada módulo y quién lo puede tocar está en [docs/architecture.md](docs/architecture.md).

## Reglas de datos

- Toda fecha o cifra lleva una fuente https. Sin fuente, la fecha es «por anunciar» y la cifra «por medir».
- La IA propone y una persona aprueba. No hay merge automático.
- Los borradores no se publican: `build-data` los deja fuera salvo con `INCLUDE_DRAFTS=1`, que solo usa `pnpm dev`.
- Un país pasa de `borrador` a `publicado` cuando se aprueba su PR de onboarding y tiene al menos 3 fiestas con fecha y fuente (A, o dos B; R2). Para publicarlo, en ese PR cambia `"status": "borrador"` por `"publicado"`, corre `node scripts/build-data.ts` y versiona `data/index.json`; CI falla si el índice no coincide.
- Una fecha confirmada no vuelve a tentativa sin una fuente que lo diga, y ninguna fiesta se borra desde el pipeline.
- De terceros se guardan hechos y una frase propia con enlace; nunca párrafos copiados.

## Automatización

| Workflow | Cuándo | Permisos | Qué hace |
| --- | --- | --- | --- |
| `ci.yml` | cada PR y cada push a `main` | `contents: read` | typecheck, Vitest con cobertura, build, `check-secrets`, índice sin cambios, `check-trap`, Playwright + axe, Lighthouse CI. Check requerido: `ci` |
| `refresh.yml` | lunes 11:00 UTC verificación completa; martes y viernes `--sweep=news`; domingo, miércoles, jueves y sábado `--sweep=news --within=7` (R9); manual con `only`, `country` y `sweep` | `contents: write`, `pull-requests: write`; el job `usage` solo `actions: read` | `pnpm refresh`, valida con `build-data`, abre `refresh/AAAA-MM-DD` con `needs-review`. El lunes corre antes `check-links` para R13 |
| `onboard.yml` | día 1, 11:00 UTC; manual con `country` | `contents: write`, `pull-requests: write`; el job `usage` solo `actions: read` | crea el borrador del país y abre `onboard/<cc>` con `needs-review` |
| `links.yml` | domingo 10:00 UTC; manual | `contents: read` | `node scripts/check-links.ts` sobre `config/advisories.json` y las fuentes de `data/`; falla (la alerta de R6) solo con un 404 o 410; el reporte queda en el resumen de la corrida y en el artefacto |
| `usage-fallback.yml` | lo llaman `refresh.yml` y `onboard.yml` | `actions: read` | entrega el `usage.json` del último artefacto `usage` de `main` (R10) |
| `deploy.yml` | push a `main`; manual solo desde `main` | build: `contents: read`, `pages: read`; deploy: `pages: write`, `id-token: write` | build con `BASE_PATH=/<repo>/`, `check-trap` de respaldo, publica en Pages |

Todas las acciones de terceros están fijadas por SHA con la versión en un comentario; Dependabot las actualiza los martes. Para fijar una acción nueva, saca el SHA del tag con `gh api repos/<owner>/<acción>/git/ref/tags/<versión> --jq .object.sha` (así se fijó `actions/download-artifact` v8.0.2); nunca lo escribas de memoria. Hay una corrida de `refresh` por día como máximo, así que dos corridas nunca comparten la rama `refresh/AAAA-MM-DD`; un `workflow_dispatch` el mismo día que una programada sí la comparte y actualiza ese PR. `refresh` y `onboard` comparten el grupo de concurrencia `ai-pipeline`: nunca corren a la vez y una corrida nueva espera, no cancela, a la que ya está gastando.

**Qué entra en un PR de IA.** `data/countries/*.json`, `data/changelog.json`, `data/usage.json` y `data/index.json` regenerado (onboard: solo el archivo del país y, si existen, `config/official-domains/<cc>.json` y `config/sources/<cc>.json`). El índice va incluido porque CI lo compara con el que genera `build-data`, y una verificación que cambia `last_verified` sin él fallaría. La descripción es `proposals/<fecha>.md` más la lista de revisión de [la plantilla de PR](.github/pull_request_template.md), porque GitHub no aplica la plantilla a PRs creados por API. Se abre PR si hay cambios propuestos o si cambió algún archivo de datos: una verificación que solo actualiza `last_verified` también entra, para que no aparezca el aviso de datos viejos a los 30 días (RF-13).

**Presupuesto y `usage.json` (decisión).** El tope duro es el límite de gasto del workspace en la Claude Console; `MONTHLY_BUDGET_USD` es el tope blando del script. `data/usage.json` viaja en el mismo PR que los datos, así que un PR sin fusionar, o una corrida sin cambios que no abre PR («Sin cambios no se abre PR», PRD), dejaría su gasto fuera de `main`. Para no perderlo, cada corrida de `refresh` u `onboard` que cambia `data/usage.json` lo sube también como artefacto con el nombre fijo `usage` (90 días), y la siguiente corrida lo baja con el job `usage` (`usage-fallback.yml`, solo `actions: read`), lo pasa en `USAGE_FALLBACK_PATH` y usa, mes por mes, el total más alto entre ese archivo y el de `main`. El total combinado se escribe en `data/usage.json` antes de la primera llamada, así que el artefacto nunca baja. Si el job `usage` falla o no hay artefacto, la corrida sigue con el `usage.json` de `main` y lo avisa en el log. Las corridas sin gasto no suben artefacto: el anterior sigue siendo el último. Revisa el PR de cada lunes antes del lunes siguiente: dos PRs de refresh abiertos chocan en los mismos archivos (con `usage.json` incluido), así que cierra el viejo.

**CI en los PRs de IA.** Con el `GITHUB_TOKEN` el PR lo abre `github-actions[bot]`, y GitHub no dispara otros workflows por eventos de ese token: `ci.yml` no corre solo. Para dispararlo, cierra y vuelve a abrir el PR. Con la GitHub App del paso 11 de la configuración, CI corre solo. No uses un token personal (PAT): el autor del PR serías tú, GitHub no deja aprobar un PR propio y `main` no aceptaría el merge.

## Primera configuración en GitHub

1. Crea el repositorio y sube `main` (por ejemplo `gh repo create <owner>/traveler --private --source=. --push`). Pages en un repo privado exige un plan de pago [sin confirmar para tu cuenta].
2. Settings > Pages > Source: **GitHub Actions**. Si usas dominio propio, define las variables `BASE_PATH=/` y `SITE_URL=https://tu-dominio/`; `deploy.yml` falla con un mensaje claro si la ruta no coincide con la que sirve Pages.
3. Settings > Environments > `github-pages`: deployment branches solo `main`.
4. Settings > Actions > General > Workflow permissions: deja **Read repository contents**. Activa **Allow GitHub Actions to create and approve pull requests** solo si no vas a usar la GitHub App del paso 11 (el `GITHUB_TOKEN` lo necesita para abrir PRs).
5. Settings > Rules > Rulesets > nuevo ruleset para la rama por defecto (RF-16): bloquear force push y borrado; exigir PR con 1 aprobación, descartar aprobaciones viejas con commits nuevos y resolver conversaciones; exigir el check `ci` con la rama al día. Como mantenedor único no puedes aprobar tus propios PRs de código: agrega «Repository admin» a la lista de bypass en modo «solo pull requests» y úsalo solo en tus PRs de código y con `ci` en verde (el bypass también salta el check, y `deploy.yml` no espera a `ci.yml`), nunca en uno con `needs-review`. Es una tensión real con R12; un segundo revisor la elimina, y `deploy.yml` repite `check-trap` de respaldo.
6. Settings > Code security: secret scanning, push protection, Dependabot alerts y security updates. GitHub reconoce las keys de Anthropic (API, admin y service account), bloquea el push y avisa a Anthropic.
7. Settings > General: **Automatically delete head branches**. Un PR de onboarding cerrado sin merge deja su rama `onboard/<cc>`, y el job mensual salta ese país hasta que la borres.
8. Secretos (Settings > Secrets and variables > Actions). `gh secret set` pide el valor por teclado, así no queda en el historial:

   ```bash
   gh secret set ANTHROPIC_API_KEY
   gh secret set TRAP_SECRET
   gh secret set TRAP_FINGERPRINTS     # solo en GitHub; no lo guardes donde lo puedas leer al revisar
   gh secret set ARCHIVE_ACCESS_KEY    # opcional, R13 (archive.org)
   gh secret set ARCHIVE_SECRET_KEY    # opcional, R13
   ```

9. Variables:

   ```bash
   gh variable set ANTHROPIC_MODEL --body claude-sonnet-5-5
   gh variable set MONTHLY_BUDGET_USD --body 20
   gh variable set MAX_FESTIVALS_PER_RUN --body 40
   gh variable set ONBOARD_QUEUE --body "PE,BR,BO,MX"   # el job mensual toma el primero sin archivo ni rama
   ```

10. Etiquetas:

    ```bash
    gh label create needs-review   --color FBCA04 --description "Propuesta de IA: revisar antes de fusionar"
    gh label create error-de-datos --color D73A4A --description "Dato incorrecto reportado (RF-17, R1)"
    gh label create contenido      --color 5319E7 --description "Contenido o respeto (RF-17, R5)"
    gh label create sugerencia     --color 0E8A16 --description "Fiesta sugerida (R11)"
    ```

11. GitHub App, recomendada (10 minutos). Settings > Developer settings > GitHub Apps > New: sin webhook, permisos de repositorio Contents y Pull requests en Read and write, instalada solo en este repo. Genera una clave privada y guárdala: `gh variable set PR_APP_CLIENT_ID --body <client-id>` y `gh secret set PR_APP_PRIVATE_KEY < clave.pem`; luego borra el `.pem`. Con la App los PRs de IA disparan CI solos y puedes dejar apagada la opción del paso 4.
12. Claude Console: crea el workspace y la key según la política de abajo. La búsqueda web viene activada salvo que un admin la haya apagado en [Settings > Capabilities](https://platform.claude.com/settings/capabilities), donde también se restringen dominios; confírmalo.
13. Primera corrida barata: `gh workflow run refresh.yml -f only=carnaval-barranquilla` y `gh run watch`. Revisa el PR, ciérralo y vuelve a abrirlo para que corra CI (o usa la App), apruébalo y fusiónalo; `deploy.yml` publica.

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
| 8-13 | `gh workflow run refresh.yml -f only=carnaval-barranquilla` y `gh run watch`: el paso «Run weekly verification or news sweep» debe pasar. En local: `op run --env-file=.env.op -- pnpm refresh -- --dry-run --only=carnaval-barranquilla`. |
| 13-15 | En la Console, el uso nuevo cae en la key nueva y la vieja no registra uso. Anota la fecha abajo. |

Con sospecha de fuga, además: revisa el gasto del workspace de los últimos días, cierra la alerta de secret scanning como revocada y busca la key en el historial sin imprimirla: `git log --all --oneline -E -G 'sk-ant-[A-Za-z0-9_-]{20,}'` (solo lista commits). Rotar la key es la corrección; reescribir el historial es opcional.

| Fecha | Motivo | Key nueva | Verificado |
| --- | --- | --- | --- |
|  |  |  |  |

## Revisión mensual de riesgos

El día 1, junto al onboarding, unos 30 minutos. Un indicador que pasa dos semanas en alerta reabre su riesgo (PRD, «Riesgos y mitigaciones»).

| Riesgo | Indicador | Alerta | Dónde mirarlo |
| --- | --- | --- | --- |
| R1 | Propuestas de fecha rechazadas en revisión | más de 10% en el mes | PRs `needs-review` cerrados del mes |
| R2 | Fechas con fuente A por país | menos de 60% | `share_a` en `data/index.json` |
| R3 | Cambios marcados «revisar idioma» | más de 20% | descripciones de los PRs de IA |
| R4 | Fiestas lunares sin fila para los próximos 12 meses | 1 o más | reglas `lunisolar_table` en `data/countries/` |
| R5 | Reportes de contenido sin atender más de 48 h | 1 o más | issues con `contenido` |
| R6 | Enlaces de advertencias de viaje rotos | 1 o más | corrida de `links.yml` en rojo; su resumen lista los rotos y los «sin verificar» |
| R7 | Cambios marcados por el detector de instrucciones | 1 o más | descripciones de los PRs de IA |
| R8 | Gasto diario sobre 3 veces el promedio de 7 días | cualquier día | uso del workspace en la Console |
| R9 | Horas entre el anuncio oficial y el cambio publicado | más de 72 | `data/changelog.json` contra la fuente |
| R10 | Gasto del mes | 80% del tope | `data/usage.json`, artefactos de las corridas y Console |
| R11 | Candidatas de fuentes no mediáticas por onboarding; las 5 mejores de un país en la misma ciudad | menos de 50%; sí | PR de onboarding del mes |
| R12 | Propuestas trampa rechazadas | menos de 100% | paso «Trap proposal check» en CI de los PRs del mes |
| R13 | Fuentes de Nivel 1 sin copia archivada | 1 o más | `archive_url` en `data/countries/`; bajas de confianza en la sección «Fuentes perdidas» de los PRs del lunes |

**Trampa (R12).** Si aprobaste la propuesta trampa del mes, CI la bloqueó, pero la revisión falló: durante el mes siguiente cada PR de datos necesita un segundo revisor.

**Auditoría de 10 cambios aprobados al azar.** Abre la fuente de cada uno y comprueba que dice lo publicado (si ya no existe, usa la copia archivada):

```bash
node -e 'const c=require("./data/changelog.json");const p=c.filter(e=>e.date.startsWith(process.argv[1]));for(let i=p.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[p[i],p[j]]=[p[j],p[i]]}console.log(JSON.stringify(p.slice(0,10),null,1))' 2026-10
```

Un error encontrado se corrige con un PR, activa el segundo revisor un mes y suma al indicador de R1. Cada trimestre, revisa además el ranking por país (R11).

## Costos

- Búsqueda web: US$10 por cada 1.000 búsquedas, más los tokens del contenido que traen, que se cobran como entrada. Una búsqueda con error no se cobra ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)).
- Modelo por defecto `claude-sonnet-5-5`: US$2 por millón de tokens de entrada y US$10 por millón de salida [tabla de modelos de Anthropic al 2026-10-06; confírmalo en la [página de precios](https://platform.claude.com/docs/en/about-claude/pricing)].
- Estimación: 40 fiestas, 5 búsquedas cada una y 4 corridas al mes son 800 búsquedas, unos US$8 más tokens. Cada onboarding suma de 10 a 20 búsquedas más tokens [estimación del PRD].
- Barridos de noticias (R9): unas 26 corridas más al mes. La mayoría no encuentra fiestas en su ventana y no hace ninguna llamada; cada fiesta que entra cuesta lo mismo que en la verificación semanal (búsqueda más extracción). Cuentan contra `MONTHLY_BUDGET_USD` y la degradación del 80% también los limita [estimación propia, sin medir].
- Corte: el script lleva la cuenta en `data/usage.json` contra `MONTHLY_BUDGET_USD` (20 por defecto). Avisa al 50% y al 80%; desde el 80% solo verifica fiestas de Nivel 1 a 60 días o menos; al 100% se detiene (R10). El límite del workspace en la Console es el tope duro.
- Para gastar menos: las versiones de búsqueda con filtrado dinámico (`web_search_20260209` o posterior) dejan fuera del contexto lo irrelevante, y la Message Batches API cobra la búsqueda al mismo precio.

## Sin confirmar

- Nombres exactos de los menús de la Console para keys de service account y para revocar una key.
- Si el workspace Default admite límites de tasa: la documentación solo dice que no admite límite de gasto.
- Si Pages en repo privado está incluido en tu plan.
- Las carpetas de `tests/fixtures/` y el nombre del resumen de onboarding en `proposals/` los define el pipeline; los workflows toman el `.md` más reciente (sin contar `links-*.md`) si no encuentran `proposals/<fecha>.md`.
- El job `usage` y el paso de R13 en `refresh.yml` no se han corrido en GitHub: se validaron con `actionlint` y con pruebas locales del script, no con una corrida real.
