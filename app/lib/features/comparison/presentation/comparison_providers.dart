import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../shopping_list/presentation/list_controller.dart';
import '../../stores/presentation/stores_providers.dart';
import '../domain/models.dart';

final compareModeProvider = StateProvider<CompareMode>((ref) => CompareMode.singleStore);

/// Ricalcolato quando cambiano lista, modalità, posizione/raggio o blacklist.
final comparisonProvider = FutureProvider.autoDispose<Comparison>((ref) async {
  final mode = ref.watch(compareModeProvider);
  final list = await ref.watch(listControllerProvider.future);
  final ctx = await ref.watch(searchContextProvider.future);
  final res = await ref.watch(apiClientProvider).post('/comparisons', body: {
    'listId': list.id,
    'mode': mode.api,
    'lat': ctx.point.lat,
    'lng': ctx.point.lng,
    'radiusKm': ctx.radiusKm,
  });
  return Comparison.fromJson(mode, res);
});
