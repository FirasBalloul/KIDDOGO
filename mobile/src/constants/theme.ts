/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#07090E',
    background: '#F8FAFC',
    backgroundElement: '#EDF2F7',
    backgroundSelected: '#E2E8F0',
    textSecondary: '#64748B',
    brandPrimary: '#0284C7',
    brandAccent: '#0EA5E9',
    brandCard: '#FFFFFF',
    border: 'rgba(0, 0, 0, 0.08)',
    statusGreen: '#10B981',
    statusRed: '#EF4444',
    statusAmber: '#F59E0B',
  },
  dark: {
    text: '#F8FAFC',
    background: '#07090E',
    backgroundElement: '#0E131F',
    backgroundSelected: '#141C2E',
    textSecondary: '#94A3B8',
    brandPrimary: '#0EA5E9',
    brandAccent: '#38BDF8',
    brandCard: '#141C2E',
    border: 'rgba(255, 255, 255, 0.08)',
    statusGreen: '#10B981',
    statusRed: '#EF4444',
    statusAmber: '#F59E0B',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
