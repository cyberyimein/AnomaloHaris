<template>
  <section class="dashboard-view buddy-console" aria-label="Buddy robot">
    <header class="buddy-console-header">
      <div class="buddy-heading">
        <span class="buddy-eyebrow">Device console</span>
        <h2>Buddy</h2>
        <div class="buddy-device-summary">
          <span class="buddy-connect-state" :class="{ online: statusFresh && buddyStatus?.connected }">
            <i aria-hidden="true"></i>{{ statusLabel }}
          </span>
          <span class="buddy-mode-state" :data-mode="deviceMode">
            <span>Mode</span><strong>{{ deviceModeLabel }}</strong>
          </span>
          <code v-if="buddyStatus?.deviceId">{{ buddyStatus.deviceId }}</code>
        </div>
        <p v-if="stateDetail" class="buddy-state-detail">{{ stateDetail }}</p>
        <p v-if="buddyFaultText" class="buddy-fault-state" role="alert">{{ buddyFaultText }}</p>
      </div>

      <section class="dashboard-admin-compact buddy-admin-card" aria-label="Admin access">
        <header>
          <span>Admin access</span>
          <strong>{{ managementTokenStatus }}</strong>
        </header>
        <form class="management-token-form" @submit.prevent="$emit('save-management-token')">
          <input
            v-model="managementTokenInput"
            type="password"
            autocomplete="off"
            placeholder="AnomaloHaris admin token"
            aria-label="AnomaloHaris admin token"
          />
          <button class="control-button" type="submit">Save</button>
          <button
            class="control-button"
            type="button"
            :disabled="!managementToken"
            @click="$emit('clear-management-token')"
          >
            Clear
          </button>
        </form>
      </section>
    </header>

    <section class="buddy-command-bar" aria-label="Robot and Agent status">
      <div class="buddy-command-group">
        <div class="buddy-command-copy">
          <span>Device power</span>
          <strong>{{ deviceModeLabel }}</strong>
        </div>
        <div class="buddy-command-actions">
          <div class="buddy-command-buttons">
            <button
              class="control-button buddy-primary-button"
              type="button"
              :disabled="busy || !buddyStatus?.connected || devicePoweringOff || !hasCapability('device.wake')"
              @click="invokeByName('device.wake')"
            >
              Wake from standby
            </button>
            <button
              class="control-button"
              type="button"
              :disabled="busy || !buddyStatus?.connected || deviceSleeping || devicePoweringOff || !hasCapability('device.sleep')"
              @click="invokeByName('device.sleep')"
            >
              Enter standby
            </button>
            <button
              v-if="hasCapability('device.shutdown')"
              class="control-button buddy-danger-button"
              type="button"
              title="After power off, press the physical power button to start Buddy again."
              :disabled="busy || !buddyStatus?.connected || devicePoweringOff"
              @click="invokeByName('device.shutdown')"
            >
              Power off
            </button>
          </div>
          <small v-if="hasCapability('device.shutdown')" class="buddy-power-off-note">
            Press the physical power button to start Buddy again.
          </small>
        </div>
      </div>

      <div class="buddy-command-group buddy-agent-command">
        <div class="buddy-command-copy">
          <span>Agent access</span>
          <strong>{{ agentEnabled ? "Enabled" : "Disabled" }}</strong>
        </div>
        <button
          class="control-button"
          type="button"
          :disabled="actionInFlight || (!agentEnabled && (!statusFresh || !buddyStatus?.connected || deviceSleeping || devicePoweringOff || !buddyStatus?.deviceId || serviceBusy))"
          :aria-pressed="agentEnabled"
          @click="controller.setAgentEnabled(!agentEnabled)"
        >
          {{ agentEnabled ? "Disable Agent" : "Enable Agent" }}
        </button>
      </div>

      <div v-if="serviceBusy" class="buddy-active-action" role="status">
        <span class="buddy-busy-dot" aria-hidden="true"></span>
        <span>{{ activeActionText }}</span>
      </div>
    </section>

    <p class="buddy-dashboard-status" role="status">{{ dashboardStatus }}</p>

    <nav class="buddy-tabs" aria-label="Buddy controls" role="tablist">
      <button
        v-for="tab in dashboardTabs"
        :key="tab.id"
        :id="'buddy-tab-' + tab.id"
        aria-controls="buddy-tab-panel"
        :tabindex="selectedTab === tab.id ? 0 : -1"
        type="button"
        role="tab"
        :aria-selected="selectedTab === tab.id"
        :class="{ active: selectedTab === tab.id }"
        @click="selectedTab = tab.id"
        @keydown="navigateTabs"
      >
        <span>{{ tab.label }}</span>
        <small v-if="tabCount(tab.id)">{{ tabCount(tab.id) }}</small>
      </button>
    </nav>

    <section v-if="selectedTab === 'overview'" id="buddy-tab-panel" class="buddy-tab-panel" role="tabpanel" :aria-labelledby="'buddy-tab-' + selectedTab" aria-label="Overview">
      <div class="buddy-overview-grid">
        <article class="buddy-surface buddy-observation-panel" aria-label="Latest observation">
          <header class="buddy-card-header">
            <div>
              <h3>Room view</h3>
              <p>{{ observationTime || "No image captured" }}</p>
            </div>
            <button
              class="control-button buddy-primary-button"
              type="button"
              :disabled="manualActionDisabled || !hasCapability('camera.capture')"
              @click="invokeByName('camera.capture')"
            >
              Capture image
            </button>
          </header>

          <div class="buddy-image-frame">
            <img
              v-if="observationImage"
              class="buddy-observation-image"
              :src="observationImage"
              alt="Latest image captured by Buddy"
            />
            <div v-else class="buddy-observation-empty">
              <span>Camera view will appear here</span>
            </div>
          </div>

          <footer class="buddy-view-footer">
            <span v-if="observationDirection">Facing {{ observationDirection }}</span>
            <span v-else>Latest camera image</span>
          </footer>

          <div v-if="lastAction && isReadCapability(lastAction.capability) && actionResultText" class="buddy-action-result">
            <span>{{ capabilityLabel(lastAction.capability) }}</span>
            <div>{{ actionResultText }}</div>
          </div>
        </article>

        <article class="buddy-surface buddy-head-panel" aria-label="Head control">
          <header class="buddy-card-header">
            <div>
              <h3>Move head</h3>
            </div>
            <span class="buddy-mode-chip">{{ deviceModeLabel }}</span>
          </header>

          <div class="buddy-look-controls" aria-label="Quick head movement">
            <button
              v-for="direction in lookDirections"
              :key="direction.id"
              class="buddy-look-button"
              type="button"
              :disabled="manualActionDisabled || !hasCapability('head.move')"
              :aria-label="'Move head ' + direction.id"
              @click="quickMove(direction.id)"
            >
              <span aria-hidden="true">{{ direction.icon }}</span>
              <small>{{ direction.label }}</small>
            </button>
          </div>

          <details v-if="hasCapability('head.observe')" class="buddy-more-controls buddy-observe-controls">
            <summary>Turn &amp; capture</summary>
            <div class="buddy-observe-action">
              <label>
                <span>Direction</span>
                <select v-model="formArguments['head.observe'].direction" aria-label="Observation direction">
                  <option v-for="direction in lookDirections" :key="direction.id" :value="direction.id">
                    {{ direction.label }}
                  </option>
                </select>
              </label>
              <button
                class="control-button"
                type="button"
                :disabled="manualActionDisabled || !hasCapability('camera.capture')"
                @click="runCapability(capability('head.observe'))"
              >
                Turn &amp; capture
              </button>
            </div>
          </details>

          <div class="buddy-measured-head" role="status">
            <span>Measured head</span>
            <strong v-if="measuredHeadPosition">Pan {{ formatDegrees(measuredHeadPosition.pan) }}° / Tilt {{ formatDegrees(measuredHeadPosition.tilt) }}°</strong>
            <strong v-else>Position unavailable</strong>
          </div>
          <div v-if="lastInteractionText" class="buddy-interaction-feedback" role="status">
            <span>Last interaction</span>
            <strong>{{ lastInteractionText }}</strong>
          </div>

          <div v-if="hasCapability('head.release') || hasCapability('head.hold')" class="buddy-guidance-controls">
            <div class="buddy-guidance-state" role="status">
              <span>Hand guidance</span>
              <strong>{{ guiding ? "Guiding by hand" : "Holding position" }}</strong>
            </div>
            <button
              v-if="hasCapability('head.release')"
              class="control-button"
              type="button"
              :disabled="manualActionDisabled || guiding"
              @click="invokeByName('head.release')"
            >
              Guide by hand
            </button>
            <button
              v-if="hasCapability('head.hold')"
              class="control-button"
              type="button"
              :disabled="manualActionDisabled || !guiding"
              @click="invokeByName('head.hold')"
            >
              Hold position
            </button>
          </div>

          <div v-if="capability('head.move')" class="buddy-head-form">
            <label class="buddy-axis-control">
              <span><b>Pan</b><input v-model.number="formArguments['head.move'].pan" type="number" min="-90" max="90" step="1" aria-label="Pan angle number" /></span>
              <input v-model.number="formArguments['head.move'].pan" type="range" min="-90" max="90" step="1" aria-label="Pan angle slider" />
            </label>
            <label class="buddy-axis-control">
              <span><b>Tilt</b><input v-model.number="formArguments['head.move'].tilt" type="number" min="5" max="85" step="1" aria-label="Tilt angle number" /></span>
              <input v-model.number="formArguments['head.move'].tilt" type="range" min="5" max="85" step="1" aria-label="Tilt angle slider" />
            </label>

            <details class="buddy-more-controls">
              <summary>Movement settings</summary>
              <div class="buddy-form-grid">
                <label>
                  <span>Move time (ms)</span>
                  <input v-model.number="formArguments['head.move'].moveTimeMs" type="number" min="250" max="3000" step="50" />
                </label>
                <label>
                  <span>Speed</span>
                  <input v-model.number="formArguments['head.move'].speed" type="number" min="0" max="100" step="1" />
                </label>
              </div>
            </details>

            <div class="buddy-head-actions">
              <button
                class="control-button buddy-primary-button"
                type="button"
                :disabled="manualActionDisabled"
                @click="runCapability(capability('head.move'))"
              >
                Move head
              </button>
              <button
                v-if="hasCapability('head.home')"
                class="control-button"
                type="button"
                :disabled="manualActionDisabled"
                @click="invokeByName('head.home')"
              >
                Center head
              </button>
            </div>
          </div>
          <div v-else class="buddy-capabilities-empty">Head movement is not available.</div>
        </article>
      </div>
    </section>

    <section v-else-if="selectedTab === 'permissions'" id="buddy-tab-panel" class="buddy-tab-panel" role="tabpanel" :aria-labelledby="'buddy-tab-' + selectedTab" aria-label="Agent permissions">
      <div v-if="capabilities.length" class="buddy-permission-list">
        <article
          v-for="item in capabilities"
          :key="item.name"
          class="buddy-capability buddy-permission-row"
          :data-capability="item.name"
        >
          <div class="buddy-permission-copy">
            <h3>{{ capabilityLabel(item.name) }}</h3>
            <p>{{ item.description }}</p>
            <small v-if="item.requires?.length">Requires {{ item.requires.map(capabilityLabel).join(", ") }}</small>
          </div>
          <label class="buddy-permission-toggle">
            <input
              type="checkbox"
              :checked="item.allowed === true"
              :disabled="actionInFlight || !statusFresh || !buddyStatus?.deviceId"
              :aria-label="permissionAriaLabel(item)"
              @change="controller.setPermission(item.name, $event.target.checked)"
            />
            <span>{{ item.allowed ? "Allowed" : "Not allowed" }}</span>
          </label>
        </article>
      </div>
      <div v-else class="buddy-empty-state">No Agent capabilities reported by this device.</div>
    </section>

    <section v-else id="buddy-tab-panel" class="buddy-tab-panel" role="tabpanel" :aria-labelledby="'buddy-tab-' + selectedTab" :aria-label="activeTabLabel">
      <section v-if="selectedTab === 'lighting'" class="buddy-lighting-console" aria-label="Rear lightbars">
        <article class="buddy-lighting-card">
          <header class="buddy-lighting-heading">
            <h3>Rear lightbars</h3>
          </header>
          <div class="buddy-lightbar-diagram" :data-has-colors="hasDriverLightColors">
            <template v-for="bar in lightbarRows" :key="bar.index">
              <span class="buddy-lightbar-label">{{ bar.label }}</span>
              <div class="buddy-lightbar-row" :aria-label="'Rear lightbar ' + bar.label">
                <span
                  v-for="(color, ledIndex) in bar.colors"
                  :key="ledIndex"
                  class="buddy-light"
                  :data-led-index="ledIndex"
                  :data-driver-color="color || ''"
                  :style="{ backgroundColor: color || 'var(--surface-muted)' }"
                ></span>
              </div>
            </template>
          </div>

          <div class="buddy-lighting-current" role="status" aria-live="polite">
            <strong>{{ lightingStatusLabel }}</strong>
            <small v-if="lightingStatusDetail">{{ lightingStatusDetail }}</small>
            <small v-if="!hasDriverLightColors">Waiting for light status</small>
          </div>

          <div v-if="hasCapability('led.express') || hasCapability('led.resume')" class="buddy-lighting-controls">
            <label
              v-if="hasCapability('led.express') && hasCapability('led.resume')"
              class="buddy-lighting-agent-access"
            >
              <input
                type="checkbox"
                :checked="agentExpressionsAllowed"
                :disabled="actionInFlight || !statusFresh || !buddyStatus?.deviceId"
                aria-label="Allow Agent light expressions"
                @change="setAgentExpressionAccess($event.target.checked)"
              />
              <span>Agent expressions</span>
            </label>

            <div v-if="hasCapability('led.express')" class="buddy-emotion-controls">
              <div class="buddy-emotion-buttons" role="group" aria-label="Choose an emotion">
                <button
                  v-for="emotion in lightingEmotions"
                  :key="emotion.id"
                  class="buddy-emotion-button"
                  type="button"
                  :aria-pressed="lightingState.emotion === emotion.id"
                  :disabled="manualActionDisabled"
                  @click="expressEmotion(emotion.id)"
                >
                  {{ emotion.label }}
                </button>
              </div>
              <div class="buddy-emotion-settings">
                <label>
                  <span>Intensity <b>{{ Math.round(emotionIntensity * 100) }}%</b></span>
                  <input v-model.number="emotionIntensity" type="range" min="0.1" max="1" step="0.1" aria-label="Emotion intensity" />
                </label>
                <label>
                  <span>Duration (s)</span>
                  <input v-model.number="emotionDurationSeconds" type="number" min="1" max="60" step="1" aria-label="Emotion duration (s)" />
                </label>
                <button
                  v-if="hasCapability('led.resume')"
                  class="control-button"
                  type="button"
                  :disabled="manualActionDisabled"
                  @click="resumeLighting"
                >
                  Resume automatic
                </button>
              </div>
            </div>

            <button
              v-else-if="hasCapability('led.resume')"
              class="control-button"
              type="button"
              :disabled="manualActionDisabled"
              @click="resumeLighting"
            >
              Resume automatic
            </button>
          </div>

          <details v-if="capability('led.set')" class="buddy-manual-rgb">
            <summary>Manual RGB</summary>
            <article class="buddy-capability buddy-module-card buddy-manual-rgb-card" :data-capability="'led.set'">
              <div class="buddy-form-grid">
                <label>
                  <span>Color</span>
                  <input
                    type="color"
                    :value="colorHex(formArguments['led.set'].color)"
                    aria-label="LED color"
                    @input="setColor('led.set', 'color', $event.target.value)"
                  />
                </label>
                <label>
                  <span>Rear lightbar</span>
                  <select v-model="formArguments['led.set'].strip" aria-label="Rear lightbar">
                    <option value="">All rear lightbars</option>
                    <option :value="0">Rear lightbar A</option>
                    <option :value="1">Rear lightbar B</option>
                  </select>
                </label>
                <label>
                  <span>LED index</span>
                  <input
                    v-model.number="formArguments['led.set'].index"
                    type="number"
                    min="0"
                    max="5"
                    step="1"
                    aria-label="LED index"
                    :disabled="formArguments['led.set'].strip === ''"
                  />
                </label>
                <button
                  class="control-button buddy-primary-button"
                  type="button"
                  :disabled="manualActionDisabled"
                  @click="runCapability(capability('led.set'))"
                >
                  Set LEDs
                </button>
              </div>
              <details class="buddy-advanced-json">
                <summary>Advanced JSON</summary>
                <textarea
                  v-model="advancedJson['led.set']"
                  rows="3"
                  spellcheck="false"
                  placeholder="Leave empty to use the controls above."
                  aria-label="led.set advanced JSON arguments"
                ></textarea>
              </details>
            </article>
          </details>
        </article>
      </section>

      <div v-if="visibleCapabilities.length" class="buddy-module-grid">
        <article
          v-for="item in visibleCapabilities"
          :key="item.name"
          class="buddy-capability buddy-module-card"
          :data-capability="item.name"
        >
          <header class="buddy-module-heading">
            <div>
              <h3>{{ capabilityLabel(item.name) }}</h3>
              <p>{{ item.description }}</p>
              <code>{{ item.name }}</code>
            </div>
            <button
              class="control-button buddy-module-action"
              type="button"
              :disabled="manualActionDisabled"
              @click="runCapability(item)"
            >
              {{ manualActionLabel(item) }}
            </button>
          </header>

          <div class="buddy-form-grid">
            <template v-if="item.name === 'touch.read'">
              <label>
                <span>Touch zone (3 zones)</span>
                <select v-model="formArguments[item.name].zone">
                  <option value="">All zones</option>
                  <option :value="0">Zone 0 of 3</option>
                  <option :value="1">Zone 1 of 3</option>
                  <option :value="2">Zone 2 of 3</option>
                </select>
              </label>
            </template>

            <template v-else-if="item.name === 'infrared.send'">
              <label>
                <span>NEC address (0–255)</span>
                <input v-model.number="formArguments[item.name].address" type="number" min="0" max="255" step="1" />
              </label>
              <label>
                <span>NEC data (0–255)</span>
                <input v-model.number="formArguments[item.name].data" type="number" min="0" max="255" step="1" />
              </label>
            </template>

            <template v-else-if="item.name === 'speaker.tone'">
              <label>
                <span>Frequency (Hz)</span>
                <input v-model.number="formArguments[item.name].frequency" type="number" min="200" max="4000" step="10" />
              </label>
              <label>
                <span>Duration (ms)</span>
                <input v-model.number="formArguments[item.name].durationMs" type="number" min="1" max="500" step="10" />
              </label>
            </template>

            <template v-else-if="item.name === 'display.text'">
              <label class="buddy-wide-field">
                <span>Display text</span>
                <textarea v-model="formArguments[item.name].text" rows="2" maxlength="240" aria-label="Display text" />
              </label>
              <label>
                <span>Text color</span>
                <input
                  type="color"
                  :value="colorHex(formArguments[item.name].color)"
                  aria-label="Display text color"
                  @input="setColor(item.name, 'color', $event.target.value)"
                />
              </label>
            </template>

            <template v-else-if="usesGenericForm(item)">
              <label v-for="field in genericFields(item)" :key="field.name" :class="{ 'buddy-wide-field': field.type === 'array' || field.type === 'object' }">
                <span>{{ field.label }}</span>
                <select v-if="field.enum" v-model="formArguments[item.name][field.name]">
                  <option v-if="!field.required" value="">Any</option>
                  <option v-for="choice in field.enum" :key="choice" :value="choice">{{ choice }}</option>
                </select>
                <template v-else-if="field.type === 'number' || field.type === 'integer'">
                  <input
                    v-model.number="formArguments[item.name][field.name]"
                    type="number"
                    :min="field.minimum"
                    :max="field.maximum"
                    :step="field.type === 'integer' ? 1 : 'any'"
                    :required="field.required"
                    :aria-label="field.label"
                  />
                </template>
                <input
                  v-else-if="field.color"
                  type="color"
                  :value="colorHex(formArguments[item.name][field.name])"
                  :aria-label="field.label"
                  @input="setColor(item.name, field.name, $event.target.value)"
                />
                <input
                  v-else-if="field.type === 'boolean'"
                  v-model="formArguments[item.name][field.name]"
                  type="checkbox"
                  :aria-label="field.label"
                />
                <textarea
                  v-else-if="field.type === 'array' || field.type === 'object'"
                  v-model="jsonFieldInputs[item.name][field.name]"
                  rows="3"
                  spellcheck="false"
                  :aria-label="field.label + ' as JSON'"
                />
                <textarea
                  v-else-if="field.maxLength > 80"
                  v-model="formArguments[item.name][field.name]"
                  rows="3"
                  :maxlength="field.maxLength"
                  :required="field.required"
                  :aria-label="field.label"
                />
                <input
                  v-else
                  v-model="formArguments[item.name][field.name]"
                  type="text"
                  :maxlength="field.maxLength"
                  :required="field.required"
                  :aria-label="field.label"
                />
              </label>
            </template>
          </div>

          <details class="buddy-advanced-json">
            <summary>Advanced JSON</summary>
            <textarea
              v-model="advancedJson[item.name]"
              rows="3"
              spellcheck="false"
              placeholder="Leave empty to use the controls above."
              :aria-label="item.name + ' advanced JSON arguments'"
            ></textarea>
          </details>
        </article>
      </div>
      <div v-else-if="selectedTab !== 'lighting'" class="buddy-empty-state">{{ activeTabEmptyMessage }}</div>
    </section>
  </section>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  controller: { type: Object, required: true },
  management: { type: Object, required: true },
});

