<template>
  <section class="capability-dashboard">
    <div class="capability-dashboard-shell">
      <header class="capability-dashboard-hero">
        <div>
          <span>Optional extensions</span>
          <h2>Plugin capabilities</h2>
          <p>The catalog shows the fixed runtime/plugin boundary. Buddy remains an external service and is only exposed to an Agent when an explicit Buddy plugin binding is loaded.</p>
        </div>
        <button type="button" class="capability-refresh" :disabled="loading" @click="load">
          {{ loading ? "Refreshing…" : "Refresh" }}
        </button>
      </header>

      <div v-if="error" class="capability-notice capability-notice-error">{{ error }}</div>
      <div v-if="loading && !plugins.length" class="capability-empty">Loading plugin catalog…</div>
      <div v-else-if="!plugins.length" class="capability-empty">
        <strong>No plugins are registered.</strong>
        <span>Core model, web and browser behavior remains owned by the Node Host runtime.</span>
      </div>
      <div v-else class="capability-grid">
        <article v-for="plugin in plugins" :key="plugin.id" class="capability-card">
          <div class="capability-card-heading">
            <strong>{{ plugin.id }}</strong>
            <span :class="plugin.loaded ? 'capability-ok' : 'capability-muted'">
              {{ plugin.loaded ? "loaded" : plugin.state === "catalogued" ? "available" : plugin.state || "unavailable" }}
            </span>
          </div>
          <small v-if="plugin.version">v{{ plugin.version }} · {{ plugin.compatibility || "runtime" }}</small>
          <p v-if="plugin.capabilities?.length">{{ plugin.capabilities.join(" · ") }}</p>
          <p v-else>{{ plugin.tools?.length ? `${plugin.tools.length} registered tool${plugin.tools.length === 1 ? "" : "s"}` : "No optional capability declared." }}</p>
          <code v-if="plugin.error">{{ plugin.error }}</code>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup>
import { onMounted, ref } from "vue";

const plugins = ref([]);
const loading = ref(false);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/plugins");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to load plugin catalog.");
    plugins.value = Array.isArray(payload.plugins) ? payload.plugins : [];
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
defineExpose({ refresh: load });
</script>

<style scoped>
.capability-dashboard { min-height: 0; overflow: auto; padding: 34px clamp(18px, 5vw, 64px) 42px; }
.capability-dashboard-shell { width: min(1180px, 100%); margin: 0 auto; }
.capability-dashboard-hero { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
.capability-dashboard-hero span { color: var(--muted); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
.capability-dashboard-hero h2 { margin: 6px 0 4px; font-size: clamp(27px, 4vw, 42px); font-weight: 500; }
.capability-dashboard-hero p { max-width: 680px; margin: 0; color: var(--muted); }
.capability-refresh { min-height: 40px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); color: var(--text); padding: 0 14px; font: inherit; cursor: pointer; }
.capability-refresh:disabled { opacity: .55; cursor: wait; }
.capability-notice, .capability-empty, .capability-card { border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.capability-notice { margin-bottom: 16px; padding: 13px 15px; }
.capability-notice-error { color: #a13a35; }
.capability-empty { display: grid; gap: 8px; min-height: 180px; place-items: center; padding: 24px; color: var(--muted); text-align: center; }
.capability-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.capability-card { display: grid; gap: 8px; padding: 17px; }
.capability-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.capability-card small, .capability-card p { margin: 0; color: var(--muted); font-size: 12px; }
.capability-card code { overflow-wrap: anywhere; color: #a13a35; font-size: 11px; }
.capability-ok { color: #39734a; font-size: 12px; }
.capability-muted { color: var(--muted); font-size: 12px; }
@media (max-width: 700px) { .capability-dashboard-hero { align-items: start; flex-direction: column; } }
</style>
