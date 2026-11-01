<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import themedGif from '../../images/demo.gif';
import plainGif from '../../images/demo-plain.gif';

const THEMED = {
  src: themedGif,
  alt: 'A tour of the app: the Airship and its Tavern across three Kingdoms, a Castle, a busy Quest with its Party and meters, an approval leading to Battle won with its pull request, the Belt and Inventory tiles, and Split View across two Kingdoms.',
  caption: 'A tour of the app with its RPG theme, running a scripted world of invented machines.',
};
const PLAIN = {
  src: plainGif,
  alt: 'A tour of the app with plain words and no characters: the home page across three nodes, a node’s page, a busy session with its side panel and meters, an approval, the tools tiles, and split view across two nodes.',
  caption: 'The same tour in the Classic theme, a build option that uses plain words and no characters.',
};
const shown = computed(() => (plain.value ? PLAIN : THEMED));

const plain = ref(false);
// Without JavaScript the buttons would do nothing, so they only appear once it has loaded.
const ready = ref(false);
onMounted(() => (ready.value = true));
</script>

<template>
  <figure class="cb-tour">
    <div v-if="ready" class="cb-tour-switch" role="group" aria-label="Which version of the tour to show">
      <button type="button" :aria-pressed="!plain" @click="plain = false">RPG theme</button>
      <button type="button" :aria-pressed="plain" @click="plain = true">Classic theme</button>
    </div>
    <img :src="shown.src" :alt="shown.alt" />
    <figcaption class="cb-caption" aria-live="polite">{{ shown.caption }}</figcaption>
  </figure>
</template>