defineEmits(["save-management-token", "clear-management-token"]);

const {
  buddyStatus,
  dashboardStatus,
  actionInFlight,
  statusFresh,
  statusLabel,
  capabilities,
  observation,
  lastAction,
} = props.controller.state;
const { token: managementToken, input: managementInput, accessRequired } = props.management.state;
const formArguments = ref({});
const jsonFieldInputs = ref({});
const advancedJson = ref({});
const emotionIntensity = ref(0.5);
const emotionDurationSeconds = ref(8);
const selectedTab = ref("overview");
const dashboardTabs = [
  { id: "overview", label: "Overview" },
  { id: "lighting", label: "Lights & display" },
  { id: "sensors", label: "Sensors" },
  { id: "infrared", label: "Infrared" },
  { id: "extensions", label: "Extensions" },
  { id: "permissions", label: "Agent permissions" },
];
const lookDirections = [
  { id: "left", label: "Left", icon: "←" },
  { id: "center", label: "Center", icon: "◎" },
  { id: "right", label: "Right", icon: "→" },
];
const lightingEmotions = [
  { id: "happy", label: "Happy" },
  { id: "curious", label: "Curious" },
  { id: "thinking", label: "Thinking" },
  { id: "listening", label: "Listening" },
  { id: "speaking", label: "Speaking" },
  { id: "concerned", label: "Concerned" },
  { id: "calm", label: "Calm" },
];

