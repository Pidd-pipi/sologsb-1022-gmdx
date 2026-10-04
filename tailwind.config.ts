import type { Config } from 'tailwindcss';
import { heroui } from '@heroui/react';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      fontFamily: {
        serif: ['Noto Serif SC', 'Songti SC', 'STSong', 'serif']
      }
    }
  },
  darkMode: 'class',
  plugins: [heroui({ defaultTheme: 'light' }) as never]
};

export default config;
