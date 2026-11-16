<template>
  <div ref="host" class="search-select" :class="{ 'is-open': open, 'is-disabled': disabled }">
    <button
      :id="triggerId"
      ref="trigger"
      class="search-select-trigger"
      type="button"
      role="combobox"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      :aria-controls="listboxId"
      aria-haspopup="listbox"
      :aria-activedescendant="open && activeOption ? optionId(activeOption) : undefined"
      :disabled="disabled"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="search-select-copy">
        <strong>{{ selectedOption?.label || placeholder }}</strong>
        <small v-if="displayDetail(selectedOption)">{{ displayDetail(selectedOption) }}</small>
        <small v-else-if="selectedOption?.status" class="search-select-status">{{ selectedOption.status }}</small>
      </span>
      <span class="search-select-trailing">
        <span v-if="selectedOption?.status && displayDetail(selectedOption)" class="search-select-status">{{ selectedOption.status }}</span>
        <ChevronDown :size="16" aria-hidden="true" />
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="popup"
        class="search-select-popup"
        :style="popupStyle"
        @pointerdown.stop
      >
        <label class="search-select-filter">
          <Search :size="15" aria-hidden="true" />
          <input
            ref="searchInput"
            v-model="query"
            role="searchbox"
            :aria-label="searchLabel"
            :aria-controls="listboxId"
            :aria-activedescendant="activeOption ? optionId(activeOption) : undefined"
            :placeholder="searchPlaceholder"
            autocomplete="off"
            @keydown="onSearchKeydown"
          />
          <kbd>ESC</kbd>
        </label>
        <div :id="listboxId" class="search-select-options" role="listbox" :aria-label="ariaLabel">
          <p v-if="!filteredOptions.length" class="search-select-empty">No matching options</p>
          <button
            v-for="(option, index) in filteredOptions"
            :id="optionId(option)"
            :key="option.value"
            class="search-select-option"
            :class="{ active: index === activeIndex, selected: option.value === modelValue, disabled: option.disabled }"
            type="button"
            role="option"
            :aria-selected="option.value === modelValue"
            :aria-disabled="option.disabled ? 'true' : undefined"
            :data-model-id="option.value"
            tabindex="-1"
            @mouseenter="setActive(index)"
            @click="choose(option)"
          >
            <span class="search-select-option-copy">
              <strong>{{ option.label }}</strong>
              <small v-if="displayDetail(option)">{{ displayDetail(option) }}</small>
            </span>
            <span class="search-select-option-end">
              <span v-if="option.status" class="search-select-status">{{ option.status }}</span>
              <Check v-if="option.value === modelValue" :size="16" aria-hidden="true" />
            </span>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { Check, ChevronDown, Search } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
  options: { type: Array, default: () => [] },
  ariaLabel: { type: String, required: true },
  placeholder: { type: String, default: "Choose an option" },
  searchLabel: { type: String, default: "Filter models" },
  searchPlaceholder: { type: String, default: "Filter models" },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(["update:modelValue", "change"]);
const id = useId().replaceAll(":", "");
const triggerId = `search-select-${id}`;
const listboxId = `search-select-list-${id}`;
const host = ref(null);
const trigger = ref(null);
const popup = ref(null);
const searchInput = ref(null);
const open = ref(false);
const query = ref("");
const activeIndex = ref(-1);
const popupStyle = ref({});

const filteredOptions = computed(() => {
  const normalized = query.value.trim().toLocaleLowerCase();
  if (!normalized) return props.options;
  return props.options.filter((option) => [option.label, option.detail, option.value, option.status]
    .some((part) => String(part || "").toLocaleLowerCase().includes(normalized)));
});
const selectedOption = computed(() => props.options.find((option) => option.value === props.modelValue));
const activeOption = computed(() => filteredOptions.value[activeIndex.value]);

function displayDetail(option) {
  if (!option?.detail) return "";
  if (String(option.label).trim().toLocaleLowerCase() === String(option.detail).trim().toLocaleLowerCase()) return "";
  return option.detail;
}

function optionId(option) {
  return `${listboxId}-${encodeURIComponent(String(option.value)).replaceAll("%", "_")}`;
}

