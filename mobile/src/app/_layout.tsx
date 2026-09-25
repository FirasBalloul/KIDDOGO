import React, { useEffect } from 'react';
import { StyleSheet, Image } from 'react-native';
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
          backgroundColor: '#111827',
          borderTopColor: '#1F2937',
        },
        tabBarActiveTintColor: '#3B82F6',
        tabBarInactiveTintColor: '#9CA3AF',
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Image
              source={require('../../assets/images/tabIcons/home.png')}
              style={[styles.icon, { tintColor: color, width: size, height: size }]}
              resizeMode="contain"
            />
          ),
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color, size }) => (
            <Image
              source={require('../../assets/images/tabIcons/explore.png')}
              style={[styles.icon, { tintColor: color, width: size, height: size }]}
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