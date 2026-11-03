import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/io.dart';

import '../../app/config.dart';
import '../storage/token_storage.dart';

/// Segnale ricevuto da GET /lists/{id}/live: cosa è cambiato e chi l'ha cambiato.
class ListSignal {
  const ListSignal(this.op, {this.itemId, this.by});

  final String op;
  final String? itemId;
  final String? by;
}

/// Aggiornamenti in tempo reale delle liste condivise.
class LiveUpdates {
  LiveUpdates(this._tokens);

  final TokenStorage _tokens;

  Stream<ListSignal> watch(String listId) => _LiveConnection(_tokens, listId).stream;
}

/// Connessione WebSocket con riconnessione automatica (backoff fino a 30 s).
/// Le chiusure 4403 (rimosso dalla lista) e 4410 (lista eliminata) terminano lo stream.
class _LiveConnection {
  _LiveConnection(this._tokens, this._listId) {
    _controller = StreamController<ListSignal>(onListen: _connect, onCancel: _stop);
  }

  final TokenStorage _tokens;
  final String _listId;
  late final StreamController<ListSignal> _controller;
  IOWebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _retry;
  int _attempt = 0;
  bool _stopped = false;

  Stream<ListSignal> get stream => _controller.stream;

  Future<void> _connect() async {
    if (_stopped) return;
    final token = await _tokens.accessToken;
    final uri = Uri.parse('${AppConfig.apiBaseUrl.replaceFirst(RegExp('^http'), 'ws')}/lists/$_listId/live');
    final channel = IOWebSocketChannel.connect(uri, headers: {if (token != null) 'Authorization': 'Bearer $token'});
    _channel = channel;
    try {
      await channel.ready;
      _attempt = 0;
    } catch (_) {
      _scheduleRetry();
      return;
    }
    _sub = channel.stream.listen(
      (raw) {
        final msg = jsonDecode(raw as String) as Map<String, dynamic>;
        final op = msg['op'] as String? ?? '';
        if (op == 'hello') return;
        _controller.add(ListSignal(op, itemId: msg['itemId'] as String?, by: msg['by'] as String?));
      },
      onDone: () {
        final code = channel.closeCode;
        if (code == 4403 || code == 4410) {
          _controller.add(ListSignal(code == 4403 ? 'members.removed' : 'list.deleted'));
          _stopped = true;
          _controller.close();
        } else {
          _scheduleRetry();
        }
      },
      onError: (_) => _scheduleRetry(),
      cancelOnError: true,
    );
  }

  void _scheduleRetry() {
    if (_stopped) return;
    _retry?.cancel();
    const delays = [2, 4, 8, 16, 30];
    final seconds = delays[_attempt.clamp(0, delays.length - 1)];
    _attempt++;
    _retry = Timer(Duration(seconds: seconds), _connect);
  }

  Future<void> _stop() async {
    _stopped = true;
    _retry?.cancel();
    await _sub?.cancel();
    await _channel?.sink.close();
  }
}
