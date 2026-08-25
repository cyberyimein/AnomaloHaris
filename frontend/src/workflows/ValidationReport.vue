<template>
  <div class="workflow-report" :class="{ 'workflow-report-error': !report.valid }">
    <strong>{{ report.valid ? "Valid definition" : "Validation needs attention" }}</strong>
    <span v-for="item in [...report.errors, ...report.warnings]" :key="item.path + item.code">
      {{ item.code }} · {{ item.path || "/" }} · {{ item.message }}
    </span>
  </div>
</template>

<script setup>
defineProps({ report: { type: Object, required: true } });
</script>
