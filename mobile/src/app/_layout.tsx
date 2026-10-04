import React, { useEffect } from 'react';
import { StyleSheet, Image, Platform } from 'react-native';
import { Tabs } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { enableScreens } from 'react-native-screens';


enableScreens(true);

// Prevent splash auto-hide until ready
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  useEffect(() => {
    // Dismiss splash once navigator attaches
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0E131F',
          borderTopColor: 'rgba(255, 255, 255, 0.08)',
          borderTopWidth: 1,
          height: Platform.OS === 'ios' ? 86 : 64,
          paddingTop: 8,
          paddingBottom: Platform.OS === 'ios' ? 28 : 10,
        },
        tabBarActiveTintColor: '#38BDF8',
        tabBarInactiveTintColor: '#64748B',
        tabBarLabelStyle: {
          fontSize: 10.5,
          fontWeight: '700',
          letterSpacing: 0.3,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Cockpit',
          tabBarIcon: ({ color, size }) => (
            <Image
              source={require('../../assets/images/tabIcons/home.png')}
              style={[styles.icon, { tintColor: color, width: size || 22, height: size || 22 }]}
              resizeMode="contain"
            />
          ),
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Diagnostics',
          tabBarIcon: ({ color, size }) => (
            <Image
              source={require('../../assets/images/tabIcons/explore.png')}
              style={[styles.icon, { tintColor: color, width: size || 22, height: size || 22 }]}
              resizeMode="contain"
            />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  icon: {
    width: 24,
    height: 24,
  },
});