// go_router configuration with an auth-guarded redirect.
//
//   • status == unknown        → /splash (boot validation in flight)
//   • unauthenticated          → /login
//   • authenticated            → the bottom-nav shell (Home/Attendance/Leave/Pay)
//                                + the pushable detail/More routes.
//
// The router refreshes whenever the auth state changes (a 401 anywhere flips the
// controller to unauthenticated → we redirect to /login).

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/providers.dart';
import '../features/approvals/approvals_screen.dart';
import '../features/attendance/attendance_screen.dart';
import '../features/attendance/face_enrollment_screen.dart';
import '../features/auth/login_screen.dart';
import '../features/auth/splash_screen.dart';
import '../features/expenses/expenses_screen.dart';
import '../features/home/home_screen.dart';
import '../features/leave/leave_screen.dart';
import '../features/letters/letters_screen.dart';
import '../features/pay/pay_screen.dart';
import '../features/pay/payslip_detail_screen.dart';
import '../features/pay/compensation_screen.dart';
import '../features/profile/profile_screen.dart';
import '../features/tax/tax_projection_screen.dart';
import 'app_shell.dart';

final _rootKey = GlobalKey<NavigatorState>(debugLabel: 'root');
final _shellKey = GlobalKey<NavigatorState>(debugLabel: 'shell');

/// Bridges a Riverpod [StateNotifier] to a [Listenable] so go_router re-evaluates
/// `redirect` whenever auth state changes.
class _AuthRefresh extends ChangeNotifier {
  _AuthRefresh(Ref ref) {
    ref.listen(authControllerProvider, (_, __) => notifyListeners());
  }
}

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _AuthRefresh(ref);

  return GoRouter(
    navigatorKey: _rootKey,
    initialLocation: '/splash',
    refreshListenable: refresh,
    redirect: (context, state) {
      final status = ref.read(authControllerProvider).status;
      final loc = state.matchedLocation;

      if (status == AuthStatus.unknown) {
        return loc == '/splash' ? null : '/splash';
      }
      final loggingIn = loc == '/login';
      if (status == AuthStatus.unauthenticated) {
        return loggingIn ? null : '/login';
      }
      // Authenticated: bounce away from splash/login into the app.
      if (loc == '/splash' || loc == '/login') return '/home';
      return null;
    },
    routes: [
      GoRoute(path: '/splash', builder: (_, __) => const SplashScreen()),
      GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),

      // Authenticated shell — the four primary tabs.
      StatefulShellRoute.indexedStack(
        parentNavigatorKey: _rootKey,
        builder: (_, __, shell) => AppShell(navigationShell: shell),
        branches: [
          StatefulShellBranch(
            navigatorKey: _shellKey,
            routes: [GoRoute(path: '/home', builder: (_, __) => const HomeScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/attendance', builder: (_, __) => const AttendanceScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/leave', builder: (_, __) => const LeaveScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/pay', builder: (_, __) => const PayScreen())],
          ),
        ],
      ),

      // Pushed detail / "More" routes — full-screen over the shell.
      GoRoute(
        path: '/payslips/:id',
        parentNavigatorKey: _rootKey,
        builder: (_, state) => PayslipDetailScreen(payslipId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/compensation',
        parentNavigatorKey: _rootKey,
        builder: (_, __) => const CompensationScreen(),
      ),
      GoRoute(
        path: '/approvals',
        parentNavigatorKey: _rootKey,
        builder: (_, __) => const ApprovalsScreen(),
      ),
      GoRoute(
        path: '/profile',
        parentNavigatorKey: _rootKey,
        builder: (_, __) => const ProfileScreen(),
      ),
      GoRoute(
        path: '/letters',
        parentNavigatorKey: _rootKey,
        builder: (_, __) => const LettersScreen(),
      ),
      // Feature 45 — reimbursement claims (list + claim detail).
      GoRoute(
        path: '/expenses',
        parentNavigatorKey: _rootKey,
        builder: (_, __) => const ExpensesScreen(),
      ),
      GoRoute(
        path: '/expenses/:id',
        parentNavigatorKey: _rootKey,
        builder: (_, state) =>
            ExpenseClaimDetailScreen(claimId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/tax',
        parentNavigatorKey: _rootKey,
        builder: (_, __) => const TaxProjectionScreen(),
      ),
      // Feature 2 — face enrolment for the FACE attendance-capture mode.
      GoRoute(
        path: '/face-enrollment',
        parentNavigatorKey: _rootKey,
        builder: (_, __) => const FaceEnrollmentScreen(),
      ),
    ],
  );
});