const namedCapabilityGroups = {
  lighting: new Set(["led.set", "led.express", "led.resume", "display.text", "speaker.tone"]),
  sensors: new Set(["touch.read", "power.read", "ambient.read", "imu.read", "nfc.detect"]),
  infrared: new Set(["infrared.send", "infrared.read"]),
};
const builtInCapabilityNames = new Set([
  "head.move", "head.home", "head.release", "head.hold", "camera.capture", "head.observe",
  "led.set", "led.express", "led.resume", "display.text", "speaker.tone", "touch.read", "power.read",
  "ambient.read", "imu.read", "nfc.detect", "infrared.send", "infrared.read",
  "device.wake", "device.sleep", "device.shutdown",
]);

const managementTokenInput = computed({
  get: () => managementInput.value,
  set: (value) => { managementInput.value = value; },
});
const managementTokenStatus = computed(() => {
  if (accessRequired.value) return "Rejected";
  return managementToken.value ? "Saved" : "Required for controls";
});
const observationImage = computed(() => {
  const image = observation.value?.result?.image;
  if (!image?.mimeType || !image?.data) return "";
  return `data:${image.mimeType};base64,${image.data}`;
});
const observationTime = computed(() => {
  const receivedAt = observation.value?.receivedAt;
  if (receivedAt) return `Received ${formatObservationTime(receivedAt)}`;

  const legacyTime = observation.value?.capturedAt
    || observation.value?.timestamp
    || observation.value?.result?.capturedAt;
  return legacyTime ? `Recorded ${formatObservationTime(legacyTime)}` : "";
});
const observationDirection = computed(() => {
  const direction = observation.value?.result?.direction || observation.value?.direction;
  if (!direction) return "";
  return direction === "center" ? "center" : direction;
});
const agentEnabled = computed(() => buddyStatus.value?.agentEnabled === true);
const deviceMode = computed(() => {
  if (!statusFresh.value) return "unknown";
  const state = buddyStatus.value?.state;
  if (state && typeof state === "object" && typeof state.mode === "string") return state.mode;
  if (state && typeof state === "object" && typeof state.status === "string") return state.status;
  if (typeof state === "string") return state;
  return "unknown";
});
const deviceModeLabel = computed(() => ({
  booting: "Booting",
  connecting: "Connecting",
  ready: "Ready",
  sleeping: "Sleeping",
  shutting_down: "Powering off",
  acting: "Acting",
  error: "Error",
  unknown: "Unknown",
}[deviceMode.value] || humanizeName(deviceMode.value)));
const deviceSleeping = computed(() => deviceMode.value === "sleeping");
const devicePoweringOff = computed(() => deviceMode.value === "shutting_down");
const serviceBusy = computed(() => statusFresh.value && buddyStatus.value?.actionInProgress === true);
const busy = computed(() => actionInFlight.value || !statusFresh.value || serviceBusy.value);
const deviceState = computed(() => buddyStatus.value?.state && typeof buddyStatus.value.state === "object"
  ? buddyStatus.value.state
  : {});
