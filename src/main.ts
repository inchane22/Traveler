// Entry: styles (fonts are self-hosted, CSP font-src 'self'), the app shell, and the service worker.
import "@fontsource-variable/anybody/standard.css";
import "@fontsource-variable/atkinson-hyperlegible-next/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/screens.css";
import { boot } from "./app.ts";
import { registerServiceWorker } from "./sw-register.ts";

boot();
registerServiceWorker();
