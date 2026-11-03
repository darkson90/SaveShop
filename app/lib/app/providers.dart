import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/location/location_service.dart';
import '../core/network/api_client.dart';
import '../core/storage/local_store.dart';
import '../core/storage/token_storage.dart';
import '../features/auth/presentation/auth_controller.dart';

final tokenStorageProvider = Provider((ref) => TokenStorage());
final localStoreProvider = Provider((ref) => LocalStore());
final locationServiceProvider = Provider((ref) => LocationService());

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(
    ref.watch(tokenStorageProvider),
    onSessionExpired: () => ref.read(authControllerProvider.notifier).sessionExpired(),
  );
});
