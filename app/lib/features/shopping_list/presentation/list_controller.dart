import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../../app/providers.dart';
import '../../../core/network/api_client.dart';
import '../../../core/storage/local_store.dart';
import '../data/list_repository.dart';
import '../domain/models.dart';

final listRepositoryProvider = Provider((ref) => ListRepository(ref.watch(apiClientProvider)));

final listControllerProvider = AsyncNotifierProvider<ListController, ShoppingList>(ListController.new);

final frequentProductsProvider = FutureProvider.autoDispose<List<FrequentProduct>>(
  (ref) => ref.watch(listRepositoryProvider).frequent(),
);

const _uuid = Uuid();

/// Stato della lista corrente. Ogni modifica è ottimistica: la UI si aggiorna subito,
/// il server conferma dopo; senza rete l'aggiunta va in coda (LocalStore).
class ListController extends AsyncNotifier<ShoppingList> {
  ListRepository get _repo => ref.read(listRepositoryProvider);
  LocalStore get _local => ref.read(localStoreProvider);

  @override
  Future<ShoppingList> build() async {
    try {
      await _flushQueue();
      final list = await _repo.currentList();
      await _local.writeCachedList(list.toJson());
      return list;
    } on ApiException catch (e) {
      if (!e.isNetwork) rethrow;
      final cached = await _local.readCachedList();
      if (cached == null) rethrow;
      return ShoppingList.fromJson(cached);
    }
  }

  Future<void> addRaw(String raw) => _add({'raw': raw}, raw);

  Future<void> addProduct(String productId, String name) => _add({'productId': productId}, name);

  Future<void> _add(Map<String, dynamic> body, String label) async {
    final list = state.valueOrNull;
    if (list == null) return;
    final key = _uuid.v4();
    final temp = ListItem(id: 'tmp-$key', raw: label, quantity: 1, unit: 'pz', checked: false, pending: true);
    _set(list.copyWith(items: [...list.items, temp]));
    try {
      final saved = await _repo.addItem(list.id, body, key);
      _replace(temp.id, saved);
      ref.invalidate(frequentProductsProvider);
    } on ApiException catch (e) {
      if (e.isNetwork) {
        await _local.enqueue(PendingOp(listId: list.id, idempotencyKey: key, body: body));
      } else {
        _remove(temp.id);
        rethrow;
      }
    }
  }

  Future<void> setQuantity(ListItem item, double quantity) async {
    if (quantity <= 0) return remove(item);
    _replace(item.id, item.copyWith(quantity: quantity));
    await _sync(item, () => _repo.updateItem(state.value!.id, item.id, {'quantity': quantity}));
  }

  Future<void> toggle(ListItem item) async {
    _replace(item.id, item.copyWith(checked: !item.checked));
    await _sync(item, () => _repo.updateItem(state.value!.id, item.id, {'checked': !item.checked}));
  }

  Future<void> matchProduct(ListItem item, String productId) async {
    final updated = await _repo.updateItem(state.value!.id, item.id, {'productId': productId});
    _replace(item.id, updated);
  }

  Future<void> remove(ListItem item) async {
    _remove(item.id);
    if (item.pending) return;
    try {
      await _repo.removeItem(state.value!.id, item.id);
    } on ApiException {
      ref.invalidateSelf();
    }
  }

  /// Dopo "Ho fatto la spesa qui" il server chiude la lista: ne apriamo una nuova.
  Future<void> startNewList() async {
    final list = await _repo.newList();
    _set(list);
  }

  Future<void> _sync(ListItem original, Future<ListItem> Function() call) async {
    if (original.pending) return;
    try {
      _replace(original.id, await call());
    } on ApiException {
      _replace(original.id, original);
    }
  }

  Future<void> _flushQueue() async {
    final queue = await _local.readQueue();
    if (queue.isEmpty) return;
    final remaining = <PendingOp>[];
    for (final op in queue) {
      try {
        await _repo.addItem(op.listId, op.body, op.idempotencyKey);
      } on ApiException catch (e) {
        if (e.isNetwork) remaining.add(op); // altri errori: l'operazione non è più valida, la scartiamo
      }
    }
    await _local.writeQueue(remaining);
  }

  void _set(ShoppingList list) {
    state = AsyncData(list);
    _local.writeCachedList(list.toJson());
  }

  void _replace(String id, ListItem item) {
    final list = state.valueOrNull;
    if (list == null) return;
    _set(list.copyWith(items: [for (final i in list.items) i.id == id ? item : i]));
  }

  void _remove(String id) {
    final list = state.valueOrNull;
    if (list == null) return;
    _set(list.copyWith(items: list.items.where((i) => i.id != id).toList()));
  }
}
