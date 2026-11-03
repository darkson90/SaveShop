import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:spesa_smart/features/auth/presentation/auth_controller.dart';
import 'package:spesa_smart/features/auth/presentation/login_screen.dart';
import 'package:spesa_smart/features/profile/domain/stats.dart';
import 'package:spesa_smart/features/profile/presentation/profile_providers.dart';
import 'package:spesa_smart/features/profile/presentation/profile_screen.dart';
import 'package:spesa_smart/features/stores/data/stores_repository.dart';
import 'package:spesa_smart/features/stores/presentation/stores_providers.dart';

class _LoggedOut extends AuthController {
  int logins = 0;

  @override
  Future<bool> build() async => false;

  @override
  Future<void> login(String email, String password) async {
    logins++;
  }
}

const _stats = UserStats(
  totalSavedEur: 184.2,
  avgSavingPct: 12.4,
  totalSpentEur: 900,
  purchases: 37,
  topProducts: [TopProduct('Latte parz. scremato 1 l', 31), TopProduct('Pane in cassetta', 22), TopProduct('Banane', 19)],
  categories: [CategorySlice('Latticini', 96.1, 40), CategorySlice('Dispensa', 80, 33.3), CategorySlice('Bevande', 64, 26.7)],
);

Widget _app(Widget home, List<Override> overrides) =>
    ProviderScope(overrides: overrides, child: MaterialApp(home: home));

void main() {
  setUpAll(() => initializeDateFormatting('it_IT'));

  testWidgets('Login: valida i campi e non invia un modulo incompleto', (tester) async {
    final auth = _LoggedOut();
    await tester.pumpWidget(_app(const LoginScreen(), [authControllerProvider.overrideWith(() => auth)]));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Accedi'));
    await tester.pump();
    expect(find.text('Email non valida'), findsOneWidget);
    expect(find.text('Almeno 8 caratteri'), findsOneWidget);
    expect(auth.logins, 0);

    await tester.enterText(find.byType(TextFormField).at(0), 'stefano@example.com');
    await tester.enterText(find.byType(TextFormField).at(1), 'password-sicura');
    await tester.tap(find.text('Accedi'));
    await tester.pump();
    expect(auth.logins, 1);
  });

  testWidgets('Login: passa alla registrazione', (tester) async {
    await tester.pumpWidget(_app(const LoginScreen(), [authControllerProvider.overrideWith(_LoggedOut.new)]));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Nuovo utente? Registrati'));
    await tester.pump();
    expect(find.text('Crea account'), findsOneWidget);
    expect(find.text('Nome (facoltativo)'), findsOneWidget);
  });

  testWidgets('Profilo: risparmio totale, medio, top 3 e categorie', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.5;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_app(const ProfileScreen(), [
      statsProvider.overrideWith((ref) async => _stats),
      profileProvider.overrideWith((ref) async => const UserProfile(email: 's@example.com', defaultRadiusKm: 10, displayName: 'Stefano')),
    ]));
    await tester.pumpAndSettle();

    expect(find.text('Ciao Stefano'), findsOneWidget);
    expect(find.textContaining('184,20'), findsOneWidget);
    expect(find.text('12,4%'), findsOneWidget);
    expect(find.text('37'), findsOneWidget);
    expect(find.text('Latte parz. scremato 1 l'), findsOneWidget);
    expect(find.text('31 spese'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Latticini'), 200);
    expect(find.text('Latticini'), findsOneWidget);
  });

  testWidgets('Profilo: nessuna spesa registrata', (tester) async {
    await tester.pumpWidget(_app(const ProfileScreen(), [
      statsProvider.overrideWith((ref) async => const UserStats(
            totalSavedEur: 0, avgSavingPct: 0, totalSpentEur: 0, purchases: 0, topProducts: [], categories: [])),
      profileProvider.overrideWith((ref) async => const UserProfile(email: 's@example.com', defaultRadiusKm: 10)),
    ]));
    await tester.pumpAndSettle();
    expect(find.textContaining('Nessuna spesa registrata'), findsOneWidget);
  });
}
