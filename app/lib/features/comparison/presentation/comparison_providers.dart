import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../shopping_list/domain/models.dart';
import '../../shopping_list/presentation/list_controller.dart';
import '../../stores/presentation/stores_providers.dart';
import '../domain/models.dart';

final compareModeProvider = StateProvider<CompareMode>((ref) => CompareMode.singleStore);

/// Ciò che cambia il confronto: lista, articoli abbinati da comprare e loro quantità.
/// Rinominare la lista o aggiungere una voce non riconosciuta non rifà la richiesta.
String _comparisonKey(ShoppingList l) => [
      l.id,
      for (final i in l.items)
        if (i.product != null && !i.checked && !i.pending) '${i.product!.id}:${i.quantity}',
    ].join('|');

/// Ricalcolato quando cambiano gli articoli da confrontare, la modalità o posizione/raggio.
/// Il ramo "Confronto" resta vivo mentre si usa la lista: senza il filtro qui sopra e una breve attesa,
/// ogni articolo aggiunto faceva partire un confronto in background.
final comparisonProvider = FutureProvider.autoDispose<Comparison>((ref) async {
  final mode = ref.watch(compareModeProvider);
  await ref.watch(listControllerProvider.selectAsync(_comparisonKey));
  final ctx = await ref.watch(searchContextProvider.future);

  var disposed = false;
  ref.onDispose(() => disposed = true);
  await Future<void>.delayed(const Duration(milliseconds: 400));
  if (disposed) throw StateError('confronto superato da una modifica più recente');

  final list = await ref.read(listControllerProvider.future);
  final res = await ref.watch(apiClientProvider).post('/comparisons', body: {
    'listId': list.id,
    'mode': mode.api,
    'lat': ctx.point.lat,
    'lng': ctx.point.lng,
    'radiusKm': ctx.radiusKm,
  });
  return Comparison.fromJson(mode, res);
});
