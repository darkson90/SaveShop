import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Cache locale della lista e coda delle modifiche fatte offline.
/// L'inserimento non attende mai la rete: ciò che fallisce per connessione finisce qui
/// e viene rinviato con la stessa Idempotency-Key.
class LocalStore {
  static const _listKey = 'cached_list';
  static const _queueKey = 'offline_queue';
  static const _currentListKey = 'current_list_id';

  /// Lista scelta dall'utente (es. una lista condivisa in cui è entrato con un codice).
  Future<String?> readCurrentListId() async => (await _prefs).getString(_currentListKey);

  Future<void> writeCurrentListId(String? id) async {
    final prefs = await _prefs;
    id == null ? await prefs.remove(_currentListKey) : await prefs.setString(_currentListKey, id);
  }

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  Future<Map<String, dynamic>?> readCachedList() async {
    final raw = (await _prefs).getString(_listKey);
    return raw == null ? null : jsonDecode(raw) as Map<String, dynamic>;
  }

  Future<void> writeCachedList(Map<String, dynamic> list) async {
    await (await _prefs).setString(_listKey, jsonEncode(list));
  }

  Future<List<PendingOp>> readQueue() async {
    final raw = (await _prefs).getStringList(_queueKey) ?? const [];
    return raw.map((s) => PendingOp.fromJson(jsonDecode(s) as Map<String, dynamic>)).toList();
  }

  Future<void> enqueue(PendingOp op) async {
    final prefs = await _prefs;
    final queue = prefs.getStringList(_queueKey) ?? <String>[];
    queue.add(jsonEncode(op.toJson()));
    await prefs.setStringList(_queueKey, queue);
  }

  Future<void> writeQueue(List<PendingOp> ops) async {
    await (await _prefs).setStringList(_queueKey, ops.map((o) => jsonEncode(o.toJson())).toList());
  }

  Future<void> clear() async {
    final prefs = await _prefs;
    await prefs.remove(_listKey);
    await prefs.remove(_queueKey);
    await prefs.remove(_currentListKey);
  }
}

/// Modifica fatta senza rete, in attesa di invio: aggiunta, modifica (quantità/spunta) o rimozione.
class PendingOp {
  PendingOp({
    required this.listId,
    required this.idempotencyKey,
    required this.body,
    this.kind = 'add',
    this.itemId,
  });

  /// 'add' | 'update' | 'remove'
  final String kind;
  final String listId;
  final String idempotencyKey;

  /// Per 'add' l'id temporaneo dell'articolo ("tmp-…"), per gli altri l'id sul server.
  final String? itemId;
  final Map<String, dynamic> body;

  factory PendingOp.fromJson(Map<String, dynamic> j) => PendingOp(
        kind: j['kind'] as String? ?? 'add', // le code salvate prima della v1.3 contengono solo aggiunte
        listId: j['listId'] as String,
        idempotencyKey: j['idempotencyKey'] as String,
        itemId: j['itemId'] as String?,
        body: Map<String, dynamic>.from(j['body'] as Map),
      );

  Map<String, dynamic> toJson() =>
      {'kind': kind, 'listId': listId, 'idempotencyKey': idempotencyKey, 'itemId': itemId, 'body': body};

  PendingOp copyWith({Map<String, dynamic>? body}) =>
      PendingOp(kind: kind, listId: listId, idempotencyKey: idempotencyKey, itemId: itemId, body: body ?? this.body);

  /// Riduce la coda prima dell'invio:
  /// - più modifiche dello stesso articolo diventano una sola (vince l'ultimo valore);
  /// - la quantità cambiata su un articolo non ancora inviato entra nella sua aggiunta;
  /// - rimuovere un articolo mai inviato annulla l'aggiunta; rimuoverne uno inviato annulla le sue modifiche.
  static List<PendingOp> compact(List<PendingOp> ops) {
    final out = <PendingOp>[];
    for (final op in ops) {
      final addIdx = out.indexWhere((o) => o.kind == 'add' && o.itemId != null && o.itemId == op.itemId);
      if (op.kind == 'update' && addIdx >= 0) {
        if (op.body.containsKey('quantity')) {
          out[addIdx] = out[addIdx].copyWith(body: {...out[addIdx].body, 'quantity': op.body['quantity']});
        }
        continue;
      }
      if (op.kind == 'remove' && addIdx >= 0) {
        out.removeAt(addIdx);
        continue;
      }
      if (op.kind == 'update') {
        final prev = out.indexWhere((o) => o.kind == 'update' && o.itemId == op.itemId);
        if (prev >= 0) {
          out[prev] = out[prev].copyWith(body: {...out[prev].body, ...op.body});
          continue;
        }
      }
      if (op.kind == 'remove') out.removeWhere((o) => o.kind == 'update' && o.itemId == op.itemId);
      out.add(op);
    }
    return out;
  }
}
