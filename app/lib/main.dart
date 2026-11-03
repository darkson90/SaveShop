import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'app/providers.dart';
import 'app/router.dart';
import 'app/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('it_IT');
  final container = ProviderContainer();
  final push = container.read(pushServiceProvider);
  // Tocco su una notifica: apre la schermata indicata (es. "Offerte per te") quando l'app è pronta.
  push.onOpenRoute = (route) {
    WidgetsBinding.instance.addPostFrameCallback((_) => container.read(routerProvider).push(route));
    WidgetsBinding.instance.scheduleFrame();
  };
  await push.init();
  runApp(UncontrolledProviderScope(container: container, child: const SpesaSmartApp()));
}

class SpesaSmartApp extends ConsumerWidget {
  const SpesaSmartApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: 'Spesa Smart',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      routerConfig: ref.watch(routerProvider),
      locale: const Locale('it', 'IT'),
      supportedLocales: const [Locale('it', 'IT'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
    );
  }
}
