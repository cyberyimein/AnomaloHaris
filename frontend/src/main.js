import { createApp } from "vue";

import "./style.css";
async function mountApp() {
  if (import.meta.env.MODE === "demo") {
    const { default: DemoApp } = await import("./demo/DemoApp.vue");
    document.title = "AnomaloHaris · Interactive Demo";
    createApp(DemoApp).mount("#app");
  } else {
    const { default: App } = await import("./App.vue");
    const localFonts = document.createElement("link");
    localFonts.rel = "stylesheet";
    localFonts.href = "/fonts/local.css";
    document.head.appendChild(localFonts);
    createApp(App).mount("#app");
  }
}

mountApp();
