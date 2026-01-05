<script setup lang="ts">
import type { Breadcrumb } from '../types'
import Breadcrumbs from './Breadcrumbs.vue'

defineProps<{
  breadcrumbs: Breadcrumb[]
  gameName: string
  setting?: string
  titleImageId?: string | null
}>()
</script>

<template>
  <div class="game-header" :class="{ 'has-image': titleImageId }">
    <img
      v-if="titleImageId"
      :src="`/images/${titleImageId}/file?width=1200`"
      :alt="gameName"
      class="header-bg-image"
    />
    <div class="header-content">
      <Breadcrumbs :items="breadcrumbs" />
      <h2>{{ gameName }}</h2>
      <p v-if="setting" class="setting-description">{{ setting }}</p>
    </div>
  </div>
</template>

<style scoped>
.game-header {
  position: relative;
  margin: 0 calc(-1 * var(--space-6)) var(--space-6);
  padding: var(--space-6);
}

.game-header.has-image {
  min-height: 200px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.header-bg-image {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 0;
}

.game-header.has-image::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.5) 50%, rgba(0, 0, 0, 0.3) 100%);
  z-index: 1;
}

.header-content {
  position: relative;
  z-index: 2;
}

.game-header.has-image .header-content :deep(a),
.game-header.has-image .header-content :deep(.breadcrumb-separator) {
  color: rgba(255, 255, 255, 0.8);
}

.game-header.has-image .header-content :deep(a:hover) {
  color: white;
}

.game-header.has-image .header-content :deep(.breadcrumb-current) {
  color: rgba(255, 255, 255, 0.9);
}

.game-header.has-image h2 {
  color: white;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
  margin-bottom: var(--space-2);
}

.game-header.has-image .setting-description {
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
}

.setting-description {
  color: var(--text-muted);
  font-size: var(--text-lg);
  max-width: 700px;
  margin: 0;
}

/* No image - restore normal margins */
.game-header:not(.has-image) {
  margin: 0;
  padding: 0;
  margin-bottom: var(--space-4);
}

.game-header:not(.has-image) h2 {
  margin-bottom: var(--space-2);
}

.game-header:not(.has-image) .setting-description {
  margin-bottom: var(--space-4);
}

@media (max-width: 768px) {
  .game-header {
    margin: 0 calc(-1 * var(--space-4)) var(--space-4);
    padding: var(--space-4);
  }

  .game-header.has-image {
    min-height: 160px;
  }

  .game-header:not(.has-image) {
    margin: 0;
    padding: 0;
  }
}
</style>