function enabledIndexes() {
  return filteredOptions.value.flatMap((option, index) => option.disabled ? [] : [index]);
}

function setActive(index) {
  if (index < 0 || index >= filteredOptions.value.length || filteredOptions.value[index]?.disabled) return;
  activeIndex.value = index;
  nextTick(() => document.getElementById(optionId(filteredOptions.value[index]))?.scrollIntoView({ block: "nearest" }));
}

function moveActive(direction) {
  const enabled = enabledIndexes();
  if (!enabled.length) {
    activeIndex.value = -1;
    return;
  }
  const currentPosition = enabled.indexOf(activeIndex.value);
  const nextPosition = currentPosition < 0
    ? (direction > 0 ? 0 : enabled.length - 1)
    : (currentPosition + direction + enabled.length) % enabled.length;
  setActive(enabled[nextPosition]);
}

function moveToEdge(edge) {
  const enabled = enabledIndexes();
  if (!enabled.length) return;
  setActive(edge === "start" ? enabled[0] : enabled.at(-1));
}

function positionPopup() {
  const bounds = trigger.value?.getBoundingClientRect();
  if (!bounds) return;
  const viewportPadding = 12;
  const width = Math.min(Math.max(bounds.width, 280), window.innerWidth - viewportPadding * 2, 420);
  const left = Math.min(Math.max(viewportPadding, bounds.left), window.innerWidth - width - viewportPadding);
  const availableBelow = Math.max(0, window.innerHeight - bounds.bottom - viewportPadding - 7);
  const availableAbove = Math.max(0, bounds.top - viewportPadding - 7);
  const preferBelow = availableBelow >= Math.min(300, window.innerHeight * 0.42) || availableBelow >= availableAbove;
  const availableHeight = preferBelow ? availableBelow : availableAbove;
  const maxHeight = Math.min(350, availableHeight);
  const verticalPosition = preferBelow
    ? { top: `${bounds.bottom + 7}px`, bottom: "auto" }
    : { top: "auto", bottom: `${window.innerHeight - bounds.top + 7}px` };
  popupStyle.value = { position: "fixed", zIndex: 120, left: `${left}px`, ...verticalPosition, width: `${width}px`, maxHeight: `${maxHeight}px` };
}

function addOpenListeners() {
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  document.addEventListener("focusin", onOutsideFocus, true);
  window.addEventListener("resize", positionPopup);
  window.addEventListener("scroll", positionPopup, true);
}

function removeOpenListeners() {
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  document.removeEventListener("focusin", onOutsideFocus, true);
  window.removeEventListener("resize", positionPopup);
  window.removeEventListener("scroll", positionPopup, true);
}

function onOutsidePointerDown(event) {
  if (host.value?.contains(event.target) || popup.value?.contains(event.target)) return;
  close();
}

function onOutsideFocus(event) {
  if (host.value?.contains(event.target) || popup.value?.contains(event.target)) return;
  close();
}

async function show() {
  if (props.disabled || open.value) return;
  open.value = true;
  query.value = "";
  const selectedIndex = filteredOptions.value.findIndex((option) => option.value === props.modelValue && !option.disabled);
  activeIndex.value = selectedIndex >= 0 ? selectedIndex : enabledIndexes()[0] ?? -1;
  addOpenListeners();
  await nextTick();
  positionPopup();
  searchInput.value?.focus();
  if (activeOption.value) document.getElementById(optionId(activeOption.value))?.scrollIntoView({ block: "nearest" });
}

function close({ restoreFocus = false } = {}) {
  if (!open.value) return;
  open.value = false;
  query.value = "";
  removeOpenListeners();
  if (restoreFocus) nextTick(() => trigger.value?.focus());
}

function toggle() {
  if (open.value) close();
  else void show();
}

function choose(option) {
  if (option.disabled) return;
  emit("update:modelValue", option.value);
  emit("change", option.value, option);
  close({ restoreFocus: true });
}

function chooseActive() {
  if (activeOption.value && !activeOption.value.disabled) choose(activeOption.value);
}