const buddyFaultText = computed(() => {
  if (!statusFresh.value) return "";
  const reportedFaults = deviceState.value.faults;
  const faults = Array.isArray(reportedFaults)
    ? reportedFaults
    : reportedFaults && typeof reportedFaults === "object"
      ? Object.entries(reportedFaults).map(([component, fault]) =>
        fault && typeof fault === "object" ? { component, ...fault } : { component, message: fault })
      : [];
  const messages = faults.map((fault) => {
    if (typeof fault === "string") return fault;
    if (!fault || typeof fault !== "object") return "";
    const component = typeof fault.component === "string" ? humanizeName(fault.component) : "";
    const message = typeof fault.message === "string" ? fault.message : "";
    return component && message ? `${component}: ${message}` : message || component;
  });
  const invocationError = buddyStatus.value?.lastInvocationError;
  const invocationMessage = typeof invocationError === "string"
    ? invocationError
    : invocationError && typeof invocationError.message === "string"
      ? invocationError.message
      : "";
  const uniqueMessages = [...new Set([...messages, invocationMessage].filter(Boolean))];
  return uniqueMessages.join(" · ");
});
const lightingState = computed(() => deviceState.value.lighting && typeof deviceState.value.lighting === "object"
  ? deviceState.value.lighting
  : {});
