// DriftHR ESS — root component. Wires the auth provider, then switches between
// the unauthenticated auth stack (Login) and the authenticated tab navigator
// (Dashboard / Payslips / Leave / Clock / Profile). The Payslips tab is itself
// a stack so the list can push the detail screen.

import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { AuthProvider, useAuth } from './src/AuthContext';
import { colors, navTheme } from './src/theme';
import { Loading } from './src/components/ui';

import LoginScreen from './src/screens/LoginScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import PayslipsScreen from './src/screens/PayslipsScreen';
import PayslipDetailScreen from './src/screens/PayslipDetailScreen';
import LeaveScreen from './src/screens/LeaveScreen';
import ClockInOutScreen from './src/screens/ClockInOutScreen';
import ProfileScreen from './src/screens/ProfileScreen';

const AuthStack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();
const PayslipsStack = createNativeStackNavigator();

const screenHeader = {
  headerStyle: { backgroundColor: colors.ink },
  headerTintColor: colors.onPrimary,
  headerTitleStyle: { fontWeight: '700' },
};

// Lightweight text glyph as a tab icon so we don't add an icon-font dependency.
function TabIcon({ glyph, color }) {
  return <Text style={{ fontSize: 18, color }}>{glyph}</Text>;
}

function PayslipsNavigator() {
  return (
    <PayslipsStack.Navigator screenOptions={screenHeader}>
      <PayslipsStack.Screen
        name="PayslipsList"
        component={PayslipsScreen}
        options={{ title: 'Payslips' }}
      />
      <PayslipsStack.Screen
        name="PayslipDetail"
        component={PayslipDetailScreen}
        options={{ title: 'Payslip' }}
      />
    </PayslipsStack.Navigator>
  );
}

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        ...screenHeader,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarIcon: ({ color }) => {
          const glyphs = {
            Dashboard: '⌂',
            Payslips: '₹',
            Leave: '⤢',
            Clock: '◷',
            Profile: '◉',
          };
          return <TabIcon glyph={glyphs[route.name] || '•'} color={color} />;
        },
      })}
    >
      <Tabs.Screen name="Dashboard" component={DashboardScreen} options={{ title: 'Home' }} />
      <Tabs.Screen
        name="Payslips"
        component={PayslipsNavigator}
        options={{ headerShown: false, title: 'Payslips' }}
      />
      <Tabs.Screen name="Leave" component={LeaveScreen} options={{ title: 'Leave' }} />
      <Tabs.Screen name="Clock" component={ClockInOutScreen} options={{ title: 'Clock' }} />
      <Tabs.Screen name="Profile" component={ProfileScreen} options={{ title: 'Profile' }} />
    </Tabs.Navigator>
  );
}

function RootNavigator() {
  const { booting, isAuthed } = useAuth();

  if (booting) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Loading label="Starting DriftHR…" />
      </View>
    );
  }

  if (!isAuthed) {
    return (
      <AuthStack.Navigator screenOptions={{ headerShown: false }}>
        <AuthStack.Screen name="Login" component={LoginScreen} />
      </AuthStack.Navigator>
    );
  }

  return <MainTabs />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <NavigationContainer theme={navTheme}>
          <StatusBar style="light" />
          <RootNavigator />
        </NavigationContainer>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