function onTriggerKeydown(event) {
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    if (!open.value) {
      void show().then(() => {
        if (event.key === "ArrowUp") moveToEdge("end");
        else if (event.key === "Home") moveToEdge("start");
        else if (event.key === "End") moveToEdge("end");
      });
    } else if (event.key === "Home") moveToEdge("start");
    else if (event.key === "End") moveToEdge("end");
    else moveActive(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Escape" && open.value) {
    event.preventDefault();
    close({ restoreFocus: true });
  } else if ((event.key === "Enter" || event.key === " ") && open.value) {
    event.preventDefault();
    chooseActive();
  }
}

function onSearchKeydown(event) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Home" && !query.value) {
    event.preventDefault();
    moveToEdge("start");
  } else if (event.key === "End" && !query.value) {
    event.preventDefault();
    moveToEdge("end");
  } else if (event.key === "Enter") {
    event.preventDefault();
    chooseActive();
  } else if (event.key === "Escape") {
    event.preventDefault();
    close({ restoreFocus: true });
  }
}

watch(filteredOptions, (options) => {
  if (!open.value) return;
  const selectedIndex = options.findIndex((option) => option.value === props.modelValue && !option.disabled);
  const currentValid = options[activeIndex.value] && !options[activeIndex.value].disabled;
  activeIndex.value = currentValid ? activeIndex.value : selectedIndex >= 0 ? selectedIndex : enabledIndexes()[0] ?? -1;
});

watch(() => props.disabled, (disabled) => {
  if (disabled) close();
});

onBeforeUnmount(removeOpenListeners);
</script>

<style scoped>
.search-select { min-width: 0; width: 100%; }
.search-select-trigger {
  width: 100%; min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  box-sizing: border-box; border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px;
  background: var(--surface); color: var(--text); text-align: left; font: inherit; cursor: pointer;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.search-select-trigger:hover, .search-select.is-open .search-select-trigger { border-color: #70614a88; background: #fffefa; }
.search-select-trigger:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.search-select.is-disabled { opacity: .62; }
.search-select-trigger:disabled { cursor: not-allowed; }
.search-select-copy, .search-select-option-copy { display: grid; min-width: 0; gap: 2px; }
.search-select-copy strong, .search-select-option-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.search-select-copy small, .search-select-option-copy small { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 1.35; }
.search-select-trailing, .search-select-option-end { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 8px; color: var(--muted); }
.search-select-status { border-radius: 999px; background: var(--surface-muted); padding: 3px 7px; color: var(--muted); font-size: 10px; line-height: 1.2; white-space: nowrap; }
.search-select-popup {
  display: flex; flex-direction: column; gap: 7px; overflow: hidden; border: 1px solid #d7d1c6; border-radius: 14px;
  box-sizing: border-box; background: #fffefa; color: var(--text); box-shadow: 0 18px 48px #302b211f, 0 4px 12px #302b2112; padding: 7px;
}
.search-select-filter {
  min-height: 38px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 9px;
  background: #f8f6f1; color: var(--muted); padding: 0 10px;
}
.search-select-filter:focus-within { border-color: #8e7f69; box-shadow: 0 0 0 2px #9b8b7026; }
.search-select-filter input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 12px; }
.search-select-filter input::placeholder { color: #918b81; }
.search-select-filter kbd { border: 1px solid #ded9ce; border-radius: 4px; background: white; padding: 2px 4px; color: #827c72; font: inherit; font-size: 9px; line-height: 1.2; }
.search-select-options { overflow: auto; min-height: 0; padding: 2px; overscroll-behavior: contain; }
.search-select-option {
  width: 100%; min-height: 42px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text); padding: 7px 9px;
  text-align: left; font: inherit; cursor: pointer;
}
.search-select-option:hover, .search-select-option.active { border-color: #9b8b7033; background: #f3efe7; }
.search-select-option.selected .search-select-option-copy strong { font-weight: 650; }
.search-select-option.disabled { opacity: .5; cursor: not-allowed; }
.search-select-option.disabled:hover, .search-select-option.disabled.active { border-color: transparent; background: transparent; }
.search-select-option-end svg { color: #73634c; }
.search-select-empty { margin: 0; padding: 14px 10px; color: var(--muted); font-size: 12px; text-align: center; }
@media (max-width: 520px) {
  .search-select-popup { border-radius: 12px; }
  .search-select-trigger { min-height: 46px; }
}
</style>
