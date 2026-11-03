import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/presentation/auth_controller.dart';
import '../features/auth/presentation/login_screen.dart';
import '../features/comparison/domain/models.dart';
import '../features/comparison/presentation/comparison_screen.dart';
import '../features/comparison/presentation/store_detail_screen.dart';
import '../features/offers/offers.dart';
import '../features/profile/presentation/profile_screen.dart';
import '../features/shopping_list/presentation/list_screen.dart';
import '../features/shopping_list/presentation/receipt_screen.dart';
import '../features/shopping_list/presentation/share_screen.dart';
import '../features/stores/presentation/excluded_stores_screen.dart';
import '../features/stores/presentation/settings_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  // Ponte tra lo stato di autenticazione (Riverpod) e il redirect di go_router.
  final auth = ValueNotifier<AsyncValue<bool>>(const AsyncLoading());
  ref.listen(authControllerProvider, (_, next) => auth.value = next, fireImmediately: true);
  ref.onDispose(auth.dispose);

  return GoRouter(
    initialLocation: '/lista',
    refreshListenable: auth,
    redirect: (context, state) {
      if (auth.value.isLoading && !auth.value.hasValue) return null;
      final loggedIn = auth.value.valueOrNull ?? false;
      final atLogin = state.matchedLocation == '/login';
      if (!loggedIn) return atLogin ? null : '/login';
      return atLogin ? '/lista' : null;
    },
    routes: [
      GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => _HomeShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [GoRoute(path: '/lista', builder: (_, __) => const ListScreen())]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/confronto',
              builder: (_, __) => const ComparisonScreen(),
              routes: [
                GoRoute(
                  path: 'negozio',
                  // Dopo un riavvio "extra" non c'è più: si torna al confronto.
                  builder: (_, state) => state.extra is StoreResult
                      ? StoreDetailScreen(result: state.extra! as StoreResult)
                      : const ComparisonScreen(),
                ),
              ],
            ),
          ]),
          StatefulShellBranch(routes: [GoRoute(path: '/profilo', builder: (_, __) => const ProfileScreen())]),
        ],
      ),
      GoRoute(path: '/offerte', builder: (_, __) => const OffersScreen()),
      GoRoute(path: '/condividi', builder: (_, __) => const ShareScreen()),
      GoRoute(
        path: '/scontrino',
        builder: (_, state) => state.extra is StoreResult
            ? ReceiptScreen(store: state.extra! as StoreResult)
            : const ComparisonScreen(),
      ),
      GoRoute(
        path: '/impostazioni',
        builder: (_, __) => const SettingsScreen(),
        routes: [GoRoute(path: 'esclusi', builder: (_, __) => const ExcludedStoresScreen())],
      ),
    ],
  );
});

class _HomeShell extends StatelessWidget {
  const _HomeShell({required this.shell});

  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: (i) => shell.goBranch(i, initialLocation: i == shell.currentIndex),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.checklist_outlined), selectedIcon: Icon(Icons.checklist), label: 'Lista'),
          NavigationDestination(icon: Icon(Icons.savings_outlined), selectedIcon: Icon(Icons.savings), label: 'Confronto'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Profilo'),
        ],
      ),
    );
  }
}
