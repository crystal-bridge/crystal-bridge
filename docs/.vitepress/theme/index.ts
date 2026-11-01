import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import TourSwitch from './TourSwitch.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('TourSwitch', TourSwitch);
  },
} satisfies Theme;
