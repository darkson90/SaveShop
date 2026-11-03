import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Cache locale della lista e coda delle modifiche fatte offline.
/// L'inserimento non attende mai la rete: ciò che fallisce per connessione finisce qui
/// e viene rinviato con la stessa Idempotency-Key.
class LocalStore {
  static const _listKey = 'cached_list';
  static const _queueKey = 'offline_queue';

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
  }
}

/// Operazione in attesa di invio (oggi: aggiunta di un articolo).
class PendingOp {
  PendingOp({required this.listId, required this.idempotencyKey, required this.body});

  final String listId;
  final String idempotencyKey;
  final Map<String, dynamic> body;

  factory PendingOp.fromJson(Map<String, dynamic> j) => PendingOp(
        listId: j['listId'] as String,
        idempotencyKey: j['idempotencyKey'] as String,
        body: Map<String, dynamic>.from(j['body'] as Map),
      );

  Map<String, dynamic> toJson() => {'listId': listId, 'idempotencyKey': idempotencyKey, 'body': body};
}
