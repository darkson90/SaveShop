import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../domain/stats.dart';

final statsPeriodProvider = StateProvider<StatsPeriod>((ref) => StatsPeriod.all);

final statsProvider = FutureProvider.autoDispose<UserStats>((ref) async {
  final period = ref.watch(statsPeriodProvider);
  final res = await ref.watch(apiClientProvider).get('/users/me/stats', query: {'period': period.api});
  return UserStats.fromJson(res);
});
