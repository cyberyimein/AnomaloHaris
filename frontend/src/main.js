import { createApp } from "vue";

import "./style.css";
import App from "./App.vue";

const localFonts = document.createElement("link");
localFonts.rel = "stylesheet";
localFonts.href = "/fonts/local.css";
document.head.appendChild(localFonts);

createApp(App).mount("#app");