const lightbarRows = computed(() => [0, 1].map((index) => {
  const strip = lightingState.value.strips?.[index];
  return {
    index,
    label: index === 0 ? "A" : "B",
    colors: Array.from({ length: 6 }, (_, ledIndex) => tripletToHex(strip?.[ledIndex])),
  };
}));
const hasDriverLightColors = computed(() => lightbarRows.value.some((bar) => bar.colors.some(Boolean)));
const lightingStatusLabel = computed(() => {
  const source = lightingState.value.source;
  if (source === "lifecycle") return "Automatic";
  if (source === "manual") return "Manual";
  if (source === "touch") return "Touch";
  if (source === "emotion") {
    const emotion = lightingState.value.emotion || lightingState.value.pattern;
    return lightingEmotions.find((item) => item.id === emotion)?.label || humanizeName(emotion || "Emotion");
  }
  return typeof source === "string" && source ? humanizeName(source) : "Lighting";
});
const lightingStatusDetail = computed(() => {
  const details = [];
  if (Number.isFinite(lightingState.value.intensity)) {
    details.push(`${Math.round(lightingState.value.intensity * 100)}%`);
  }
  if (Number.isFinite(lightingState.value.remainingMs) && lightingState.value.remainingMs > 0) {
    details.push(formatDuration(lightingState.value.remainingMs));
  }
  return details.join(" · ");
});
const agentExpressionsAllowed = computed(() => {
  const express = capability("led.express");
  const resume = capability("led.resume");
  return express?.allowed === true && resume?.allowed === true;
});
const guiding = computed(() => deviceState.value.guiding === true);
const measuredHeadPosition = computed(() => {
  if (!statusFresh.value) return null;
  const head = deviceState.value.head;
  if (!head || typeof head !== "object") return null;
  if (!Number.isFinite(head.pan) || !Number.isFinite(head.tilt)) return null;
  return { pan: head.pan, tilt: head.tilt };
});
const lastInteractionText = computed(() => {
  if (!statusFresh.value) return "";
  const interaction = deviceState.value.lastInteraction;
  if (!interaction || typeof interaction !== "object") return "";
  if (interaction.type === "touch" && Array.isArray(interaction.zones)) {
    return `Touch zones ${interaction.zones.filter(Number.isInteger).join(", ")}`;
  }
  if (interaction.type === "head.moved_by_hand"
    && Number.isFinite(interaction.pan) && Number.isFinite(interaction.tilt)) {
    return `Moved by hand · Pan ${formatDegrees(interaction.pan)}° / Tilt ${formatDegrees(interaction.tilt)}°`;
  }
  return "";
});
const manualActionDisabled = computed(() =>
  busy.value || !buddyStatus.value?.connected || deviceSleeping.value || devicePoweringOff.value,
);
const activeActionLabel = computed(() => {
  const name = buddyStatus.value?.activeAction?.capability;
  return typeof name === "string" ? capabilityLabel(name) : "";
});
const activeActionText = computed(() => activeActionLabel.value
  ? `Agent is using ${activeActionLabel.value}`
  : "Agent is using Buddy");
const stateDetail = computed(() => {
  if (!statusFresh.value) return "";
  const state = buddyStatus.value?.state;
  if (!state || typeof state !== "object") return "";
  if (typeof state.action === "string" && state.action !== "idle") {
    return capabilityLabel(state.action);
  }
  if (typeof state.status === "string" && state.status !== deviceMode.value) {
    return state.status;
  }
  return "";
});
const enabledCapabilityCount = computed(() => capabilities.value.filter((capability) => capability.allowed).length);
const visibleCapabilities = computed(() => {
  const group = namedCapabilityGroups[selectedTab.value];
  if (group) {
    return capabilities.value.filter((item) => group.has(item.name)
      && !(selectedTab.value === "lighting" && ["led.set", "led.express", "led.resume"].includes(item.name)));
  }
  if (selectedTab.value === "extensions") {
    return capabilities.value.filter((item) => !builtInCapabilityNames.has(item.name));
  }
  return [];
});
const activeTabLabel = computed(() => dashboardTabs.find((tab) => tab.id === selectedTab.value)?.label || "Extensions");
const activeTabEmptyMessage = computed(() => selectedTab.value === "extensions"
  ? "No extension modules are currently available."
  : "No controls reported in this section.");
const actionResultText = computed(() => {
  const result = lastAction.value?.result;
  if (result === null || result === undefined) return "";
  if (Array.isArray(result)) return result.map(formatReadingValue).join(" · ");
  if (typeof result !== "object") return String(result);
  return Object.entries(result)
    .filter(([key]) => key !== "image")
    .map(([key, value]) => `${humanizeName(key)}: ${formatReadingValue(value)}`)
    .join(" · ");
});

watch(capabilities, initializeCapabilityForms, { immediate: true, flush: "sync" });

function capability(name) {
  return capabilities.value.find((item) => item.name === name);
}

function hasCapability(name) {
  return Boolean(capability(name));
}

function tabCount(tabId) {
  if (tabId === "permissions") return `${enabledCapabilityCount.value}/${capabilities.value.length}`;
  if (tabId === "overview") return "";
  const group = namedCapabilityGroups[tabId];
  if (group) return String(capabilities.value.filter((item) => group.has(item.name)).length || "");
  if (tabId === "extensions") {
    return String(capabilities.value.filter((item) => !builtInCapabilityNames.has(item.name)).length || "");
  }
  return "";
}

function navigateTabs(event) {
  const currentIndex = dashboardTabs.findIndex((tab) => tab.id === selectedTab.value);
  let nextIndex;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % dashboardTabs.length;
  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + dashboardTabs.length) % dashboardTabs.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = dashboardTabs.length - 1;
  else return;

  event.preventDefault();
  selectedTab.value = dashboardTabs[nextIndex].id;
  event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[nextIndex]?.focus();
}

function capabilityLabel(name) {
  const labels = {
    "head.move": "Move head",
    "head.home": "Center head",
    "head.release": "Guide by hand",
    "head.hold": "Hold position",
    "head.observe": "Look around",
    "camera.capture": "Capture image",
    "device.wake": "Wake device",
    "device.sleep": "Sleep device",
    "device.shutdown": "Power off",
    "led.set": "Rear lightbars",
    "led.express": "Agent light expressions",
    "led.resume": "Resume automatic lighting",
    "display.text": "Display message",
    "speaker.tone": "Play tone",
    "touch.read": "3 touch zones",
    "power.read": "Power readings",
    "ambient.read": "Ambient light",
    "imu.read": "Motion sensor",
    "infrared.send": "Send infrared",
    "infrared.read": "Receive infrared",
    "nfc.detect": "Detect NFC tag",
  };
  return labels[name] || humanizeName(name.replaceAll(".", " "));
}

