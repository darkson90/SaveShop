import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/location/location_service.dart';
import '../data/stores_repository.dart';

final storesRepositoryProvider = Provider((ref) => StoresRepository(ref.watch(apiClientProvider)));

/// Il profilo può non esistere per qualche istante dopo la registrazione (creato via evento): riprova.
final profileProvider = FutureProvider<UserProfile>((ref) async {
  final repo = ref.watch(storesRepositoryProvider);
  for (var attempt = 1; ; attempt++) {
    try {
      return await repo.profile();
    } catch (e) {
      if (attempt >= 5) rethrow;
      await Future<void>.delayed(Duration(milliseconds: 300 * attempt));
    }
  }
});

final chainsProvider = FutureProvider((ref) => ref.watch(storesRepositoryProvider).chains());
final exclusionsProvider = FutureProvider.autoDispose((ref) => ref.watch(storesRepositoryProvider).exclusions());
final loyaltyCardsProvider = FutureProvider.autoDispose((ref) => ref.watch(storesRepositoryProvider).cards());

class SearchContext {
  const SearchContext(this.point, this.radiusKm);
  final GeoPoint point;
  final int radiusKm;
}

/// Posizione + raggio usati per confronto e chiusura spesa.
final searchContextProvider = FutureProvider<SearchContext>((ref) async {
  final profile = await ref.watch(profileProvider.future);
  final home = profile.homeLat == null ? null : GeoPoint(profile.homeLat!, profile.homeLng!);
  final point = await ref.watch(locationServiceProvider).current(home: home);
  return SearchContext(point, profile.defaultRadiusKm);
});
