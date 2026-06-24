// Bottom-navigation shell for the authenticated app: Home · Attendance · Leave ·
// Pay · More. "More" opens a sheet with Approvals / Profile / Letters / Tax /
// Logout. Wraps a go_router StatefulShellRoute so each tab keeps its own
// navigation stack.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/providers.dart';
import '../features/home/country_provider.dart';
import '../theme/app_theme.dart';

class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  void _onTap(BuildContext context, WidgetRef ref, int index) {
    // The last destination ("More") is a sheet, not a branch.
    if (index == 4) {
      _openMore(context, ref);
      return;
    }
    navigationShell.goBranch(
      index,
      initialLocation: index == navigationShell.currentIndex,
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: (i) => _onTap(context, ref, i),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.home_outlined),
            selectedIcon: Icon(Icons.home_rounded),
            label: 'Home',
          ),
          NavigationDestination(
            icon: Icon(Icons.access_time_outlined),
            selectedIcon: Icon(Icons.access_time_filled),
            label: 'Attendance',
          ),
          NavigationDestination(
            icon: Icon(Icons.event_available_outlined),
            selectedIcon: Icon(Icons.event_available),
            label: 'Leave',
          ),
          NavigationDestination(
            icon: Icon(Icons.payments_outlined),
            selectedIcon: Icon(Icons.payments),
            label: 'Pay',
          ),
          NavigationDestination(
            icon: Icon(Icons.more_horiz_outlined),
            selectedIcon: Icon(Icons.more_horiz),
            label: 'More',
          ),
        ],
      ),
    );
  }

  void _openMore(BuildContext context, WidgetRef ref) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: BrandColors.card,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) {
        final isIndia = ref.watch(countryContextProvider).valueOrNull?.isIndia ?? false;
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _MoreTile(
                icon: Icons.fact_check_outlined,
                title: 'Approvals',
                subtitle: 'Decisions waiting for you',
                onTap: () => _go(sheetContext, '/approvals'),
              ),
              _MoreTile(
                icon: Icons.person_outline,
                title: 'Profile',
                subtitle: 'Your personal information',
                onTap: () => _go(sheetContext, '/profile'),
              ),
              _MoreTile(
                icon: Icons.description_outlined,
                title: 'Letters',
                subtitle: 'Issued letters & requests',
                onTap: () => _go(sheetContext, '/letters'),
              ),
              if (isIndia)
                _MoreTile(
                  icon: Icons.calculate_outlined,
                  title: 'Tax projection',
                  subtitle: 'India IT computation & TDS',
                  onTap: () => _go(sheetContext, '/tax'),
                ),
              const Divider(height: 24),
              _MoreTile(
                icon: Icons.logout,
                title: 'Log out',
                subtitle: 'Sign out of this device',
                danger: true,
                onTap: () async {
                  Navigator.of(sheetContext).pop();
                  await ref.read(authControllerProvider.notifier).signOut();
                },
              ),
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );
  }

  void _go(BuildContext sheetContext, String location) {
    Navigator.of(sheetContext).pop();
    sheetContext.push(location);
  }
}

class _MoreTile extends StatelessWidget {
  const _MoreTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.danger = false,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final color = danger ? BrandColors.danger : BrandColors.text;
    return ListTile(
      leading: CircleAvatar(
        backgroundColor: danger ? BrandColors.dangerSoft : BrandColors.tealSoft,
        child: Icon(icon, color: danger ? BrandColors.danger : BrandColors.tealDark, size: 20),
      ),
      title: Text(title, style: TextStyle(fontWeight: FontWeight.w700, color: color)),
      subtitle: Text(subtitle, style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
      onTap: onTap,
    );
  }
}
