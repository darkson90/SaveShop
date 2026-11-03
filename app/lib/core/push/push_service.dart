import 'dart:async';
import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../network/api_client.dart';

/// Notifiche push via Firebase Cloud Messaging (Android e, tramite APNs, iOS).
///
/// Se il progetto non ha ancora la configurazione Firebase (google-services.json /
/// GoogleService-Info.plist, vedi `flutterfire configure`) il servizio resta disattivato
/// e l'app continua a funzionare: le offerte restano visibili nella schermata "Offerte per te".
class PushService {
  PushService(this._api);

  final ApiClient _api;
  bool _available = false;
  String? _token;
  StreamSubscription<String>? _refreshSub;

  /// Chiamato quando l'utente tocca una notifica: la rotta da aprire (es. "/offerte").
  void Function(String route)? onOpenRoute;

  bool get isAvailable => _available;

  Future<void> init() async {
    try {
      await Firebase.initializeApp();
      _available = true;
    } catch (e) {
      debugPrint('[push] Firebase non configurato: notifiche push disattivate ($e)');
      return;
    }
    FirebaseMessaging.onMessageOpenedApp.listen(_handleOpen);
    final initial = await FirebaseMessaging.instance.getInitialMessage();
    if (initial != null) _handleOpen(initial);
  }

  void _handleOpen(RemoteMessage message) {
    final route = message.data['route'];
    if (route is String) onOpenRoute?.call(route);
  }

  /// Chiede il permesso al sistema e registra il token del dispositivo per l'utente corrente.
  Future<bool> register() async {
    if (!_available) return false;
    final settings = await FirebaseMessaging.instance.requestPermission();
    if (settings.authorizationStatus == AuthorizationStatus.denied) return false;
    _token = await FirebaseMessaging.instance.getToken();
    if (_token == null) return false;
    await _send(_token!);
    await _refreshSub?.cancel();
    _refreshSub = FirebaseMessaging.instance.onTokenRefresh.listen(_send);
    return true;
  }

  /// Al logout il dispositivo smette di ricevere le offerte di questo account.
  Future<void> unregister() async {
    await _refreshSub?.cancel();
    _refreshSub = null;
    final token = _token ?? (_available ? await FirebaseMessaging.instance.getToken() : null);
    if (token == null) return;
    try {
      await _api.delete('/notifications/devices/${Uri.encodeComponent(token)}');
    } catch (_) {
      // Il server rimuove comunque i token non più validi al primo invio fallito.
    }
    _token = null;
  }

  Future<void> _send(String token) async {
    _token = token;
    await _api.dio.put<void>('/notifications/devices', data: {
      'token': token,
      'platform': Platform.isIOS ? 'ios' : 'android',
    });
  }
}
