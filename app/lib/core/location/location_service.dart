import 'package:geolocator/geolocator.dart';

import '../../app/config.dart';

class GeoPoint {
  const GeoPoint(this.lat, this.lng, {this.fromGps = false});

  final double lat;
  final double lng;
  final bool fromGps;
}

/// Posizione per la ricerca dei negozi. Usata solo per la richiesta: il backend non la salva nello storico.
class LocationService {
  Future<GeoPoint> current({GeoPoint? home}) async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return _fallback(home);
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
        return _fallback(home);
      }
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium, timeLimit: Duration(seconds: 8)),
      );
      return GeoPoint(pos.latitude, pos.longitude, fromGps: true);
    } catch (_) {
      return _fallback(home);
    }
  }

  GeoPoint _fallback(GeoPoint? home) => home ?? const GeoPoint(AppConfig.fallbackLat, AppConfig.fallbackLng);
}
