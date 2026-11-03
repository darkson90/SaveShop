import 'package:dio/dio.dart';

import '../../app/config.dart';
import '../storage/token_storage.dart';

/// Errore API leggibile, dal corpo RFC 7807 (application/problem+json).
class ApiException implements Exception {
  ApiException(this.message, {this.status, this.isNetwork = false});

  final String message;
  final int? status;
  final bool isNetwork;

  factory ApiException.from(Object error) {
    if (error is DioException) {
      final network = error.type == DioExceptionType.connectionError ||
          error.type == DioExceptionType.connectionTimeout ||
          error.type == DioExceptionType.receiveTimeout;
      if (network) return ApiException('Connessione assente', isNetwork: true);
      final data = error.response?.data;
      final detail = data is Map ? data['detail']?.toString() : null;
      return ApiException(detail ?? 'Errore del server', status: error.response?.statusCode);
    }
    return ApiException(error.toString());
  }

  @override
  String toString() => message;
}

/// Client HTTP: aggiunge il JWT e, su 401, rinnova una sola volta l'access token col refresh token.
class ApiClient {
  ApiClient(this._tokens, {void Function()? onSessionExpired}) : _onSessionExpired = onSessionExpired {
    dio = Dio(BaseOptions(
      baseUrl: AppConfig.apiBaseUrl,
      connectTimeout: const Duration(seconds: 5),
      receiveTimeout: const Duration(seconds: 10),
      contentType: 'application/json',
    ));
    dio.interceptors.add(QueuedInterceptorsWrapper(
      onRequest: (options, handler) async {
        final token = await _tokens.accessToken;
        if (token != null) options.headers['Authorization'] = 'Bearer $token';
        handler.next(options);
      },
      onError: (error, handler) async {
        final isAuthCall = error.requestOptions.path.startsWith('/auth/');
        if (error.response?.statusCode != 401 || isAuthCall || error.requestOptions.extra['retried'] == true) {
          return handler.next(error);
        }
        if (!await _refresh()) {
          _onSessionExpired?.call();
          return handler.next(error);
        }
        final retry = error.requestOptions..extra['retried'] = true;
        retry.headers['Authorization'] = 'Bearer ${await _tokens.accessToken}';
        try {
          handler.resolve(await dio.fetch(retry));
        } on DioException catch (e) {
          handler.next(e);
        }
      },
    ));
  }

  final TokenStorage _tokens;
  final void Function()? _onSessionExpired;
  late final Dio dio;

  Future<bool> _refresh() async {
    final refresh = await _tokens.refreshToken;
    if (refresh == null) return false;
    try {
      final res = await Dio(BaseOptions(baseUrl: AppConfig.apiBaseUrl))
          .post<Map<String, dynamic>>('/auth/refresh', data: {'refreshToken': refresh});
      await _tokens.save(accessToken: res.data!['accessToken'] as String, refreshToken: res.data!['refreshToken'] as String);
      return true;
    } catch (_) {
      await _tokens.clear();
      return false;
    }
  }

  Future<Map<String, dynamic>> get(String path, {Map<String, dynamic>? query}) =>
      _call(() => dio.get<Map<String, dynamic>>(path, queryParameters: query));

  Future<Map<String, dynamic>> post(String path, {Object? body, Map<String, String>? headers}) =>
      _call(() => dio.post<Map<String, dynamic>>(path, data: body, options: Options(headers: headers)));

  Future<Map<String, dynamic>> patch(String path, {Object? body}) =>
      _call(() => dio.patch<Map<String, dynamic>>(path, data: body));

  Future<void> delete(String path) => _call(() => dio.delete<Map<String, dynamic>>(path));

  Future<Map<String, dynamic>> _call(Future<Response<Map<String, dynamic>>> Function() fn) async {
    try {
      return (await fn()).data ?? const {};
    } catch (e) {
      throw ApiException.from(e);
    }
  }
}