function formatDegrees(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatObservationTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function tripletToHex(pixel) {
  if (!Array.isArray(pixel) || pixel.length !== 3
    || pixel.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return `#${pixel.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function formatDuration(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function expressEmotion(emotion) {
  const item = capability("led.express");
  if (!item) return;
  runCapability(item, {
    emotion,
    intensity: emotionIntensity.value,
    durationMs: emotionDurationSeconds.value * 1000,
  });
}

function resumeLighting() {
  const item = capability("led.resume");
  if (item) runCapability(item, {});
}

async function setAgentExpressionAccess(allowed) {
  await props.controller.setPermission("led.express", allowed);
  await props.controller.setPermission("led.resume", allowed);
}

function isReadCapability(name) {
  return name.endsWith(".read") || name === "touch.read" || name === "nfc.detect";
}

function formatReadingValue(value) {
  if (Array.isArray(value)) return value.map(formatReadingValue).join(", ");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${humanizeName(key)} ${formatReadingValue(item)}`)
      .join(", ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function permissionAriaLabel(item) {
  const action = item.allowed ? "Revoke" : "Allow";
  return `${action} ${capabilityLabel(item.name)} for Agent`;
}

function invokeByName(name) {
  const item = capability(name);
  if (!item) {
    props.controller.notify(`${capabilityLabel(name)} is not available on this device.`);
    return;
  }
  runCapability(item);
}

function quickMove(direction) {
  const item = capability("head.move");
  if (!item) return;
  const panByDirection = { left: -45, center: 0, right: 45 };
  const pan = panByDirection[direction];
  if (pan === undefined) return;
  runCapability(item, { pan, moveTimeMs: 800, speed: 20 });
}

function initializeCapabilityForms(items) {
  const nextArguments = { ...formArguments.value };
  const nextJsonInputs = { ...jsonFieldInputs.value };
  const nextAdvancedJson = { ...advancedJson.value };

  for (const capability of items) {
    if (Object.hasOwn(nextArguments, capability.name)) continue;
    const defaults = defaultArguments(capability);
    nextArguments[capability.name] = defaults.arguments;
    nextJsonInputs[capability.name] = defaults.jsonFields;
    nextAdvancedJson[capability.name] = "";
  }

  formArguments.value = nextArguments;
  jsonFieldInputs.value = nextJsonInputs;
  advancedJson.value = nextAdvancedJson;
}

function defaultArguments(capability) {
  const knownDefaults = {
    "head.move": { pan: 0, tilt: 45, moveTimeMs: 800, speed: 20 },
    "head.home": {},
    "camera.capture": {},
    "head.observe": { direction: "center", tilt: 45, settleMs: 250 },
    "led.set": { color: 0xffffff, strip: "", index: "" },
    "touch.read": { zone: "" },
    "power.read": {},
    "infrared.send": { address: "", data: "" },
    "infrared.read": {},
    "nfc.detect": {},
    "speaker.tone": { frequency: 880, durationMs: 100 },
    "display.text": { text: "", color: 0xffffff },
    "ambient.read": {},
    "imu.read": {},
    "device.wake": {},
    "device.sleep": {},
    "device.shutdown": {},
  };
  if (Object.hasOwn(knownDefaults, capability.name)) {
    return { arguments: { ...knownDefaults[capability.name] }, jsonFields: {} };
  }

  const properties = capability.inputSchema?.properties || {};
  const required = new Set(capability.inputSchema?.required || []);
  const args = {};
  const jsonFields = {};
  for (const [name, schema] of Object.entries(properties)) {
    const value = defaultFieldValue(schema, required.has(name));
    if (schema.type === "object" || schema.type === "array") {
      jsonFields[name] = JSON.stringify(value, null, 2);
    } else {
      args[name] = value;
    }
  }
  return { arguments: args, jsonFields };
}

function defaultFieldValue(schema, required) {
  if (Object.hasOwn(schema, "default")) return schema.default;
  if (Array.isArray(schema.enum)) return required ? schema.enum[0] : "";
  if (schema.type === "integer" || schema.type === "number") {
    if (!required) return "";
    const minimum = schema.minimum ?? 0;
    const maximum = schema.maximum;
    if (maximum === undefined) return minimum;
    return Math.max(minimum, Math.min(0, maximum));
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return "";
}

function usesGenericForm(capability) {
  return genericFields(capability).length > 0;
}

function genericFields(capability) {
  const schema = capability.inputSchema || {};
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  return Object.entries(properties).map(([name, field]) => ({
    name,
    label: field.title || humanizeName(name),
    type: field.type || "string",
    enum: Array.isArray(field.enum) ? field.enum : undefined,
    minimum: field.minimum,
    maximum: field.maximum,
    maxLength: field.maxLength,
    color: field.format === "color" || (/color/i.test(name) && field.maximum >= 0xffffff),
    required: required.has(name),
  }));
}

function humanizeName(value) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function colorHex(value) {
  const color = Number.isFinite(Number(value)) ? Number(value) : 0xffffff;
  return `#${Math.max(0, Math.min(0xffffff, color)).toString(16).padStart(6, "0")}`;
}

function setColor(capabilityName, fieldName, hexColor) {
  formArguments.value[capabilityName][fieldName] = Number.parseInt(hexColor.slice(1), 16);
}

function collectVisualArguments(capability) {
  const args = { ...formArguments.value[capability.name] };
  const properties = capability.inputSchema?.properties || {};
  for (const [name, schema] of Object.entries(properties)) {
    if (schema.type !== "object" && schema.type !== "array") continue;
    try {
      args[name] = JSON.parse(jsonFieldInputs.value[capability.name][name] || (schema.type === "array" ? "[]" : "{}"));
    } catch {
      throw new Error(`${humanizeName(name)} must be valid JSON.`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    if (value === "" || value === null || value === undefined) delete args[name];
  }
  return args;
}

function manualActionLabel(capability) {
  const labels = {
    "head.move": "Move head",
    "head.home": "Home",
    "camera.capture": "Capture",
    "head.observe": "Observe",
    "led.set": "Set LEDs",
    "infrared.send": "Send NEC",
    "speaker.tone": "Play tone",
    "display.text": "Display text",
    "device.wake": "Wake device",
    "device.sleep": "Sleep device",
    "device.shutdown": "Power off",
  };
  if (labels[capability.name]) return labels[capability.name];
  return capability.name.endsWith(".read") || capability.name === "nfc.detect" ? "Read" : "Run manually";
}

function runCapability(capability, visualArguments) {
  if (!capability) return;
  try {
    const rawAdvancedJson = advancedJson.value[capability.name]?.trim();
    const args = visualArguments || (rawAdvancedJson
      ? JSON.parse(rawAdvancedJson)
      : collectVisualArguments(capability));
    if (!args || Array.isArray(args) || typeof args !== "object") {
      throw new Error("Arguments must be a JSON object.");
    }
    validateArguments(capability, args);
    void props.controller.invoke(capability.name, args);
  } catch (error) {
    props.controller.notify(error instanceof Error ? error.message : String(error));
  }
}

function validateArguments(capability, args) {
  const schema = capability.inputSchema || {};
  const properties = schema.properties || {};
  const required = schema.required || [];
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === "") {
      throw new Error(`${humanizeName(name)} is required.`);
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const hasAllowedChoice = schema.anyOf.some((choice) =>
      (choice.required || []).some((name) => args[name] !== undefined && args[name] !== null && args[name] !== ""),
    );
    if (!hasAllowedChoice) throw new Error("Set at least one head axis.");
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(args)) {
      if (!Object.hasOwn(properties, name)) throw new Error(`Unknown argument: ${name}.`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const field = properties[name];
    if (!field || value === "" || value === undefined || value === null) continue;
    if (field.enum && !field.enum.includes(value)) throw new Error(`${humanizeName(name)} is not a supported value.`);
    if (field.type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
      throw new Error(`${humanizeName(name)} must be a whole number.`);
    }
    if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`${humanizeName(name)} must be a number.`);
    }
    if (typeof value === "number" && field.minimum !== undefined && value < field.minimum) {
      throw new Error(`${humanizeName(name)} must be at least ${field.minimum}.`);
    }
    if (typeof value === "number" && field.maximum !== undefined && value > field.maximum) {
      throw new Error(`${humanizeName(name)} must be at most ${field.maximum}.`);
    }
    if (typeof value === "string" && field.minLength !== undefined && value.length < field.minLength) {
      throw new Error(`${humanizeName(name)} is too short.`);
    }
    if (typeof value === "string" && field.maxLength !== undefined && value.length > field.maxLength) {
      throw new Error(`${humanizeName(name)} is too long.`);
    }
  }
  if (capability.name === "led.set" && args.index !== undefined && args.strip === undefined) {
    throw new Error("Choose a strip before setting one LED index.");
  }
}

onMounted(() => {
  props.controller.startPolling();
  void props.controller.refresh();
});

onBeforeUnmount(() => {
  props.controller.stopPolling();
});
</script>

<style scoped>
.buddy-console {
  gap: 0;
  min-width: 0;
  color: var(--text);
}

.buddy-console-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 18px;
}

.buddy-heading {
  min-width: 0;
}

.buddy-eyebrow {
  color: var(--subtle);
  font: 10px var(--font-ui);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.buddy-heading h2 {
  margin: 4px 0 10px;
  color: var(--text);
  font: 42px/1 var(--font-display);
}

.buddy-device-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.buddy-connect-state,
.buddy-mode-state {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 26px;
  border-radius: 99px;
  background: var(--surface-muted);
  padding: 0 10px;
  color: var(--muted);
  font: 11px var(--font-ui);
}

.buddy-connect-state i,
.buddy-busy-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--subtle);
}

.buddy-connect-state.online i {
  background: var(--ok);
}

.buddy-connect-state.online {
  color: var(--text);
}

.buddy-mode-state {
  gap: 6px;
  background: var(--aqua-soft);
  color: var(--accent-2);
}

.buddy-mode-state > span {
  opacity: 0.7;
}

.buddy-mode-state[data-mode="sleeping"] {
  background: var(--warm-soft);
  color: var(--warning);
}

.buddy-mode-state[data-mode="acting"] {
  background: var(--accent-soft);
  color: var(--accent);
}

.buddy-mode-state[data-mode="error"] {
  background: var(--rose-soft);
  color: var(--danger);
}

.buddy-device-summary code {
  color: var(--subtle);
  font: 10px var(--font-ui);
}

.buddy-state-detail {
  margin: 7px 0 0;
  color: var(--muted);
  font: 11px var(--font-ui);
}

.buddy-fault-state {
  margin: 7px 0 0;
  color: var(--danger);
  font: 11px var(--font-ui);
}

.buddy-admin-card {
  flex: 0 1 430px;
  margin: 0;
}

.buddy-command-bar {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.buddy-command-group {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  padding: 12px 14px;
}

.buddy-command-copy {
  display: grid;
  gap: 4px;
}

.buddy-command-copy span {
  color: var(--muted);
  font: 10px var(--font-ui);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.buddy-command-copy strong {
  color: var(--text);
  font: 14px var(--font-ui);
}

.buddy-command-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.buddy-command-actions {
  display: grid;
  justify-items: end;
  gap: 5px;
}

.buddy-power-off-note {
  color: var(--muted);
  font: 9px/1.35 var(--font-ui);
  text-align: right;
}

.buddy-danger-button {
  border-color: var(--danger);
  color: var(--danger);
}

.buddy-danger-button:hover:not(:disabled) {
  background: var(--rose-soft);
  color: var(--danger);
}

.buddy-command-group .control-button,
.buddy-head-actions .control-button,
.buddy-module-action,
.buddy-card-header > .control-button {
  min-height: 36px;
  padding: 0 13px;
  font-size: 11px;
}

.buddy-primary-button {
  background: var(--accent);
  color: white;
}

.buddy-primary-button:hover {
  background: #1d4ed8;
  color: white;
}

.buddy-active-action {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(37, 99, 235, 0.18);
  border-radius: 8px;
  background: var(--accent-soft);
  padding: 9px 12px;
  color: var(--accent);
  font: 11px var(--font-ui);
}

.buddy-active-action .buddy-busy-dot {
  background: var(--accent);
  animation: buddy-pulse 1.2s ease-in-out infinite;
}

@keyframes buddy-pulse {
  50% { opacity: 0.35; }
}

.buddy-dashboard-status {
  min-height: 16px;
  margin: 0 0 8px;
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-tabs {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
  margin-bottom: 16px;
  scrollbar-width: thin;
}

.buddy-tabs button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  padding: 0 12px;
  color: var(--muted);
  cursor: pointer;
  font: 11px var(--font-ui);
}

.buddy-tabs button:hover,
.buddy-tabs button.active {
  color: var(--text);
}

.buddy-tabs button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -3px;
}

.buddy-tabs button.active {
  border-bottom-color: var(--accent);
}

.buddy-tabs button small {
  color: var(--subtle);
  font-size: 9px;
}

.buddy-tab-panel {
  min-width: 0;
}

.buddy-overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.8fr);
  align-items: start;
  gap: 14px;
}

.buddy-surface,
.buddy-module-card,
.buddy-permission-row {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}

.buddy-surface {
  padding: 16px;
}

.buddy-card-header,
.buddy-module-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.buddy-card-header {
  margin-bottom: 13px;
}

.buddy-card-header h3,
.buddy-module-heading h3,
.buddy-permission-copy h3 {
  margin: 0;
  color: var(--text);
  font: 14px var(--font-ui);
}

.buddy-card-header p,
.buddy-module-heading p,
.buddy-permission-copy p {
  margin: 4px 0 0;
  color: var(--muted);
  font: 10px/1.45 var(--font-ui);
}

.buddy-card-header > div {
  min-width: 0;
}

.buddy-card-header > div p {
  overflow-wrap: anywhere;
}

.buddy-image-frame {
  display: grid;
  min-height: 270px;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  place-items: center;
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(15, 118, 110, 0.04), transparent 50%),
    var(--surface-muted);
}

.buddy-observation-image {
  display: block;
  width: 100%;
  height: 100%;
  max-height: 510px;
  object-fit: contain;
}

.buddy-observation-empty {
  display: grid;
  place-items: center;
  color: var(--subtle);
  font: 11px var(--font-ui);
}

.buddy-view-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-view-footer span:last-child {
  color: var(--subtle);
}

.buddy-action-result {
  margin-top: 14px;
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-action-result pre,
.buddy-advanced-json textarea {
  max-height: 180px;
  overflow: auto;
  margin: 7px 0 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-muted);
  padding: 9px;
  color: var(--text);
  font: 10px/1.5 var(--font-ui);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.buddy-mode-chip {
  border-radius: 99px;
  background: var(--surface-muted);
  padding: 5px 9px;
  color: var(--muted);
  font: 9px var(--font-ui);
}

.buddy-measured-head,
.buddy-interaction-feedback,
.buddy-guidance-state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-measured-head strong,
.buddy-interaction-feedback strong,
.buddy-guidance-state strong {
  color: var(--text);
  font-weight: 500;
  text-align: right;
}

.buddy-interaction-feedback {
  margin-top: 8px;
}

.buddy-guidance-controls {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
}

.buddy-guidance-state {
  grid-column: 1 / -1;
}

.buddy-look-controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 2px 0 18px;
}

.buddy-look-button {
  display: grid;
  justify-items: center;
  gap: 4px;
  min-height: 64px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
  color: var(--text);
  cursor: pointer;
}

.buddy-look-button:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.buddy-look-button > span {
  font: 21px/1 var(--font-sans);
}

.buddy-look-button small {
  color: var(--muted);
  font: 9px var(--font-ui);
}

.buddy-head-form {
  display: grid;
  gap: 13px;
}

.buddy-axis-control {
  display: grid;
  gap: 7px;
}

.buddy-axis-control > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-axis-control input[type="number"] {
  width: 66px;
  min-height: 30px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-muted);
  padding: 4px 7px;
  color: var(--text);
  font: 11px var(--font-ui);
}

.buddy-axis-control input[type="range"] {
  width: 100%;
  accent-color: var(--accent);
}

.buddy-more-controls {
  border-top: 1px solid var(--line);
  padding-top: 9px;
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-more-controls summary,
.buddy-advanced-json summary {
  cursor: pointer;
}

.buddy-observe-action {
  display: flex;
  align-items: end;
  gap: 8px;
  margin-top: 10px;
}

.buddy-observe-action label {
  display: grid;
  flex: 1;
  gap: 6px;
}

.buddy-observe-action label > span {
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-observe-action select {
  width: 100%;
  min-width: 0;
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-muted);
  padding: 7px 9px;
  color: var(--text);
  font: 11px var(--font-ui);
}

.buddy-head-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.buddy-module-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 12px;
}

.buddy-lighting-console {
  margin-bottom: 13px;
}

.buddy-lighting-card {
  display: grid;
  grid-template-columns: minmax(180px, 0.7fr) minmax(180px, 1fr);
  align-items: center;
  gap: 15px 22px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  padding: 15px;
}

.buddy-lighting-heading {
  grid-column: 1 / -1;
}

.buddy-lighting-heading h3 {
  margin: 0;
  color: var(--text);
  font: 13px var(--font-ui);
}

.buddy-lightbar-diagram {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  gap: 11px 9px;
}

.buddy-lightbar-label {
  color: var(--subtle);
  font: 9px var(--font-ui);
  text-align: right;
}

.buddy-lightbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  min-height: 27px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-muted);
  padding: 5px 8px;
}

.buddy-light {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  border: 1px solid rgba(32, 40, 38, 0.12);
  border-radius: 50%;
  box-shadow: 0 0 9px color-mix(in srgb, var(--text) 12%, transparent);
}

.buddy-lighting-current {
  display: grid;
  align-content: center;
  gap: 5px;
  min-height: 54px;
}

.buddy-lighting-current strong {
  color: var(--text);
  font: 12px var(--font-ui);
}

.buddy-lighting-current small {
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-lighting-controls,
.buddy-manual-rgb {
  grid-column: 1 / -1;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}

.buddy-lighting-agent-access {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 12px;
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-lighting-agent-access input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.buddy-emotion-controls {
  display: grid;
  gap: 12px;
}

.buddy-emotion-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.buddy-emotion-button {
  min-height: 30px;
  border: 1px solid var(--line);
  border-radius: 99px;
  background: var(--surface-muted);
  padding: 0 11px;
  color: var(--text);
  cursor: pointer;
  font: 10px var(--font-ui);
}

.buddy-emotion-button[aria-pressed="true"] {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.buddy-emotion-settings {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(100px, 0.65fr) auto;
  align-items: end;
  gap: 12px;
}

.buddy-emotion-settings label {
  display: grid;
  gap: 5px;
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-emotion-settings label span {
  display: flex;
  justify-content: space-between;
}

.buddy-emotion-settings input[type="range"] {
  width: 100%;
  accent-color: var(--accent);
}

.buddy-emotion-settings input[type="number"] {
  width: 100%;
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-muted);
  padding: 6px 8px;
  color: var(--text);
  font: 11px var(--font-ui);
}

.buddy-manual-rgb > summary {
  color: var(--muted);
  cursor: pointer;
  font: 10px var(--font-ui);
}

.buddy-manual-rgb-card {
  margin-top: 12px;
  border: 0;
  background: transparent;
  padding: 0;
}

.buddy-module-card {
  display: grid;
  gap: 16px;
  padding: 14px;
}

.buddy-module-heading {
  align-items: start;
}

.buddy-module-heading > div {
  min-width: 0;
}

.buddy-module-heading h3 {
  font-size: 12px;
}

.buddy-module-heading p {
  margin-bottom: 5px;
}

.buddy-module-heading code {
  color: var(--subtle);
  font: 9px var(--font-ui);
}

.buddy-module-action {
  flex: 0 0 auto;
}

.buddy-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 10px;
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-form-grid label {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 6px;
}

.buddy-form-grid label > span {
  color: var(--muted);
  font: 10px var(--font-ui);
}

.buddy-form-grid input:not([type="range"]):not([type="checkbox"]),
.buddy-form-grid select,
.buddy-form-grid textarea,
.buddy-advanced-json textarea {
  width: 100%;
  min-width: 0;
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-muted);
  padding: 7px 9px;
  color: var(--text);
  font: 11px var(--font-ui);
}

.buddy-form-grid input[type="color"] {
  height: 36px;
  padding: 3px;
}

.buddy-form-grid input[type="range"] {
  width: 100%;
  accent-color: var(--accent);
}

.buddy-form-grid input[type="checkbox"] {
  width: 17px;
  height: 17px;
  accent-color: var(--accent);
}

.buddy-wide-field {
  grid-column: 1 / -1;
}

.buddy-advanced-json {
  color: var(--subtle);
  font: 9px var(--font-ui);
}

.buddy-permission-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.buddy-permission-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 13px;
}

.buddy-permission-copy {
  min-width: 0;
}

.buddy-permission-copy h3 {
  font-size: 11px;
}

.buddy-permission-copy p {
  overflow-wrap: anywhere;
}

.buddy-permission-copy small {
  display: block;
  margin-top: 5px;
  color: var(--subtle);
  font: 9px var(--font-ui);
}

.buddy-permission-toggle {
  display: grid;
  flex: 0 0 auto;
  justify-items: center;
  gap: 5px;
  min-width: 62px;
  color: var(--muted);
  font: 9px var(--font-ui);
}

.buddy-permission-toggle input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}

.buddy-empty-state,
.buddy-capabilities-empty {
  display: grid;
  min-height: 140px;
  place-items: center;
  border: 1px dashed var(--line-strong);
  border-radius: 10px;
  color: var(--muted);
  font: 11px var(--font-ui);
}

.buddy-advanced-json textarea {
  display: block;
  min-height: 74px;
  resize: vertical;
}

.control-button:disabled,
.buddy-look-button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

@media (max-width: 850px) {
  .buddy-console-header {
    align-items: start;
    flex-direction: column;
  }

  .buddy-admin-card {
    width: 100%;
    flex-basis: auto;
  }

  .buddy-overview-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .buddy-command-bar,
  .buddy-module-grid,
  .buddy-permission-list {
    grid-template-columns: 1fr;
  }

  .buddy-command-group {
    align-items: start;
    flex-direction: column;
  }

  .buddy-command-buttons {
    width: 100%;
  }

  .buddy-command-actions {
    width: 100%;
    justify-items: start;
  }

  .buddy-power-off-note {
    text-align: left;
  }

  .buddy-command-buttons .control-button {
    flex: 1;
  }

  .buddy-card-header {
    align-items: start;
    flex-direction: column;
  }

  .buddy-image-frame {
    min-height: 210px;
  }

  .buddy-form-grid {
    grid-template-columns: 1fr;
  }

  .buddy-lighting-card {
    grid-template-columns: 1fr;
  }

  .buddy-lighting-controls,
  .buddy-manual-rgb {
    grid-column: auto;
  }

  .buddy-emotion-settings {
    grid-template-columns: 1fr 1fr;
  }

  .buddy-emotion-settings .control-button {
    grid-column: 1 / -1;
  }

  .buddy-wide-field {
    grid-column: auto;
  }

  .buddy-permission-row {
    align-items: start;
  }
}
</style>
